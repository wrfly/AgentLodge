// Command credential-manager is the credential authority for AgentLodge.
//
// It is the only process that holds upstream credentials: pasted API keys, and
// the refresh tokens behind Claude (claude.ai) and Codex (ChatGPT)
// subscriptions. It mints access tokens before they expire, keeps what it holds
// encrypted at rest, and hands out **only** short-lived values over a Unix
// domain socket.
//
// The console configures a provider by naming a credential id. Neither the
// browser nor the application database ever holds the value:
//
//	GET    /health                  -> {status, ready, credentials:{id:{...}}}
//	GET    /credentials             -> [{id, kind, source, hint, expiresAt, ...}]
//	POST   /credentials             -> store a pasted key, or a path to one
//	                                   {"id","kind":"api-key","label","apiKey"}
//	                                   {"id","kind":"key-file","label","path"}
//	GET    /files                   -> key files in the allowlisted directories
//	                                   ?path=… also reports on that one
//	POST   /credentials/import      -> copy a mounted host credentials file in
//	                                   {"id","kind":"claude"|"codex","label"}
//	DELETE /credentials?id=X        -> forget one
//	POST   /login/start             -> begin a subscription sign-in
//	                                   {"kind":"claude","id","label"}
//	                                   -> {loginId, authorizeUrl, expiresAt}
//	POST   /login/finish            -> complete it with the pasted code
//	                                   {"loginId","code"}
//	GET    /token?credential=X      -> {credential, kind, accessToken, expiresAt}
//	POST   /token/refresh           -> the same, forcing a mint first
//	                                   {"credential":"X"}
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
	"sync"
	"syscall"
	"time"
)

const (
	defaultSocketPath  = "/run/agentlodge/credential-manager.sock"
	defaultRefreshLead = 60 * time.Second
	defaultHTTPTimeout = 30 * time.Second
	providerClaude     = "claude"
	providerCodex      = "codex"

	// keepOwner is the chown convention for "leave this id alone".
	keepOwner = -1
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
	authKey   []byte // encryption key for at-rest persistence

	// Who may open the socket. The manager runs as root (it reads the host's
	// 0600 credentials file), while app and gateway run as an unprivileged uid,
	// so the socket is handed to them: 0600 owned by that uid, and nothing else
	// on the host can dial it.
	socketUID int
	socketGID int

	// Endpoints for signing a subscription in from the console, by kind. A kind
	// missing here can still be imported from a credentials file.
	logins map[string]oauthLogin
}

