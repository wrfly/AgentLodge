package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// provider: parse + refresh
// ---------------------------------------------------------------------------

func writeClaudeCreds(t *testing.T, dir string, content string) string {
	t.Helper()
	p := filepath.Join(dir, ".credentials.json")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatalf("write creds: %v", err)
	}
	return p
}

func TestClaudeProviderParse(t *testing.T) {
	dir := t.TempDir()
	p := writeClaudeCreds(t, dir, `{
		"claudeAiOauth": {
			"accessToken": "AT",
			"refreshToken": "RT",
			"expiresAt": 1750000000000,
			"refreshTokenExpiresAt": 1760000000000,
			"scopes": ["user:profile", "user:inference"],
			"clientId": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
		}
	}`)

	c := &claudeProvider{credentialsFile: p}
	pair, err := c.load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if pair.AccessToken != "AT" || pair.RefreshToken != "RT" {
		t.Fatalf("got %+v", pair)
	}
	if pair.ExpiresAt != 1750000000000 {
		t.Fatalf("expiresAt got %d", pair.ExpiresAt)
	}
	if len(pair.Scopes) != 2 || pair.Scopes[0] != "user:profile" {
		t.Fatalf("scopes got %v", pair.Scopes)
	}
}

func TestClaudeProviderRefresh(t *testing.T) {
	dir := t.TempDir()
	p := writeClaudeCreds(t, dir, `{"claudeAiOauth":{"accessToken":"OLD","refreshToken":"RT","expiresAt":1,"scopes":["user:profile"],"clientId":"CID"}}`)

	var gotBody map[string]string
	var gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"access_token":             "NEW",
			"refresh_token":            "RT2",
			"expires_in":               3600,
			"refresh_token_expires_in": 86400,
			"scope":                    "user:profile user:inference",
		})
	}))
	defer srv.Close()

	c := &claudeProvider{credentialsFile: p, tokenURL: srv.URL, timeout: 5 * time.Second}
	pair, err := c.load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	next, err := c.refresh(context.Background(), pair)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if next.AccessToken != "NEW" || next.RefreshToken != "RT2" {
		t.Fatalf("got %+v", next)
	}
	if next.ExpiresAt <= time.Now().UnixMilli() {
		t.Fatalf("expiresAt not advanced: %d", next.ExpiresAt)
	}
	if next.RefreshTokenExpiresAt == nil {
		t.Fatal("refreshTokenExpiresAt should be set")
	}
	// A form-encoded refresh is what this used to send, and the endpoint wants what
	// `claude login` sends — so the content type is part of the contract here
	if gotContentType != "application/json" {
		t.Fatalf("content type %q, want application/json", gotContentType)
	}
	if gotBody["grant_type"] != "refresh_token" || gotBody["refresh_token"] != "RT" {
		t.Fatalf("wrong body: %v", gotBody)
	}
	if gotBody["client_id"] != "CID" {
		t.Fatalf("client_id got %q, want CID (from file)", gotBody["client_id"])
	}
	if gotBody["scope"] != "user:profile" {
		t.Fatalf("scope got %q", gotBody["scope"])
	}
}

func TestClaudeProviderRefreshInvalidGrant(t *testing.T) {
	dir := t.TempDir()
	p := writeClaudeCreds(t, dir, `{"claudeAiOauth":{"accessToken":"OLD","refreshToken":"RT","expiresAt":1}}`)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"error": "invalid_grant"})
	}))
	defer srv.Close()

	c := &claudeProvider{credentialsFile: p, tokenURL: srv.URL, timeout: 5 * time.Second}
	pair, _ := c.load()
	if _, err := c.refresh(context.Background(), pair); err == nil {
		t.Fatal("want an error for invalid_grant")
	}
}

// ---------------------------------------------------------------------------
// credential-manager: token caching / refresh decisions
// ---------------------------------------------------------------------------

type fakeProvider struct {
	pair      *tokenPair
	onRefresh func(pair *tokenPair) (*tokenPair, error)
	loadErr   error
	calls     int
}

func (f *fakeProvider) name() string { return "fake" }
func (f *fakeProvider) load() (*tokenPair, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	return f.pair, nil
}
func (f *fakeProvider) refresh(_ context.Context, pair *tokenPair) (*tokenPair, error) {
	f.calls++
	if f.onRefresh != nil {
		return f.onRefresh(pair)
	}
	return pair, nil
}

