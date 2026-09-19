package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// claudeProvider: claude.ai subscription OAuth, sourced from
// ~/.claude/.credentials.json (or the macOS Keychain when running on a Mac
// where the file is absent), refreshed against platform.claude.com.
// ---------------------------------------------------------------------------

const claudeKeychainService = "Claude Code-credentials"

type claudeProvider struct {
	credentialsFile string
	clientID        string
	tokenURL        string
	scopes          []string
	timeout         time.Duration
}

func (c *claudeProvider) name() string { return providerClaude }

func (c *claudeProvider) load() (*tokenPair, error) {
	if pair, err := c.loadFile(); err == nil {
		return pair, nil
	}
	if pair, err := c.loadKeychain(); err == nil {
		return pair, nil
	}
	return nil, fmt.Errorf("no claude credentials at %s (or Keychain); run `claude login` on the host", c.credentialsFile)
}

func (c *claudeProvider) loadFile() (*tokenPair, error) {
	raw, err := os.ReadFile(c.credentialsFile)
	if err != nil {
		return nil, err
	}
	pair, err := parseClaudePayload(raw, "file:"+c.credentialsFile)
	if err != nil {
		return nil, err
	}
	return pair, nil
}

func (c *claudeProvider) loadKeychain() (*tokenPair, error) {
	if os.Getenv("GOOS_UNSUPPORTED_KEYCHAIN") != "" || os.Getenv("CREDENTIAL_MANAGER_DISABLE_KEYCHAIN") != "" {
		return nil, fmt.Errorf("keychain disabled")
	}
	out, err := exec.Command("security", "find-generic-password", "-s", claudeKeychainService, "-w").Output()
	if err != nil || len(out) == 0 {
		return nil, fmt.Errorf("keychain read failed")
	}
	return parseClaudePayload(out, "keychain")
}

func parseClaudePayload(raw []byte, source string) (*tokenPair, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse claude credentials: %w", err)
	}
	oauth, _ := doc["claudeAiOauth"].(map[string]any)
	if oauth == nil {
		// Fall back to a flat document (the SDK credentials-file shape).
		oauth = doc
	}
	access := stringField(oauth, "accessToken", "access_token")
	if access == "" {
		return nil, fmt.Errorf("no access token in claude credentials (%s)", source)
	}
	pair := &tokenPair{
		AccessToken:  access,
		RefreshToken: stringField(oauth, "refreshToken", "refresh_token"),
		ExpiresAt:    intField(oauth, "expiresAt", "expires_at"),
		Scopes:       stringSliceField(oauth, "scopes"),
		ClientID:     stringField(oauth, "clientId", "client_id"),
	}
	if ret := intPtrField(oauth, "refreshTokenExpiresAt", "refresh_token_expires_at"); ret != 0 {
		pair.RefreshTokenExpiresAt = &ret
	}
	return pair, nil
}

