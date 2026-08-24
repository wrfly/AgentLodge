package main

import (
	"context"
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
	if os.Getenv("GOOS_UNSUPPORTED_KEYCHAIN") != "" || os.Getenv("AUTHER_DISABLE_KEYCHAIN") != "" {
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
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {pair.RefreshToken},
	}
	if pair.ClientID != "" {
		form.Set("client_id", pair.ClientID)
	} else if c.clientID != "" {
		form.Set("client_id", c.clientID)
	}
	scopes := pair.Scopes
	if len(scopes) == 0 {
		scopes = c.scopes
	}
	if len(scopes) > 0 {
		form.Set("scope", strings.Join(scopes, " "))
	}

	body, err := postForm(ctx, c.tokenURL, form, nil, c.timeout)
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
