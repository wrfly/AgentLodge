package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// errNoCredential separates "you asked for something that is not here" from
// "what you asked for cannot be served right now": the first is a 404 the
// console can act on, the second a 503 that says try again.
var errNoCredential = errors.New("no such credential")

// The credential store.
//
// A credential is what an upstream provider in the console points at. Three kinds:
//
//	api-key   a key somebody pasted (sk-ant-…, sk-…). Handed out as-is.
//	key-file  a path to a file somebody else writes and rotates. Read afresh
//	          every time it is asked for; see keyfile.go.
//	claude    a claude.ai subscription. Access tokens are minted from a refresh
//	          token and handed out with hours to live.
//	codex     the same for a ChatGPT subscription.
//
// Why they live here rather than in the application's database: the value the
// console would have to hold for an OAuth subscription is a *refresh token*,
// which mints new access tokens for as long as it lives. Keeping it in one
// process, behind a socket that only hands out short-lived access tokens, means
// a leak of the database — or of a browser session that can read it back — is
// not a leak of the subscription. The console holds a credential's **id**; the
// value never travels to it.
//
// The store is written to CREDENTIAL_MANAGER_STATE_FILE, AES-256-GCM encrypted
// (see store.go), so a restart does not lose a subscription that was signed in
// from the console.

const (
	kindAPIKey  = "api-key"
	kindKeyFile = "key-file"
	// The OAuth kinds are named after the provider they belong to, so a kind
	// also selects the refresher in provs.
	kindClaude = providerClaude
	kindCodex  = providerCodex
)

// Where a credential came from. Shown in the console, because "this one is a
// copy of the host's file" and "this one was signed in here" behave differently
// when the host signs in again.
const (
	sourceHostFile = "host-file" // read from the credentials file mounted into this container
	sourceTyped    = "typed"     // pasted into the console
	sourceLogin    = "login"     // signed in from the console
	sourceImport   = "import"    // copied out of a host credentials file on request
	sourceFile     = "file"      // a path to a file another process writes
)

type credential struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Label  string `json:"label,omitempty"`
	Source string `json:"source"`

	// kindAPIKey
	APIKey string `json:"apiKey,omitempty"`
	// kindKeyFile — a path, never a value
	Path string `json:"path,omitempty"`
	// kindClaude / kindCodex
	Token *tokenPair `json:"token,omitempty"`

	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

// secret is the value that goes upstream as Authorization: the key itself, the
// contents of the file it points at, or the current access token.
//
// A key file is read on **every** call, deliberately. The reason to name a file
// rather than paste its contents is that something else rotates it, and holding
// on to what was read throws away the one thing that buys.
func (c *credential) secret() (string, error) {
	switch c.Kind {
	case kindAPIKey:
		if c.APIKey == "" {
			return "", fmt.Errorf("holds no key")
		}
		return c.APIKey, nil
	case kindKeyFile:
		value, _, err := readKeyFile(c.Path)
		return value, err
	default:
		if c.Token == nil || c.Token.AccessToken == "" {
			return "", fmt.Errorf("holds no token; sign in or import it again")
		}
		return c.Token.AccessToken, nil
	}
}

// hint is enough of the value to recognise it by and not enough to use.
// Keys carry a meaningful prefix (sk-ant-api03-…, sk-…), so the head is worth
// showing; the tail is what distinguishes two keys from the same account.
func hint(v string) string {
	if v == "" {
		return ""
	}
	if len(v) <= 12 {
		return strings.Repeat("•", len(v))
	}
	return v[:8] + "…" + v[len(v)-4:]
}