// tokenPair is a credential held by the credential-manager. The refresh token is stored
// here (encrypted when persisted) but never leaves the credential-manager process.
type tokenPair struct {
	AccessToken           string   `json:"accessToken"`
	RefreshToken          string   `json:"refreshToken,omitempty"`
	ExpiresAt             int64    `json:"expiresAt,omitempty"`             // unix ms
	RefreshTokenExpiresAt *int64   `json:"refreshTokenExpiresAt,omitempty"` // unix ms
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

	svc, err := newManager(cfg, provs)
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
		socketPath:  envOr("CREDENTIAL_MANAGER_SOCKET", defaultSocketPath),
		refreshLead: defaultRefreshLead,
		httpTimeout: defaultHTTPTimeout,
		stateFile:   envOr("CREDENTIAL_MANAGER_STATE_FILE", ""),

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

	// Who ends up owning the socket. app and gateway run as an unprivileged uid
	// and have to be able to dial it; this manager runs as root because the
	// host credentials file it reads is 0600.
	cfg.socketUID, cfg.socketGID = keepOwner, keepOwner
	if v := os.Getenv("CREDENTIAL_MANAGER_SOCKET_OWNER"); v != "" {
		uid, gid, err := parseOwner(v)
		if err != nil {
			return cfg, nil, fmt.Errorf("CREDENTIAL_MANAGER_SOCKET_OWNER %q: %w", v, err)
		}
		cfg.socketUID, cfg.socketGID = uid, gid
	}

	// Signing in from the console. Claude is configured out of the box; Codex
	// is import-only unless its authorize endpoint is named here, because its
	// CLI completes the flow against a redirect back to its own machine and
	// there is nothing to paste.
	cfg.logins = map[string]oauthLogin{
		kindClaude: {
			// The subscription flow authorises on claude.com and comes back on
			// platform.claude.com — the pair `claude login` itself uses. Neither is
			// guessable from the other, and getting either wrong ends at the same
			// "Authorization failed - Invalid request format" page.
			authorizeURL: envOr("CLAUDE_OAUTH_AUTHORIZE_URL", "https://claude.com/cai/oauth/authorize"),
			redirectURI:  envOr("CLAUDE_OAUTH_REDIRECT_URI", "https://platform.claude.com/oauth/code/callback"),
			clientID:     cfg.claudeOauthClientID,
			tokenURL:     cfg.claudeOauthTokenURL,
			scopes: loginScopes(cfg.claudeOauthScopes,
				"org:create_api_key", "user:profile", "user:inference",
				"user:sessions:claude_code", "user:mcp_servers", "user:file_upload"),
		},
	}
	if v := os.Getenv("OPENAI_OAUTH_AUTHORIZE_URL"); v != "" {
		cfg.logins[kindCodex] = oauthLogin{
			authorizeURL: v,
			redirectURI:  envOr("OPENAI_OAUTH_REDIRECT_URI", "http://localhost:1455/auth/callback"),
			clientID:     cfg.codexOauthClientID,
			tokenURL:     cfg.codexOauthTokenURL,
			scopes:       splitScopes(envOr("OPENAI_OAUTH_SCOPES", "openid profile email offline_access")),
		}
	}

	// The encryption key is only needed when persisting state. When no state
	// file is configured, skip key derivation entirely (the credential-manager still works
	// fine loading credentials from disk each start).
	if cfg.stateFile != "" {
		key, err := loadStateKey()
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

// loginScopes takes the configured scopes when there are any, and otherwise the
// ones the flow needs to come back with a usable subscription token.
func loginScopes(configured []string, fallback ...string) []string {
	if len(configured) > 0 {
		return configured
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

// manager holds the credentials and serves them over a UDS.
type manager struct {
	cfg   config
	provs map[string]provider
	// creds is the store: id -> credential. It is what persist() writes.
	creds map[string]*credential
	// logins are the sign-ins that have been started and not yet completed.
	// In memory only: an interrupted sign-in is started again, not resumed.
	logins map[string]*pendingLogin
	mu     chan struct{} // mutex: buffered channel of size 1

	// refreshMu serialises token refresh per credential id, so that concurrent
	// /token (and the preRefresh ticker) calls for the same subscription do not
	// issue overlapping refreshes of the same refresh token. The token endpoint
	// rotates the refresh token, so an overlapping pair can persist a stale one
	// and permanently break the credential ("invalid_grant"). One lock per id,
	// created lazily; holding ever-seen ids in a map is bounded by the number of
	// credentials, which is small and stable.
	refreshMu    sync.Mutex
	refreshLocks map[string]*sync.Mutex

	// storeErr records the most recent persist failure, so /health can report
	// that the on-disk store is degraded (changes live only in memory until the
	// next successful persist). Written under a.mu by persist(); nil means the
	// last write reached disk (or persistence is off by configuration).
	storeErr error
}

func newManager(cfg config, provs map[string]provider) (*manager, error) {
	a := &manager{
		cfg:          cfg,
		provs:        provs,
		creds:        make(map[string]*credential),
		logins:       make(map[string]*pendingLogin),
		mu:           make(chan struct{}, 1),
		refreshLocks: make(map[string]*sync.Mutex),
	}
	if cfg.stateFile != "" {
		if err := a.restore(); err != nil {
			logf("restore ignored: %v", err)
		}
	}
	a.seedFromHost()
	return a, nil
}

func (a *manager) lock()   { a.mu <- struct{}{} }
func (a *manager) unlock() { <-a.mu }

// refreshLock returns the per-credential lock for one id, creating it on first
// use. Callers must hold a.refreshMu while creating it to stay race-free.
func (a *manager) refreshLock(id string) *sync.Mutex {
	a.refreshMu.Lock()
	defer a.refreshMu.Unlock()
	if l, ok := a.refreshLocks[id]; ok {
		return l
	}
	l := &sync.Mutex{}
	a.refreshLocks[id] = l
	return l
}

// releaseRefreshLock forgets the per-credential lock for an id, so the map does
// not grow for every credential that ever existed. Safe against a resolve that
// is mid-refresh: that goroutine already holds a reference to the *sync.Mutex
// and releases it normally; only future callers would have created a new one.
func (a *manager) releaseRefreshLock(id string) {
	a.refreshMu.Lock()
	delete(a.refreshLocks, id)
	a.refreshMu.Unlock()
}

// storeBlock is what a response says about the store's durability, in the one
// shape every endpoint uses.
//
// It travels as its own fact rather than as the failure of whatever operation
// happened to run into it. A credential stored while the disk is full is live,
// listed and serving tokens — the operation did what was asked. What is not
// true any more is that a restart comes back to it, and that is a property of
// the store, not of the request that noticed.
func (a *manager) storeBlock() map[string]any {
	a.lock()
	err := a.storeErr
	a.unlock()
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true}
}

// logf is every log line this service writes, so they all carry the same prefix.
func logf(format string, args ...any) {
	log.Printf("credential-manager: "+format, args...)
}

func expired(pair *tokenPair, lead time.Duration) bool {
	if pair == nil || pair.ExpiresAt == 0 {
		return false
	}
	return time.Now().Add(lead).After(time.UnixMilli(pair.ExpiresAt))
}

func (a *manager) run(ctx context.Context) error {
	ln, err := listen(a.cfg.socketPath, a.cfg.socketUID, a.cfg.socketGID)
	if err != nil {
		return err
	}
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.handleHealth)
	mux.HandleFunc("/credentials", a.handleCredentials)
	mux.HandleFunc("/credentials/import", a.handleImport)
	mux.HandleFunc("/files", a.handleFiles)
	mux.HandleFunc("/login/start", a.handleLoginStart)
	mux.HandleFunc("/login/finish", a.handleLoginFinish)
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

	logf("listening on %s", a.cfg.socketPath)
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}

// preRefresh mints ahead of expiry, so a /token call almost always answers from
// what is already held and the request waiting on it never pays for the round
// trip to the token endpoint.
func (a *manager) preRefresh(ctx context.Context) {
	a.lock()
	due := make([]string, 0, len(a.creds))
	for id, c := range a.creds {
		if c.Kind == kindAPIKey || c.Kind == kindKeyFile || c.Token == nil {
			continue
		}
		if expired(c.Token, a.cfg.refreshLead) {
			due = append(due, id)
		}
	}
	a.unlock()

	for _, id := range due {
		if _, err := a.resolve(ctx, id, true); err != nil {
			logf("pre-refresh %s: %v", id, err)
		}
	}
}

func (a *manager) handleHealth(w http.ResponseWriter, _ *http.Request) {
	creds := map[string]any{}
	ready := false
	for _, sum := range a.list() {
		id, _ := sum["id"].(string)
		creds[id] = sum
		if ok, _ := sum["ready"].(bool); ok {
			ready = true
		}
	}
	// "ready" says whether a credential is usable now, which a failed persist
	// does not change. The store's durability is a separate line.
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok", "ready": ready, "credentials": creds, "store": a.storeBlock(),
	})
}

