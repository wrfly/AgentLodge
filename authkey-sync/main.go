// Command auther is the credential authority for the AgentLodge gateway.
//
// It is the only process that holds upstream subscription refresh tokens for
// the Claude (claude.ai) and Codex (ChatGPT) OAuth flows. It refreshes access
// tokens proactively before they expire, persists the rotated tokens encrypted
// at rest, and serves them to the gateway over a Unix domain socket.
//
// The gateway never sees a refresh token; it only ever receives a short-lived
// access token from the endpoints below:
//
//	GET  /health            -> {status, providers:{claude:{ok,expiresAt},...}}
//	GET  /token?provider=X  -> {provider, accessToken, expiresAt, accountId?}
//	POST /token/refresh     -> same as /token but forces a refresh
//	                            body: {"provider":"claude"}
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultSocketPath  = "/run/agentlodge/auther.sock"
	defaultRefreshLead = 60 * time.Second
	defaultHTTPTimeout = 30 * time.Second
	providerClaude     = "claude"
	providerCodex      = "codex"

	// keepOwner is the chown convention for "leave this id alone".
	keepOwner   = -1
	defaultMode = os.FileMode(0o600)
)

type config struct {
	socketPath  string
	refreshLead time.Duration
	httpTimeout time.Duration

	// claude
	claudeCredentialsFile string
	claudeOauthClientID   string
	claudeOauthTokenURL   string
	claudeOauthScopes     []string

	// codex
	codexHome          string
	codexOauthTokenURL string
	codexOauthClientID string

	// persistence
	stateFile string
	authKey   []byte // encryption key for at-rest token persistence

	// optional file drop: publish the current access token as a single-line
	// file, for consumers (e.g. the AgentLodge app-gateway's key-file reader)
	// that read a key from a file rather than from the socket.
	authKeyFile string
	authKeyMode os.FileMode
	authKeyUID  int
	authKeyGID  int
}

// tokenPair is a credential held by the auther. The refresh token is stored
// here (encrypted when persisted) but never leaves the auther process.
type tokenPair struct {
	AccessToken           string   `json:"accessToken"`
	RefreshToken          string   `json:"refreshToken,omitempty"`
	ExpiresAt             int64    `json:"expiresAt,omitempty"`              // unix ms
	RefreshTokenExpiresAt *int64   `json:"refreshTokenExpiresAt,omitempty"`  // unix ms
	Scopes                []string `json:"scopes,omitempty"`
	ClientID              string   `json:"clientId,omitempty"`
	AccountID             string   `json:"accountId,omitempty"` // codex only
}

// provider is a single upstream credential source that can mint an access
// token from a refresh token (or, failing that, load a fresh one from disk).
type provider interface {
	name() string
	// load reads the current credential from its backing store (file/keychain).
	load() (*tokenPair, error)
	// refresh exchanges the refresh token for a new access token.
	refresh(ctx context.Context, pair *tokenPair) (*tokenPair, error)
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	cfg, provs, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	svc, err := newAuther(cfg, provs)
	if err != nil {
		log.Fatalf("init: %v", err)
	}

	if err := svc.run(ctx); err != nil {
		log.Fatal(err)
	}
}

