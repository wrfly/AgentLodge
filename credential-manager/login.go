package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Signing a subscription in from the console.
//
// claude.ai's OAuth is authorization code + PKCE, and the way to complete it
// without a browser on this machine is the one `claude login` itself falls back
// to: the operator opens the authorize URL, approves, and the redirect lands on
// a page that shows a code to copy back. There is no device-code grant to use
// instead — the console shows a link and a box to paste into, and this file
// does the two halves of the exchange around that.
//
// What the console never sees: the code verifier, the code exchange, and the
// refresh token that comes out of it. It gets a URL, and afterwards a
// credential id.

// How long a started login stays completable. Long enough to walk to another
// machine, short enough that an abandoned one is gone within the hour.
const loginTTL = 15 * time.Minute

// errLoginPending says the operator has not finished approving yet. It is not a
// failure: the caller asks again.
var errLoginPending = errors.New("this sign-in has not been approved yet")

// oauthLogin is the endpoint set for one kind's flow.
//
// Two shapes share it. The authorization-code one (claude, codex) sends the
// operator to authorizeURL and takes back a pasted `code#state`, which is spent
// at tokenURL. Cursor's has no code to paste: pollURL is set instead, and this
// end asks that endpoint over and over until the approval lands. A non-empty
// pollURL is what selects it.
type oauthLogin struct {
	authorizeURL string
	redirectURI  string
	clientID     string
	tokenURL     string
	scopes       []string
	pollURL      string
}

// poll reports whether this kind completes by polling rather than by a paste.
func (o oauthLogin) poll() bool { return o.pollURL != "" }

// pendingLogin is one started, unfinished sign-in.
type pendingLogin struct {
	ID       string
	Kind     string
	CredID   string
	Label    string
	verifier string
	state    string
	// uuid names this attempt to the poll endpoint; empty for a paste flow.
	uuid    string
	started time.Time
}