// handleCredentials lists, stores and forgets credentials.
//
// Storing takes a pasted key and nothing else. A subscription cannot be typed
// in: its refresh token arrives either by signing in (/login/*) or by importing
// a credentials file the host wrote (/credentials/import), and both of those
// keep the value out of the browser that asked for it.
func (a *manager) handleCredentials(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"credentials": a.list(), "store": a.storeBlock()})

	case http.MethodPost:
		var req struct {
			ID     string `json:"id"`
			Kind   string `json:"kind"`
			Label  string `json:"label"`
			APIKey string `json:"apiKey"`
			Path   string `json:"path"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "malformed request: " + err.Error()})
			return
		}
		if err := validID(req.ID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		if req.Kind == "" {
			if strings.TrimSpace(req.Path) != "" {
				req.Kind = kindKeyFile
			} else {
				req.Kind = kindAPIKey
			}
		}

		// A file is a path, checked before it is stored: a path that is wrong on any
		// machine — not absolute, not in the allowlist — should be refused here rather
		// than surface later as an upstream 401.
		if req.Kind == kindKeyFile {
			path := strings.TrimSpace(req.Path)
			if _, _, err := readKeyFile(path); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			c := &credential{ID: req.ID, Kind: kindKeyFile, Label: req.Label, Source: sourceFile, Path: path}
			if err := a.putDurable(c); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
			logf("stored key file %s -> %s", c.ID, path)
			writeJSON(w, http.StatusOK, map[string]any{"credential": c.summary(), "store": a.storeBlock()})
			return
		}

		if req.Kind != kindAPIKey {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "only an " + kindAPIKey + " or a " + kindKeyFile + " can be stored directly; sign in or import a credentials file for " + req.Kind,
			})
			return
		}
		key := strings.TrimSpace(req.APIKey)
		if key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no key given"})
			return
		}
		if strings.ContainsAny(key, "\r\n") {
			// A whole credentials file pasted into the key box, most likely.
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "a key cannot contain a line break"})
			return
		}
		c := &credential{ID: req.ID, Kind: kindAPIKey, Label: req.Label, Source: sourceTyped, APIKey: key}
		if err := a.putDurable(c); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		logf("stored api key %s", c.ID)
		writeJSON(w, http.StatusOK, map[string]any{"credential": c.summary(), "store": a.storeBlock()})

	case http.MethodDelete:
		id := r.URL.Query().Get("id")
		if !a.remove(id) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "no credential " + id})
			return
		}
		logf("removed %s", id)
		writeJSON(w, http.StatusOK, map[string]any{"removed": id, "store": a.storeBlock()})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "use GET, POST or DELETE"})
	}
}

// handleFiles lists what is in the allowlisted directories, so a key file can be
// picked rather than typed. With ?path= it also reports on that one path, for
// feedback while it is being typed.
//
// Status only — size, time, fingerprint, a masked hint. Never the contents: the
// whole reason a key lives in a file is that it does not have to travel.
func (a *manager) handleFiles(w http.ResponseWriter, r *http.Request) {
	roots, files := listKeyFiles()
	out := map[string]any{"roots": roots, "files": files}
	if p := r.URL.Query().Get("path"); p != "" {
		if _, info, err := readKeyFile(p); err != nil {
			out["checked"] = map[string]any{"path": p, "usable": false, "error": err.Error()}
		} else {
			out["checked"] = map[string]any{
				"path": info.Path, "size": info.Size, "mtime": info.MTime,
				"fingerprint": info.Fingerprint, "hint": info.Hint, "usable": true,
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleImport copies a credentials file this container has mounted into the
// store — the host's `claude login` / `codex login` output.
func (a *manager) handleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "use POST"})
		return
	}
	var req struct {
		ID    string `json:"id"`
		Kind  string `json:"kind"`
		Label string `json:"label"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "malformed request: " + err.Error()})
		return
	}
	if req.Kind == "" {
		req.Kind = kindClaude
	}
	if req.ID == "" {
		req.ID = req.Kind
	}
	if err := validID(req.ID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if err := validKind(req.Kind); err != nil || req.Kind == kindAPIKey {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "nothing to import for kind " + req.Kind})
		return
	}
	c, err := a.importFromHost(req.Kind, req.ID, req.Label)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	logf("imported %s from the mounted credentials file", c.ID)
	writeJSON(w, http.StatusOK, map[string]any{"credential": c.summary(), "store": a.storeBlock()})
}