func loadConfig() (config, map[string]provider, error) {
	home := os.Getenv("HOME")

	cfg := config{
		socketPath:  envOr("AUTHER_SOCKET", defaultSocketPath),
		refreshLead: defaultRefreshLead,
		httpTimeout: defaultHTTPTimeout,
		stateFile:   envOr("AUTHER_STATE_FILE", ""),

		claudeCredentialsFile: envOr("CLAUDE_CREDENTIALS_FILE", filepath.Join(home, ".claude", ".credentials.json")),
		claudeOauthClientID:   envOr("CLAUDE_OAUTH_CLIENT_ID", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
		claudeOauthTokenURL:   envOr("CLAUDE_OAUTH_TOKEN_URL", "https://platform.claude.com/v1/oauth/token"),
		claudeOauthScopes:     splitScopes(envOr("CLAUDE_OAUTH_SCOPES", "")),

		codexHome:          envOr("CODEX_HOME", filepath.Join(home, ".codex")),
		codexOauthTokenURL: envOr("OPENAI_OAUTH_TOKEN_URL", "https://auth.openai.com/oauth/token"),
		codexOauthClientID: envOr("OPENAI_OAUTH_CLIENT_ID", "app_EMoamEEZ73f0CkXaXp7hrann"),
	}

	if v := os.Getenv("REFRESH_LEAD_SECONDS"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			return cfg, nil, fmt.Errorf("REFRESH_LEAD_SECONDS %q: want a non-negative integer", v)
		}
		cfg.refreshLead = time.Duration(n) * time.Second
	}
	if v := os.Getenv("HTTP_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return cfg, nil, fmt.Errorf("HTTP_TIMEOUT %q: want a positive duration", v)
		}
		cfg.httpTimeout = d
	}

	// Optional file drop for key-file consumers.
	cfg.authKeyFile = envOr("AUTH_KEY_FILE", "")
	cfg.authKeyMode = defaultMode
	if cfg.authKeyFile != "" {
		cfg.authKeyUID, cfg.authKeyGID = keepOwner, keepOwner
		if v := os.Getenv("AUTH_KEY_MODE"); v != "" {
			m, err := strconv.ParseUint(v, 8, 32)
			if err != nil {
				return cfg, nil, fmt.Errorf("AUTH_KEY_MODE %q: want an octal mode like 0640", v)
			}
			cfg.authKeyMode = os.FileMode(m)
		}
		if v := os.Getenv("AUTH_KEY_OWNER"); v != "" {
			uid, gid, err := parseOwner(v)
			if err != nil {
				return cfg, nil, fmt.Errorf("AUTH_KEY_OWNER %q: %w", v, err)
			}
			cfg.authKeyUID, cfg.authKeyGID = uid, gid
		}
	}

	// The encryption key is only needed when persisting state. When no state
	// file is configured, skip key derivation entirely (the auther still works
	// fine loading credentials from disk each start).
	if cfg.stateFile != "" {
		key, err := loadAuthKey()
		if err != nil {
			return cfg, nil, err
		}
		cfg.authKey = key
	}

	provs := map[string]provider{
		providerClaude: &claudeProvider{
			credentialsFile: cfg.claudeCredentialsFile,
			clientID:        cfg.claudeOauthClientID,
			tokenURL:        cfg.claudeOauthTokenURL,
			scopes:          cfg.claudeOauthScopes,
			timeout:         cfg.httpTimeout,
		},
		providerCodex: &codexProvider{
			authFile: filepath.Join(cfg.codexHome, "auth.json"),
			clientID: cfg.codexOauthClientID,
			tokenURL: cfg.codexOauthTokenURL,
			timeout:  cfg.httpTimeout,
		},
	}
	return cfg, provs, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func splitScopes(s string) []string {
	var out []string
	for _, part := range strings.Fields(s) {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// auther manages cached/refreshed tokens and serves them over a UDS.
type auther struct {
	cfg    config
	provs  map[string]provider
	cached map[string]*tokenPair
	mu     chan struct{} // mutex: buffered channel of size 1
}

func newAuther(cfg config, provs map[string]provider) (*auther, error) {
	a := &auther{
		cfg:    cfg,
		provs:  provs,
		cached: make(map[string]*tokenPair),
		mu:     make(chan struct{}, 1),
	}
	if cfg.stateFile != "" {
		if err := a.restore(); err != nil {
			log.Printf("auther: restore ignored: %v", err)
		}
	}
	// Prime from disk for anything not already restored.
	for name, p := range provs {
		if a.cached[name] != nil {
			continue
		}
		if pair, err := p.load(); err == nil {
			a.cached[name] = pair
		} else {
			log.Printf("auther: %s: initial load failed: %v", name, err)
		}
	}
	return a, nil
}

func (a *auther) lock()   { a.mu <- struct{}{} }
func (a *auther) unlock() { <-a.mu }

// token returns a valid access token for provider p, refreshing lazily if the
// cached one has expired. force forces a refresh regardless of expiry.
func (a *auther) token(ctx context.Context, p provider, force bool) (*tokenPair, error) {
	a.lock()
	defer a.unlock()

	pair := a.cached[p.name()]
	if pair == nil {
		loaded, err := p.load()
		if err != nil {
			return nil, err
		}
		pair = loaded
		a.cached[p.name()] = pair
		a.publish()
	}

	if force || expired(pair, a.cfg.refreshLead) {
		refreshed, err := p.refresh(ctx, pair)
		if err != nil {
			// Transient failure: if the current token is still valid, keep it.
			if pair.AccessToken != "" && !expired(pair, 0) {
				return pair, nil
			}
			return nil, err
		}
		a.cached[p.name()] = refreshed
		a.persist()
		a.publish()
		return refreshed, nil
	}
	return pair, nil
}

func expired(pair *tokenPair, lead time.Duration) bool {
	if pair == nil || pair.ExpiresAt == 0 {
		return false
	}
	return time.Now().Add(lead).After(time.UnixMilli(pair.ExpiresAt))
}

func (a *auther) run(ctx context.Context) error {
	ln, err := listen(a.cfg.socketPath)
	if err != nil {
		return err
	}
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.handleHealth)
	mux.HandleFunc("/token", a.handleToken)
	mux.HandleFunc("/token/refresh", a.handleRefresh)

	srv := &http.Server{Handler: mux}

	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.preRefresh(ctx)
			}
		}
	}()

	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()

	log.Printf("auther listening on %s", a.cfg.socketPath)
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}