// summary is the credential as the console sees it: everything except the value.
func (c *credential) summary() map[string]any {
	value, err := c.secret()
	out := map[string]any{
		"id":        c.ID,
		"kind":      c.Kind,
		"source":    c.Source,
		"createdAt": c.CreatedAt,
		"updatedAt": c.UpdatedAt,
		"hint":      hint(value),
		"ready":     err == nil && value != "",
	}
	if err != nil {
		// The console shows this verbatim: for a key file it is the whole diagnosis —
		// wrong path, not in the allowlist, a JSON file where a token was meant.
		out["error"] = err.Error()
	}
	if c.Kind == kindKeyFile {
		out["path"] = c.Path
		if _, info, err := readKeyFile(c.Path); err == nil {
			out["fingerprint"] = info.Fingerprint
			out["mtime"] = info.MTime
			out["size"] = info.Size
		}
	}
	if c.Label != "" {
		out["label"] = c.Label
	}
	if c.Token != nil {
		if c.Token.ExpiresAt != 0 {
			out["expiresAt"] = c.Token.ExpiresAt
		}
		if c.Token.RefreshTokenExpiresAt != nil {
			out["refreshTokenExpiresAt"] = *c.Token.RefreshTokenExpiresAt
		}
		if c.Token.AccountID != "" {
			out["accountId"] = c.Token.AccountID
		}
		if len(c.Token.Scopes) > 0 {
			out["scopes"] = c.Token.Scopes
		}
		// A subscription with no refresh token can serve its current access
		// token and nothing after it — worth saying before it expires.
		out["renewable"] = c.Token.RefreshToken != ""
	}
	return out
}

// validID keeps ids to what can appear in a URL query and be read back in a
// console list without quoting: letters, digits, dash, underscore, dot.
func validID(id string) error {
	if id == "" {
		return fmt.Errorf("an id is required")
	}
	if len(id) > 64 {
		return fmt.Errorf("id is longer than 64 characters")
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return fmt.Errorf("id may only contain letters, digits, dash, underscore and dot")
		}
	}
	return nil
}

func validKind(kind string) error {
	switch kind {
	case kindAPIKey, kindKeyFile, kindClaude, kindCodex:
		return nil
	}
	return fmt.Errorf("unknown kind %q: want one of %s, %s, %s, %s", kind, kindAPIKey, kindKeyFile, kindClaude, kindCodex)
}

// list returns every credential's summary, ordered by id so the console does
// not reshuffle between polls.
func (a *manager) list() []map[string]any {
	a.lock()
	defer a.unlock()

	ids := make([]string, 0, len(a.creds))
	for id := range a.creds {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	out := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		out = append(out, a.creds[id].summary())
	}
	return out
}

// put stores a credential, replacing one with the same id, and reports whether
// the store reached disk.
//
// The in-memory store is updated either way, which is what the irreversible
// callers need: a spent OAuth code cannot be exchanged twice and a host file
// that has already been read is already read, so they serve the credential and
// let /health carry the degradation. A caller that turns the error into a
// failed operation for the operator wants putDurable instead.
func (a *manager) put(c *credential) error {
	a.lock()
	defer a.unlock()

	a.storeLocked(c)
	return a.persist()
}

// putDurable stores a credential only if the store reaches disk, undoing the
// in-memory change when it does not. It is for the operations whose success
// criterion *is* durable storage and that the operator can simply repeat —
// pasting an API key, pointing at a key file.
//
// Without the rollback the 500 those handlers return is a lie: the credential
// is live, listed and serving tokens, and on a re-paste the key it replaced is
// already destroyed — the same "one action, three answers" that delete used to
// have, from the other side.
func (a *manager) putDurable(c *credential) error {
	a.lock()
	defer a.unlock()

	prev, had := a.storeLocked(c)
	if err := a.persist(); err != nil {
		// The write never landed, so the file still holds what memory held
		// before this call: putting that back leaves the two agreeing. storeErr
		// stays set — the store is degraded whether or not this change was
		// wanted, and /health has to keep saying so.
		if had {
			a.creds[c.ID] = prev
		} else {
			delete(a.creds, c.ID)
		}
		return err
	}
	return nil
}

// storeLocked puts c into the map, carrying over the creation time of whatever
// it replaces — an id is a stable thing the console points at, and re-pasting a
// rotated key is an update, not a new credential. Reports what was there, so a
// caller can undo it. The caller holds a.mu.
func (a *manager) storeLocked(c *credential) (prev *credential, had bool) {
	now := time.Now().UnixMilli()
	c.UpdatedAt = now
	c.CreatedAt = now
	prev, had = a.creds[c.ID]
	if had {
		c.CreatedAt = prev.CreatedAt
	}
	a.creds[c.ID] = c
	return prev, had
}