func (c *claudeProvider) refresh(ctx context.Context, pair *tokenPair) (*tokenPair, error) {
	if pair.RefreshToken == "" {
		return nil, fmt.Errorf("no claude refresh token available")
	}
	// JSON, not a form: this is the request `claude login` makes for the same
	// grant, and the endpoint is particular about it.
	payload := map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": pair.RefreshToken,
	}
	if pair.ClientID != "" {
		payload["client_id"] = pair.ClientID
	} else if c.clientID != "" {
		payload["client_id"] = c.clientID
	}
	scopes := pair.Scopes
	if len(scopes) == 0 {
		scopes = c.scopes
	}
	if len(scopes) > 0 {
		payload["scope"] = strings.Join(scopes, " ")
	}

	body, err := postJSON(ctx, c.tokenURL, payload, c.timeout)
	if err != nil {
		return nil, err
	}
	var tr struct {
		AccessToken           string `json:"access_token"`
		RefreshToken          string `json:"refresh_token"`
		ExpiresIn             int64  `json:"expires_in"`
		RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
		Scope                 string `json:"scope"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode claude refresh: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("claude refresh response missing access_token")
	}
	if tr.ExpiresIn <= 0 {
		return nil, fmt.Errorf("claude refresh response missing expires_in")
	}

	next := *pair
	next.AccessToken = tr.AccessToken
	next.ExpiresAt = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second).UnixMilli()
	if tr.RefreshToken != "" {
		next.RefreshToken = tr.RefreshToken
	}
	if tr.RefreshTokenExpiresIn > 0 {
		rt := time.Now().Add(time.Duration(tr.RefreshTokenExpiresIn) * time.Second).UnixMilli()
		next.RefreshTokenExpiresAt = &rt
	}
	if tr.Scope != "" {
		next.Scopes = strings.Fields(tr.Scope)
	}
	return &next, nil
}

// ---------------------------------------------------------------------------
// codexProvider: ChatGPT subscription OAuth, sourced from ~/.codex/auth.json,
// refreshed against auth.openai.com.
// ---------------------------------------------------------------------------

type codexProvider struct {
	authFile string
	clientID string
	tokenURL string
	timeout  time.Duration
}

func (c *codexProvider) name() string { return providerCodex }

func (c *codexProvider) load() (*tokenPair, error) {
	raw, err := os.ReadFile(c.authFile)
	if err != nil {
		return nil, fmt.Errorf("%s does not exist; run `codex login` on the host", c.authFile)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse codex auth.json: %w", err)
	}
	tokens, _ := doc["tokens"].(map[string]any)
	if tokens == nil {
		tokens = doc
	}
	access := stringField(tokens, "access_token", "accessToken")
	if access == "" {
		return nil, fmt.Errorf("no access_token in %s", c.authFile)
	}
	return &tokenPair{
		AccessToken:  access,
		RefreshToken: stringField(tokens, "refresh_token", "refreshToken"),
		AccountID:    stringField(tokens, "account_id", "accountId"),
	}, nil
}

func (c *codexProvider) refresh(ctx context.Context, pair *tokenPair) (*tokenPair, error) {
	if pair.RefreshToken == "" {
		return nil, fmt.Errorf("no codex refresh token available")
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {pair.RefreshToken},
		"client_id":     {c.clientID},
	}
	body, err := postForm(ctx, c.tokenURL, form, nil, c.timeout)
	if err != nil {
		return nil, err
	}
	var tr struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode codex refresh: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("codex refresh response missing access_token")
	}
	next := *pair
	next.AccessToken = tr.AccessToken
	if tr.ExpiresIn > 0 {
		next.ExpiresAt = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second).UnixMilli()
	}
	if tr.RefreshToken != "" {
		next.RefreshToken = tr.RefreshToken
	}
	return &next, nil
}

// ---------------------------------------------------------------------------
// cursorProvider: a Cursor subscription, sourced from the auth.json that
// `cursor-agent login` writes, renewed by handing back the API key stored
// beside the tokens.
//
// Cursor has no refresh-token grant. Its CLI keeps three values — an access
// token, a refresh token and an API key — and renews by posting the API key to
// /auth/exchange_user_api_key, which answers with a fresh pair. So the API key
// is the durable credential here, and the refresh token is carried only because
// the file has one: nothing known accepts it.
// ---------------------------------------------------------------------------

type cursorProvider struct {
	authFile string
	apiBase  string
	timeout  time.Duration
}

func (c *cursorProvider) name() string { return providerCursor }

func (c *cursorProvider) load() (*tokenPair, error) {
	raw, err := os.ReadFile(c.authFile)
	if err != nil {
		return nil, fmt.Errorf("%s does not exist; run `cursor-agent login` on the host", c.authFile)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse cursor auth.json: %w", err)
	}
	access := stringField(doc, "accessToken", "access_token")
	apiKey := stringField(doc, "apiKey", "api_key")
	// Either alone is enough to work with: an API key can mint an access token,
	// and an access token serves until it expires.
	if access == "" && apiKey == "" {
		return nil, fmt.Errorf("no accessToken or apiKey in %s", c.authFile)
	}
	return &tokenPair{
		AccessToken:  access,
		RefreshToken: stringField(doc, "refreshToken", "refresh_token"),
		APIKey:       apiKey,
		ExpiresAt:    jwtExpiry(access),
	}, nil
}

func (c *cursorProvider) refresh(ctx context.Context, pair *tokenPair) (*tokenPair, error) {
	if pair.APIKey == "" {
		return nil, fmt.Errorf("no cursor API key held, and Cursor has no refresh-token grant; sign in again")
	}
	endpoint := strings.TrimSuffix(c.apiBase, "/") + "/auth/exchange_user_api_key"
	body, err := postJSONWith(ctx, endpoint, map[string]any{},
		map[string]string{"Authorization": "Bearer " + pair.APIKey}, c.timeout)
	if err != nil {
		return nil, err
	}

	var tr struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode cursor exchange: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("cursor exchange response missing accessToken")
	}

	next := *pair
	next.AccessToken = tr.AccessToken
	if tr.RefreshToken != "" {
		next.RefreshToken = tr.RefreshToken
	}
	// This reply carries no expires_in; the access token states its own lifetime.
	next.ExpiresAt = jwtExpiry(tr.AccessToken)
	return &next, nil
}

// jwtExpiry reads `exp` out of a JWT payload, as unix ms. Zero when the value is
// not a JWT or carries no exp, which expired() reads as "no stated lifetime"
// rather than as "expired".
func jwtExpiry(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return 0
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil || claims.Exp <= 0 {
		return 0
	}
	return claims.Exp * 1000
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// postForm POSTs an application/x-www-form-urlencoded body and returns the
// response body. A non-2xx status is an error carrying the response text.
func postForm(ctx context.Context, endpoint string, form url.Values, headers map[string]string, timeout time.Duration) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("token endpoint returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// postJSON POSTs a JSON body and returns the response body, with the same
// non-2xx-is-an-error rule as postForm.
func postJSON(ctx context.Context, endpoint string, payload any, timeout time.Duration) ([]byte, error) {
	return postJSONWith(ctx, endpoint, payload, nil, timeout)
}

// postJSONWith is postJSON with extra request headers, which is what Cursor's
// exchange needs: it authenticates with a bearer token rather than a body field.
func postJSONWith(ctx context.Context, endpoint string, payload any, headers map[string]string, timeout time.Duration) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("token endpoint returned %s: %s", resp.Status, strings.TrimSpace(string(out)))
	}
	return out, nil
}

func stringField(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func intField(m map[string]any, keys ...string) int64 {
	for _, k := range keys {
		switch v := m[k].(type) {
		case float64:
			return int64(v)
		case int64:
			return v
		case int:
			return int64(v)
		case string:
			var n int64
			if _, err := fmt.Sscan(v, &n); err == nil {
				return n
			}
		}
	}
	return 0
}

func intPtrField(m map[string]any, keys ...string) int64 {
	return intField(m, keys...)
}

func stringSliceField(m map[string]any, key string) []string {
	raw, ok := m[key]
	if !ok {
		return nil
	}
	switch v := raw.(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return v
	case string:
		return strings.Fields(v)
	}
	return nil
}