// preRefresh refreshes any provider whose token is within the refresh lead so
// gateway /token requests almost always hit the cache with no upstream call.
func (a *auther) preRefresh(ctx context.Context) {
	for name, p := range a.provs {
		a.lock()
		pair := a.cached[name]
		a.unlock()
		if pair == nil || !expired(pair, a.cfg.refreshLead) {
			continue
		}
		if _, err := a.token(ctx, p, true); err != nil {
			log.Printf("auther: pre-refresh %s: %v", name, err)
		}
	}
}

func (a *auther) providerByName(name string) (provider, bool) {
	p, ok := a.provs[name]
	return p, ok
}

func (a *auther) handleHealth(w http.ResponseWriter, _ *http.Request) {
	providers := map[string]any{}
	ready := false
	for name := range a.provs {
		a.lock()
		pair := a.cached[name]
		a.unlock()
		if pair != nil && pair.AccessToken != "" {
			providers[name] = map[string]any{"ok": true, "expiresAt": pair.ExpiresAt}
			ready = true
		} else {
			providers[name] = map[string]any{"ok": false}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "ready": ready, "providers": providers})
}

func (a *auther) handleToken(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("provider")
	if name == "" {
		name = providerClaude
	}
	p, ok := a.providerByName(name)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown provider: " + name})
		return
	}
	pair, err := a.token(r.Context(), p, false)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, publicToken(pair, name))
}

func (a *auther) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	name := req.Provider
	if name == "" {
		name = providerClaude
	}
	p, ok := a.providerByName(name)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown provider: " + name})
		return
	}
	pair, err := a.token(r.Context(), p, true)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, publicToken(pair, name))
}

// publicToken is the shape handed to the gateway — an access token and its
// expiry, never the refresh token.
func publicToken(pair *tokenPair, name string) map[string]any {
	out := map[string]any{
		"provider":    name,
		"accessToken": pair.AccessToken,
	}
	if pair.ExpiresAt != 0 {
		out["expiresAt"] = pair.ExpiresAt
	}
	if pair.AccountID != "" {
		out["accountId"] = pair.AccountID
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// listen binds a mode-0600 unix socket, removing any stale socket first.
func listen(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir socket dir: %w", err)
	}
	if info, err := os.Stat(path); err == nil && info.Mode()&os.ModeSocket != 0 {
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("remove stale socket: %w", err)
		}
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("chmod socket: %w", err)
	}
	return ln, nil
}