// handleLoginStart hands back the URL to authorise at. Nothing is stored until
// the code comes back to /login/finish.
func (a *manager) handleLoginStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "use POST"})
		return
	}
	var req struct {
		Kind  string `json:"kind"`
		ID    string `json:"id"`
		Label string `json:"label"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "malformed request: " + err.Error()})
		return
	}
	if req.Kind == "" {
		req.Kind = kindClaude
	}
	if req.ID == "" {
		req.ID = req.Kind
	}
	pending, authorizeURL, err := a.startLogin(req.Kind, req.ID, req.Label)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"loginId":      pending.ID,
		"authorizeUrl": authorizeURL,
		"credentialId": pending.CredID,
		"kind":         pending.Kind,
		"expiresAt":    pending.started.Add(loginTTL).UnixMilli(),
	})
}

// handleLoginFinish takes the code from the redirect page and, if it checks
// out, stores the subscription.
func (a *manager) handleLoginFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "use POST"})
		return
	}
	var req struct {
		LoginID string `json:"loginId"`
		Code    string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "malformed request: " + err.Error()})
		return
	}
	c, err := a.finishLogin(r.Context(), req.LoginID, req.Code)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credential": c.summary(), "store": a.storeBlock()})
}

// credentialParam accepts either name for the same thing: `credential` is what
// this service calls it, `provider` is what a caller holding one credential per
// upstream calls it. Defaulting to claude keeps the single-subscription
// deployment free of configuration.
func credentialParam(explicit ...string) string {
	for _, v := range explicit {
		if v != "" {
			return v
		}
	}
	return providerClaude
}

func (a *manager) handleToken(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := credentialParam(q.Get("credential"), q.Get("provider"))
	c, err := a.resolve(r.Context(), id, false)
	if err != nil {
		writeJSON(w, tokenErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, publicToken(c))
}

func (a *manager) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Credential string `json:"credential"`
		Provider   string `json:"provider"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req)
	id := credentialParam(req.Credential, req.Provider)
	c, err := a.resolve(r.Context(), id, true)
	if err != nil {
		writeJSON(w, tokenErrorStatus(err), map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, publicToken(c))
}