func randomURLSafe(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// startLogin builds the authorize URL and remembers what finishing it needs.
func (a *manager) startLogin(kind, credID, label string) (*pendingLogin, string, error) {
	cfg, ok := a.cfg.logins[kind]
	if !ok {
		return nil, "", fmt.Errorf("signing in is not configured for %q; import a credentials file instead", kind)
	}
	if err := validID(credID); err != nil {
		return nil, "", err
	}

	verifier, err := randomURLSafe(32)
	if err != nil {
		return nil, "", err
	}
	// 32 bytes, like the verifier: the size `claude login` draws. The authorize
	// page answered a shorter one with "Invalid request format".
	state, err := randomURLSafe(32)
	if err != nil {
		return nil, "", err
	}
	id, err := randomURLSafe(12)
	if err != nil {
		return nil, "", err
	}

	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	// Cursor's flow: the operator approves in the browser and the tokens are
	// collected by polling, so there is no redirect to catch and nothing to
	// paste. The uuid names this attempt; the verifier proves the poll belongs
	// to whoever started it.
	if cfg.poll() {
		attempt, err := randomUUID()
		if err != nil {
			return nil, "", err
		}
		p := &pendingLogin{ID: id, Kind: kind, CredID: credID, Label: label, verifier: verifier, uuid: attempt, started: time.Now()}

		q := url.Values{
			"challenge":      {challenge},
			"uuid":           {attempt},
			"mode":           {"login"},
			"redirectTarget": {"cli"},
		}

		a.lock()
		defer a.unlock()
		a.pruneLogins()
		a.logins[id] = p

		return p, cfg.authorizeURL + "?" + q.Encode(), nil
	}

	// The parameters in the order `claude login` writes them, so the page gets
	// the request it is known to accept. url.Values would sort them.
	params := [][2]string{
		{"code", "true"},
		{"client_id", cfg.clientID},
		{"response_type", "code"},
		{"redirect_uri", cfg.redirectURI},
		{"scope", strings.Join(cfg.scopes, " ")},
		{"code_challenge", challenge},
		{"code_challenge_method", "S256"},
		{"state", state},
	}
	var q strings.Builder
	for i, kv := range params {
		if i > 0 {
			q.WriteByte('&')
		}
		q.WriteString(url.QueryEscape(kv[0]))
		q.WriteByte('=')
		q.WriteString(url.QueryEscape(kv[1]))
	}

	p := &pendingLogin{ID: id, Kind: kind, CredID: credID, Label: label, verifier: verifier, state: state, started: time.Now()}

	a.lock()
	defer a.unlock()
	a.pruneLogins()
	a.logins[id] = p

	return p, cfg.authorizeURL + "?" + q.String(), nil
}

// pruneLogins drops the expired ones. Assumes the caller holds a.lock().
func (a *manager) pruneLogins() {
	for id, p := range a.logins {
		if time.Since(p.started) > loginTTL {
			delete(a.logins, id)
		}
	}
}

// finishLogin exchanges the pasted code for tokens and stores the credential.
//
// The redirect page prints `code#state`. The state half is checked against the
// one this sign-in sent out, which is what makes a code pasted from somebody
// else's sign-in useless. Only the code half goes upstream, as `claude login`
// sends it.
func (a *manager) finishLogin(ctx context.Context, loginID, pasted string) (*credential, error) {
	a.lock()
	a.pruneLogins()
	p, ok := a.logins[loginID]
	a.unlock()
	if !ok {
		return nil, fmt.Errorf("this sign-in has expired or was already completed; start it again")
	}

	cfgFor := a.cfg.logins[p.Kind]
	if cfgFor.poll() {
		pair, err := pollForTokens(ctx, cfgFor, p.uuid, p.verifier, a.cfg.httpTimeout)
		if err != nil {
			// Still waiting is not a failure, and the sign-in stays open for the
			// next call; anything else has already ended it.
			return nil, err
		}
		return a.storeLogin(p, loginID, pair)
	}

	code, state, found := strings.Cut(strings.TrimSpace(pasted), "#")
	code, state = strings.TrimSpace(code), strings.TrimSpace(state)
	if code == "" {
		return nil, fmt.Errorf("no code in what was pasted")
	}
	if !found || state == "" {
		return nil, fmt.Errorf("paste the whole code the page shows, code#state")
	}
	if state != p.state {
		return nil, fmt.Errorf("this code belongs to a different sign-in")
	}

	pair, err := exchangeCode(ctx, cfgFor, code, p.verifier, p.state, a.cfg.httpTimeout)
	if err != nil {
		return nil, err
	}
	return a.storeLogin(p, loginID, pair)
}

// storeLogin keeps what a completed sign-in produced, whichever flow produced it.
func (a *manager) storeLogin(p *pendingLogin, loginID string, pair *tokenPair) (*credential, error) {
	c := &credential{ID: p.CredID, Kind: p.Kind, Label: p.Label, Source: sourceLogin, Token: pair}
	// The sign-in itself succeeded: the code was exchanged and the refresh token
	// is in memory. Failing here would tell the operator to start over with a
	// fresh code — impossible, the old one is spent — while a working credential
	// sits in memory. Recorded for /health (put sets storeErr) and logged.
	if err := a.put(c); err != nil {
		logf("signed in %s, but the store could not be written: %v", c.ID, err)
	}

	a.lock()
	delete(a.logins, loginID)
	a.unlock()

	logf("%s: signed in from the console as %s", p.Kind, c.ID)
	return c, nil
}

// pollForTokens asks Cursor once whether the operator has approved yet.
//
// One attempt per call, driven by whoever is waiting, rather than a loop held
// open here: the console is already asking repeatedly, and a request parked for
// the CLI's full fifteen minutes would hold a connection for the whole of it.
//
//	404  not yet — the ordinary answer while the browser tab is still open
//	200  the credentials, as {accessToken, refreshToken}
//	403  refused, and the body says why when an organisation's device policy
//	     is what refused it
func pollForTokens(ctx context.Context, cfg oauthLogin, uuid, verifier string, timeout time.Duration) (*tokenPair, error) {
	q := url.Values{"uuid": {uuid}, "verifier": {verifier}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.pollURL+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusNotFound {
		return nil, errLoginPending
	}
	if resp.StatusCode == http.StatusForbidden {
		var refusal struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &refusal)
		if refusal.Error == "sign_in_policy_violation" {
			return nil, fmt.Errorf("signing in on this machine is restricted by your organisation's device policy")
		}
		return nil, fmt.Errorf("cursor refused the sign-in: %s", strings.TrimSpace(string(body)))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("sign-in poll returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var tr struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		APIKey       string `json:"apiKey"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode sign-in poll: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("sign-in poll answered without an access token")
	}
	return &tokenPair{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		APIKey:       tr.APIKey,
		ExpiresAt:    jwtExpiry(tr.AccessToken),
	}, nil
}

// randomUUID is a v4 uuid, which is what the poll endpoint names an attempt by.
func randomUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// exchangeCode trades the authorization code for a token pair.
func exchangeCode(ctx context.Context, cfg oauthLogin, code, verifier, state string, timeout time.Duration) (*tokenPair, error) {
	payload := map[string]string{
		"grant_type":    "authorization_code",
		"code":          code,
		"redirect_uri":  cfg.redirectURI,
		"client_id":     cfg.clientID,
		"code_verifier": verifier,
		"state":         state,
	}
	body, err := postJSON(ctx, cfg.tokenURL, payload, timeout)
	if err != nil {
		return nil, err
	}

	var tr struct {
		AccessToken           string `json:"access_token"`
		RefreshToken          string `json:"refresh_token"`
		ExpiresIn             int64  `json:"expires_in"`
		RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
		Scope                 string `json:"scope"`
		AccountID             string `json:"account_id"`
	}
	if err := json.Unmarshal(body, &tr); err != nil {
		return nil, fmt.Errorf("decode token response: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, fmt.Errorf("token response carried no access_token")
	}

	pair := &tokenPair{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		ClientID:     cfg.clientID,
		AccountID:    tr.AccountID,
	}
	if tr.ExpiresIn > 0 {
		pair.ExpiresAt = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second).UnixMilli()
	}
	if tr.RefreshTokenExpiresIn > 0 {
		rt := time.Now().Add(time.Duration(tr.RefreshTokenExpiresIn) * time.Second).UnixMilli()
		pair.RefreshTokenExpiresAt = &rt
	}
	if tr.Scope != "" {
		pair.Scopes = strings.Fields(tr.Scope)
	} else {
		pair.Scopes = cfg.scopes
	}
	return pair, nil
}