// resolveToken is the fake provider's credential, resolved. newManager seeds it
// from the provider's load(), so "fake" is the id as much as it is the kind.
func resolveToken(a *manager, force bool) (*tokenPair, error) {
	c, err := a.resolve(context.Background(), "fake", force)
	if err != nil {
		return nil, err
	}
	return c.Token, nil
}

func TestManagerTokenServesFreshCache(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "FRESH", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()},
	}
	a, err := newManager(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}

	pair, err := resolveToken(a, false)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if pair.AccessToken != "FRESH" {
		t.Fatalf("got %q", pair.AccessToken)
	}
	if fp.calls != 0 {
		t.Fatalf("refresh called %d times, want 0 (fresh)", fp.calls)
	}
}

func TestManagerTokenRefreshesWhenExpired(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "OLD", RefreshToken: "RT", ExpiresAt: now.Add(-time.Second).UnixMilli()},
		onRefresh: func(pair *tokenPair) (*tokenPair, error) {
			return &tokenPair{AccessToken: "NEW", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()}, nil
		},
	}
	a, _ := newManager(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})

	pair, err := resolveToken(a, false)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if pair.AccessToken != "NEW" {
		t.Fatalf("got %q, want NEW", pair.AccessToken)
	}
	if fp.calls != 1 {
		t.Fatalf("refresh called %d times, want 1", fp.calls)
	}
}

func TestManagerTokenForceRefreshes(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "OLD", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()},
		onRefresh: func(pair *tokenPair) (*tokenPair, error) {
			return &tokenPair{AccessToken: "NEW", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()}, nil
		},
	}
	a, _ := newManager(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})

	pair, err := resolveToken(a, true)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if pair.AccessToken != "NEW" {
		t.Fatalf("got %q, want NEW (forced)", pair.AccessToken)
	}
}

func TestManagerTokenKeepsValidTokenOnTransientRefreshFailure(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "OLDSTILLVALID", RefreshToken: "RT", ExpiresAt: now.Add(30 * time.Second).UnixMilli()},
		onRefresh: func(pair *tokenPair) (*tokenPair, error) {
			return nil, os.ErrDeadlineExceeded
		},
	}
	a, _ := newManager(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})

	pair, err := resolveToken(a, false)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if pair.AccessToken != "OLDSTILLVALID" {
		t.Fatalf("got %q, want the still-valid token", pair.AccessToken)
	}
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

func TestPersistenceRoundtrip(t *testing.T) {
	key, err := normalizeKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	pair := &tokenPair{AccessToken: "AT", RefreshToken: "RT", ExpiresAt: 12345, Scopes: []string{"a", "b"}}
	state := &persistentState{Credentials: map[string]*credential{
		"claude": {ID: "claude", Kind: kindClaude, Source: sourceLogin, Token: pair},
		"paid":   {ID: "paid", Kind: kindAPIKey, Source: sourceTyped, APIKey: "sk-ant-api03-secret"},
	}}

	ct, err := encryptState(key, state)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if len(ct) == 0 {
		t.Fatal("empty ciphertext")
	}

	back, err := decryptState(key, ct)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if back.Credentials["claude"].Token.RefreshToken != "RT" {
		t.Fatalf("roundtrip mismatch: %+v", back.Credentials["claude"])
	}
	if back.Credentials["paid"].APIKey != "sk-ant-api03-secret" {
		t.Fatalf("roundtrip mismatch: %+v", back.Credentials["paid"])
	}

	wrong, _ := normalizeKey([]byte("wrong-wrong-wrong-wrong-wrong-key!!"))
	if _, err := decryptState(wrong, ct); err == nil {
		t.Fatal("want an error for the wrong key")
	}
}

// ---------------------------------------------------------------------------
// UDS server
// ---------------------------------------------------------------------------

func dialUDS(t *testing.T, path string) *http.Client {
	t.Helper()
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", path)
			},
		},
	}
}