// remove deletes a credential. Reports whether there was one.
//
// The removal is in-memory and immediate: the credential stops being usable the
// moment the map no longer holds it, which is the security-relevant effect and
// what the operator asked for. A persist failure only means a restart could
// bring it back, so instead of failing the call (there is nothing to retry
// that would help), it is recorded for /health and logged.
func (a *manager) remove(id string) bool {
	a.lock()
	defer a.unlock()

	if _, ok := a.creds[id]; !ok {
		return false
	}
	delete(a.creds, id)
	if err := a.persist(); err != nil {
		logf("removed %s in memory, but the store could not be written: %v", id, err)
	}
	// The credential is gone, so its refresh lock is dead weight; drop it so the
	// map does not grow for every id that ever existed.
	a.releaseRefreshLock(id)
	return true
}

func (a *manager) get(id string) (*credential, bool) {
	a.lock()
	defer a.unlock()
	c, ok := a.creds[id]
	return c, ok
}

// resolve returns a credential with a usable secret, minting a new access token
// when the current one is within the refresh lead of expiry (or when force says
// so, which is what the gateway asks for after a 401).
//
// A refresh that fails while the current token is still valid is not an error:
// the token endpoint being briefly unreachable should not take the upstream
// down with it. What cannot be papered over is an expired token and a failed
// refresh, and that comes back as an error the console can show.
func (a *manager) resolve(ctx context.Context, id string, force bool) (*credential, error) {
	a.lock()
	first, ok := a.creds[id]
	a.unlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s", errNoCredential, id)
	}

	// Nothing to mint for these two: one carries the value, the other reads it.
	if first.Kind == kindAPIKey || first.Kind == kindKeyFile {
		if _, err := first.secret(); err != nil {
			return nil, fmt.Errorf("credential %q: %w", id, err)
		}
		return first, nil
	}

	if first.Token == nil {
		return nil, fmt.Errorf("credential %q holds no token; sign in or import it again", id)
	}

	// Serialise the refresh per credential. Without this, two concurrent calls
	// (a /token and the preRefresh ticker, or two gateway requests crossing the
	// expiry lead together) both see an expiring token, both call the token
	// endpoint, and — because the endpoint rotates the refresh token — the last
	// one to swap stores a refresh token that the other already spent. That
	// leaves the credential permanently broken with an "invalid_grant".
	queued := first.Token
	rl := a.refreshLock(id)
	rl.Lock()
	defer rl.Unlock()

	// Re-read under the per-credential lock: another request may have refreshed
	// (or re-imported / re-signed-in) while we queued behind it. Everything from
	// here on — the provider, the kind, the token — is taken from this current
	// snapshot, not from whatever was in the store when the call began.
	a.lock()
	c, ok := a.creds[id]
	a.unlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s (removed while it was being renewed)", errNoCredential, id)
	}

	// The credential changed kind while this call waited for its turn — most
	// plausibly the subscription was replaced by a pasted key or a key file.
	// That needs no refresh: serve it exactly the way the top of this function
	// would have, rather than reporting "sign in or import it again" about a
	// credential that needs neither.
	if c.Kind == kindAPIKey || c.Kind == kindKeyFile {
		if _, err := c.secret(); err != nil {
			return nil, fmt.Errorf("credential %q: %w", id, err)
		}
		return c, nil
	}

	// A token other than the one we queued with means the refresh we were
	// waiting for has already landed, and that answers a force caller as well:
	// force asks for "not the token I had", and this is not the token it had.
	// Gating this on !force would leave the lock serialising the stampede
	// instead of collapsing it — ten proxied requests that hit 401 together
	// each rotate the refresh token in turn, and every rotation but the last
	// is spent the moment the next one lands.
	if c.Token != nil && c.Token != queued {
		return c, nil
	}
	if c.Token == nil {
		return nil, fmt.Errorf("credential %q holds no token; sign in or import it again", id)
	}
	if !force && !expired(c.Token, a.cfg.refreshLead) {
		return c, nil
	}

	// The provider is bound to the credential's kind from *this* snapshot, not
	// the one read before waiting on the lock — a re-import or re-sign-in that
	// changed the kind while we queued must not send the refresh to the wrong
	// endpoint.
	p, ok := a.provs[c.Kind]
	if !ok {
		return nil, fmt.Errorf("credential %q has kind %q, which this build cannot refresh", id, c.Kind)
	}

	refreshed, err := p.refresh(ctx, c.Token)
	if err != nil {
		if c.Token.AccessToken != "" && !expired(c.Token, 0) {
			return c, nil
		}
		return nil, fmt.Errorf("refresh %s: %w", id, err)
	}

	a.lock()
	// Re-read under the store lock: the credential may have been replaced while
	// this call was upstream (a re-import or a re-sign-in).
	cur, ok := a.creds[id]
	if !ok {
		a.unlock()
		return nil, fmt.Errorf("%w: %s (removed while it was being renewed)", errNoCredential, id)
	}
	// The refresh result belongs to the credential we started from. Every write
	// path installs a fresh pointer, so pointer equality says whether the thing
	// in the store is still that one; if it is not — the subscription was
	// replaced while the token endpoint was answering — grafting these tokens
	// onto the replacement would stitch an old subscription onto a new key.
	// Discard the result and answer with what the store holds now.
	if cur != c {
		a.unlock()
		// Through the same admission the top of this function applies. resolve
		// promises a credential with a usable secret — publicToken leans on it,
		// and hands out `accessToken: ""` with a 200 if it is not true. A
		// replacement that is merely close to expiry is served as is: the next
		// call refreshes it, and the 401 path forces one sooner.
		if _, err := cur.secret(); err != nil {
			return nil, fmt.Errorf("credential %q: %w", id, err)
		}
		return cur, nil
	}
	// Copy-on-write: the map entry is replaced with a fresh struct carrying the
	// new token, rather than mutating the shared credential in place. Anyone who
	// read the old value earlier keeps an immutable snapshot, so the Token field
	// is never written to a struct another goroutine is reading.
	updated := *cur
	updated.Token = refreshed
	updated.UpdatedAt = time.Now().UnixMilli()
	a.creds[id] = &updated
	persistErr := a.persist()
	a.unlock()
	if persistErr != nil {
		// The refresh has already happened and the old refresh token is spent.
		// Returning an error here would take the upstream down while a usable
		// access token sits in memory, and it would not un-spend anything — so
		// serve the token and make the lost durability loud instead. The real
		// damage is that a restart inside this window comes back holding the
		// spent refresh token, which is what the operator has to see.
		logf("%s: refreshed, but the store could not be written: %v", id, persistErr)
	}
	return &updated, nil
}