// tokenErrorStatus says whether the caller asked for something that is not
// there, or something that is there and cannot be served at the moment. The
// gateway logs the two differently: one is configuration, the other is weather.
func tokenErrorStatus(err error) int {
	if errors.Is(err, errNoCredential) {
		return http.StatusNotFound
	}
	return http.StatusServiceUnavailable
}

// publicToken is the shape a consumer gets: the value to send upstream and when
// it stops working. Never the refresh token — that is the whole point of the
// socket being the only way in.
func publicToken(c *credential) map[string]any {
	// The error case is already handled by resolve(); this cannot fail again for a
	// credential it just returned, and an empty value would be refused upstream anyway.
	value, _ := c.secret()
	out := map[string]any{
		// `provider` is the name the field had when a consumer held one
		// credential per upstream; both are sent so neither side has to change
		// in step with the other.
		"credential":  c.ID,
		"provider":    c.ID,
		"kind":        c.Kind,
		"accessToken": value,
	}
	if c.Token != nil {
		if c.Token.ExpiresAt != 0 {
			out["expiresAt"] = c.Token.ExpiresAt
		}
		if c.Token.AccountID != "" {
			out["accountId"] = c.Token.AccountID
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// listen binds a mode-0600 unix socket, removing any stale socket first, and
// hands it to the uid that has to dial it: 0600 means the socket itself is the
// access control, so who owns it is who may ask for a token.
func listen(path string, uid, gid int) (net.Listener, error) {
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
	// Nothing to hand over when the target is root or unset: this process runs
	// as root, so the socket is already owned by it. Skipping keeps a
	// zero-valued config from turning into a chown that fails.
	if uid > 0 || gid > 0 {
		if err := os.Chown(path, uid, gid); err != nil {
			_ = ln.Close()
			return nil, fmt.Errorf("chown socket to %d:%d: %w", uid, gid, err)
		}
	}
	return ln, nil
}