func TestUDSServerEndpoints(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "FRESH", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()},
		onRefresh: func(pair *tokenPair) (*tokenPair, error) {
			return &tokenPair{AccessToken: "NEW", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()}, nil
		},
	}

	sock := filepath.Join(t.TempDir(), "credential-manager.sock")
	cfg := config{socketPath: sock, refreshLead: time.Minute}
	a, err := newManager(cfg, map[string]provider{"claude": fp})
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = a.run(ctx) }()

	client := dialUDS(t, sock)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := client.Get("http://unix/health"); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	t.Run("health", func(t *testing.T) {
		resp, err := client.Get("http://unix/health")
		if err != nil {
			t.Fatalf("health: %v", err)
		}
		defer resp.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		creds := body["credentials"].(map[string]any)
		claude := creds["claude"].(map[string]any)
		if claude["ready"] != true {
			t.Fatalf("health claude ready = %v", claude["ready"])
		}
		if claude["hint"] == "FRESH" {
			t.Fatal("the health page must not carry the value itself")
		}
	})

	t.Run("token returns access token, never refresh token", func(t *testing.T) {
		resp, err := client.Get("http://unix/token?provider=claude")
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		defer resp.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["accessToken"] != "FRESH" {
			t.Fatalf("accessToken = %v", body["accessToken"])
		}
		if _, leaked := body["refreshToken"]; leaked {
			t.Fatal("refresh token must never be exposed over the socket")
		}
	})

	t.Run("refresh forces a refresh", func(t *testing.T) {
		resp, err := client.Post("http://unix/token/refresh", "application/json", strings.NewReader(`{"provider":"claude"}`))
		if err != nil {
			t.Fatalf("refresh: %v", err)
		}
		defer resp.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["accessToken"] != "NEW" {
			t.Fatalf("accessToken = %v, want NEW", body["accessToken"])
		}
	})

	t.Run("unknown credential", func(t *testing.T) {
		resp, err := client.Get("http://unix/token?credential=bogus")
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", resp.StatusCode)
		}
	})
}

// ---------------------------------------------------------------------------
// The credential store: what the console does to it
// ---------------------------------------------------------------------------

func TestStoreKeepsPastedKeysAndForgetsThem(t *testing.T) {
	a, err := newManager(config{refreshLead: time.Minute}, map[string]provider{})
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}

	a.put(&credential{ID: "paid", Kind: kindAPIKey, Source: sourceTyped, APIKey: "sk-ant-api03-0123456789abcdef"})

	c, err := a.resolve(context.Background(), "paid", false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got, err := c.secret(); err != nil || got != "sk-ant-api03-0123456789abcdef" {
		t.Fatalf("secret = %q, %v", got, err)
	}

	list := a.list()
	if len(list) != 1 {
		t.Fatalf("list = %v", list)
	}
	if h, _ := list[0]["hint"].(string); h != "sk-ant-a…cdef" {
		t.Fatalf("hint = %q, want a masked one", h)
	}
	if _, leaked := list[0]["apiKey"]; leaked {
		t.Fatal("the list must not carry the value")
	}

	// Re-pasting a rotated key is an update, not a second credential.
	first := a.creds["paid"].CreatedAt
	a.put(&credential{ID: "paid", Kind: kindAPIKey, Source: sourceTyped, APIKey: "sk-ant-api03-rotated"})
	if a.creds["paid"].CreatedAt != first {
		t.Fatal("an update must keep the credential's creation time")
	}
	if len(a.list()) != 1 {
		t.Fatal("an update must not add a second credential")
	}

	if !a.remove("paid") {
		t.Fatal("remove said there was nothing to remove")
	}
	if _, err := a.resolve(context.Background(), "paid", false); !errors.Is(err, errNoCredential) {
		t.Fatalf("resolve after remove: %v, want errNoCredential", err)
	}
}

// A restart must not undo a sign-in by putting the host's file back.
func TestSeedFromHostNeverOverwritesWhatIsStored(t *testing.T) {
	fp := &fakeProvider{pair: &tokenPair{AccessToken: "FROM-HOST", RefreshToken: "RT"}}
	a, err := newManager(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}
	if got := a.creds["fake"].Source; got != sourceHostFile {
		t.Fatalf("source = %q, want %q", got, sourceHostFile)
	}

	a.put(&credential{ID: "fake", Kind: "fake", Source: sourceLogin, Token: &tokenPair{AccessToken: "SIGNED-IN", RefreshToken: "RT2"}})
	a.seedFromHost()

	if got := a.creds["fake"].Token.AccessToken; got != "SIGNED-IN" {
		t.Fatalf("access token = %q, want the signed-in one", got)
	}
}

// ---------------------------------------------------------------------------
// Signing in from the console
// ---------------------------------------------------------------------------