// seedFromHost stores the credentials mounted into this container (the host's
// `claude login` / `codex login` files) under their kind as id, for a
// deployment that configures nothing: `claude` and `codex` are then already
// there to point a provider at.
//
// It never overwrites a stored credential. Signing in from the console, or
// importing on request, replaces the host copy on purpose — and a restart must
// not undo that.
func (a *manager) seedFromHost() {
	for kind, p := range a.provs {
		if _, exists := a.get(kind); exists {
			continue
		}
		pair, err := p.load()
		if err != nil {
			logf("%s: no credential to seed from: %v", kind, err)
			continue
		}
		if err := a.put(&credential{ID: kind, Kind: kind, Source: sourceHostFile, Token: pair}); err != nil {
			logf("%s: seeded in memory but not persisted: %v", kind, err)
			continue
		}
		logf("%s: seeded from the mounted credentials file", kind)
	}
}

// importFromHost re-reads a host credentials file into the store, on request
// from the console. This is how a subscription re-signed-in on the host gets
// back in after the manager has taken over its rotation.
func (a *manager) importFromHost(kind, id, label string) (*credential, error) {
	p, ok := a.provs[kind]
	if !ok {
		return nil, fmt.Errorf("kind %q cannot be imported from a file", kind)
	}
	pair, err := p.load()
	if err != nil {
		return nil, err
	}
	c := &credential{ID: id, Kind: kind, Label: label, Source: sourceImport, Token: pair}
	if err := a.put(c); err != nil {
		// The import itself succeeded: the host's file was read and the refresh
		// token is now in memory. Failing here would tell the operator the import
		// failed while a working credential sits in memory and the mounted file
		// is unchanged — a retry would just repeat the same write. Recorded for
		// /health (put sets storeErr) and logged; serve the credential.
		logf("imported %s in memory, but the store could not be written: %v", id, err)
	}
	return c, nil
}
