package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
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

	var gotForm map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		gotForm = map[string]string{
			"grant_type":    r.PostFormValue("grant_type"),
			"refresh_token": r.PostFormValue("refresh_token"),
			"client_id":     r.PostFormValue("client_id"),
			"scope":         r.PostFormValue("scope"),
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
	if gotForm["grant_type"] != "refresh_token" || gotForm["refresh_token"] != "RT" {
		t.Fatalf("wrong form: %v", gotForm)
	}
	if gotForm["client_id"] != "CID" {
		t.Fatalf("client_id got %q, want CID (from file)", gotForm["client_id"])
	}
	if gotForm["scope"] != "user:profile" {
		t.Fatalf("scope got %q", gotForm["scope"])
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
// auther: token caching / refresh decisions
// ---------------------------------------------------------------------------

type fakeProvider struct {
	pair    *tokenPair
	onRefresh func(pair *tokenPair) (*tokenPair, error)
	loadErr error
	calls   int
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

func TestAutherTokenServesFreshCache(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "FRESH", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()},
	}
	a, err := newAuther(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})
	if err != nil {
		t.Fatalf("newAuther: %v", err)
	}

	pair, err := a.token(context.Background(), fp, false)
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

func TestAutherTokenRefreshesWhenExpired(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "OLD", RefreshToken: "RT", ExpiresAt: now.Add(-time.Second).UnixMilli()},
		onRefresh: func(pair *tokenPair) (*tokenPair, error) {
			return &tokenPair{AccessToken: "NEW", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()}, nil
		},
	}
	a, _ := newAuther(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})

	pair, err := a.token(context.Background(), fp, false)
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

func TestAutherTokenForceRefreshes(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "OLD", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()},
		onRefresh: func(pair *tokenPair) (*tokenPair, error) {
			return &tokenPair{AccessToken: "NEW", RefreshToken: "RT", ExpiresAt: now.Add(time.Hour).UnixMilli()}, nil
		},
	}
	a, _ := newAuther(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})

	pair, err := a.token(context.Background(), fp, true)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if pair.AccessToken != "NEW" {
		t.Fatalf("got %q, want NEW (forced)", pair.AccessToken)
	}
}

func TestAutherTokenKeepsValidTokenOnTransientRefreshFailure(t *testing.T) {
	now := time.Now()
	fp := &fakeProvider{
		pair: &tokenPair{AccessToken: "OLDSTILLVALID", RefreshToken: "RT", ExpiresAt: now.Add(30 * time.Second).UnixMilli()},
		onRefresh: func(pair *tokenPair) (*tokenPair, error) {
			return nil, os.ErrDeadlineExceeded
		},
	}
	a, _ := newAuther(config{refreshLead: time.Minute}, map[string]provider{"fake": fp})

	pair, err := a.token(context.Background(), fp, false)
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
	state := &persistentState{Tokens: map[string]*tokenPair{"claude": pair}}

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
	if back.Tokens["claude"].RefreshToken != "RT" {
		t.Fatalf("roundtrip mismatch: %+v", back.Tokens["claude"])
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

	sock := filepath.Join(t.TempDir(), "auther.sock")
	cfg := config{socketPath: sock, refreshLead: time.Minute}
	a, err := newAuther(cfg, map[string]provider{"claude": fp})
	if err != nil {
		t.Fatalf("newAuther: %v", err)
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
		provs := body["providers"].(map[string]any)
		claude := provs["claude"].(map[string]any)
		if claude["ok"] != true {
			t.Fatalf("health claude ok = %v", claude["ok"])
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

	t.Run("unknown provider", func(t *testing.T) {
		resp, err := client.Get("http://unix/token?provider=bogus")
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.StatusCode)
		}
	})
}