func TestConsoleSignInCompletesTheCodeExchange(t *testing.T) {
	var gotVerifier, gotCode, gotRedirect string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]string
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if req["grant_type"] != "authorization_code" {
			t.Errorf("grant_type = %q", req["grant_type"])
		}
		gotVerifier, gotCode, gotRedirect = req["code_verifier"], req["code"], req["redirect_uri"]
		writeTestJSON(w, map[string]any{
			"access_token":  "sk-ant-oat01-NEW",
			"refresh_token": "RT-NEW",
			"expires_in":    3600,
			"scope":         "user:inference",
		})
	}))
	defer upstream.Close()

	cfg := config{
		refreshLead: time.Minute,
		httpTimeout: 5 * time.Second,
		logins: map[string]oauthLogin{
			kindClaude: {
				authorizeURL: "https://claude.ai/oauth/authorize",
				redirectURI:  "https://console.anthropic.com/oauth/code/callback",
				clientID:     "client-id",
				tokenURL:     upstream.URL,
				scopes:       []string{"user:inference"},
			},
		},
	}
	a, err := newManager(cfg, map[string]provider{})
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}

	pending, authorizeURL, err := a.startLogin(kindClaude, "sub", "personal")
	if err != nil {
		t.Fatalf("startLogin: %v", err)
	}
	u, err := url.Parse(authorizeURL)
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		t.Fatalf("no PKCE challenge in %s", authorizeURL)
	}
	if q.Get("state") == "" || q.Get("client_id") != "client-id" {
		t.Fatalf("authorize url missing parameters: %s", authorizeURL)
	}

	// Nothing is stored until the code comes back.
	if len(a.list()) != 0 {
		t.Fatal("a started sign-in must not store anything yet")
	}

	// What the redirect page shows is code#state.
	c, err := a.finishLogin(context.Background(), pending.ID, "THE-CODE#"+q.Get("state"))
	if err != nil {
		t.Fatalf("finishLogin: %v", err)
	}
	// Verbatim, `#state` and all: that is what the CLI sends, and the endpoint is the
	// one that decides what the two halves mean
	if gotCode != "THE-CODE#"+q.Get("state") {
		t.Fatalf("code sent upstream = %q", gotCode)
	}
	if gotRedirect != cfg.logins[kindClaude].redirectURI {
		t.Fatalf("redirect_uri = %q", gotRedirect)
	}
	// PKCE: the verifier must be the pre-image of the challenge sent to authorize.
	sum := sha256.Sum256([]byte(gotVerifier))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != q.Get("code_challenge") {
		t.Fatal("the verifier sent upstream does not match the challenge")
	}

	if c.Source != sourceLogin || c.ID != "sub" || c.Label != "personal" {
		t.Fatalf("stored credential = %+v", c)
	}
	if c.Token.AccessToken != "sk-ant-oat01-NEW" || c.Token.RefreshToken != "RT-NEW" {
		t.Fatalf("stored token = %+v", c.Token)
	}
	if _, leaked := c.summary()["refreshToken"]; leaked {
		t.Fatal("the console summary must not carry the refresh token")
	}

	// A code can only be spent once.
	if _, err := a.finishLogin(context.Background(), pending.ID, "THE-CODE#"+q.Get("state")); err == nil {
		t.Fatal("want an error for a sign-in that was already completed")
	}
}

func TestConsoleSignInRejectsAMismatchedState(t *testing.T) {
	a, err := newManager(config{
		logins: map[string]oauthLogin{kindClaude: {authorizeURL: "https://example.invalid/authorize", clientID: "c"}},
	}, map[string]provider{})
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}
	pending, _, err := a.startLogin(kindClaude, "sub", "")
	if err != nil {
		t.Fatalf("startLogin: %v", err)
	}
	if _, err := a.finishLogin(context.Background(), pending.ID, "THE-CODE#someone-elses-state"); err == nil {
		t.Fatal("want an error when the state does not match")
	}
}

func TestSignInIsRefusedForAKindWithNoEndpoints(t *testing.T) {
	a, err := newManager(config{logins: map[string]oauthLogin{}}, map[string]provider{})
	if err != nil {
		t.Fatalf("newManager: %v", err)
	}
	if _, _, err := a.startLogin(kindCodex, "codex", ""); err == nil {
		t.Fatal("want an error when the kind has no authorize endpoint")
	}
}

func writeTestJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
