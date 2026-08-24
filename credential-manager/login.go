package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

// oauthLogin is the endpoint set for one kind's authorization-code flow.
type oauthLogin struct {
	authorizeURL string
	redirectURI  string
	clientID     string
	tokenURL     string
	scopes       []string
}

// pendingLogin is one started, unfinished sign-in.
type pendingLogin struct {
	ID       string
	Kind     string
	CredID   string
	Label    string
	verifier string
	state    string
	started  time.Time
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
	state, err := randomURLSafe(16)
	if err != nil {
		return nil, "", err
	}
	id, err := randomURLSafe(12)
	if err != nil {
		return nil, "", err
	}

	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	q := url.Values{
		"code":                  {"true"},
		"client_id":             {cfg.clientID},
		"response_type":         {"code"},
		"redirect_uri":          {cfg.redirectURI},
		"scope":                 {strings.Join(cfg.scopes, " ")},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"state":                 {state},
	}

	p := &pendingLogin{ID: id, Kind: kind, CredID: credID, Label: label, verifier: verifier, state: state, started: time.Now()}

	a.lock()
	defer a.unlock()
	a.pruneLogins()
	a.logins[id] = p

	return p, cfg.authorizeURL + "?" + q.Encode(), nil
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
// What the redirect page shows can carry the state after a `#`. That whole
// string is what goes upstream as the code — the CLI sends it verbatim too, and
// the endpoint is the one that decides what the two halves mean. The state is
// still checked here when it is there, which is the part that makes a code
// pasted from somebody else's sign-in useless.
func (a *manager) finishLogin(ctx context.Context, loginID, pasted string) (*credential, error) {
	a.lock()
	a.pruneLogins()
	p, ok := a.logins[loginID]
	a.unlock()
	if !ok {
		return nil, fmt.Errorf("this sign-in has expired or was already completed; start it again")
	}

	code := strings.TrimSpace(pasted)
	if code == "" {
		return nil, fmt.Errorf("no code in what was pasted")
	}
	if _, state, found := strings.Cut(code, "#"); found && state != p.state {
		return nil, fmt.Errorf("this code belongs to a different sign-in")
	}

	cfg := a.cfg.logins[p.Kind]
	pair, err := exchangeCode(ctx, cfg, code, p.verifier, p.state, a.cfg.httpTimeout)
	if err != nil {
		return nil, err
	}

	c := &credential{ID: p.CredID, Kind: p.Kind, Label: p.Label, Source: sourceLogin, Token: pair}
	a.put(c)

	a.lock()
	delete(a.logins, loginID)
	a.unlock()

	logf("%s: signed in from the console as %s", p.Kind, c.ID)
	return c, nil
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
