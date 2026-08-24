package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// persistentState is what gets written to disk, encrypted: the whole store,
// refresh tokens and pasted keys included. That is exactly why it is never
// written in the clear.
type persistentState struct {
	Credentials map[string]*credential `json:"credentials"`
}

// loadStateKey returns the 32-byte encryption key. Sources, in order: the
// CREDENTIAL_MANAGER_KEY environment variable (raw bytes, or hex / base64), a keyfile at
// CREDENTIAL_MANAGER_KEY_FILE, or a key generated and stored next to the state file. The
// last fallback exists so a first run "just works"; operators who want the
// state to survive container rebuilds should supply CREDENTIAL_MANAGER_KEY explicitly.
func loadStateKey() ([]byte, error) {
	if v := os.Getenv("CREDENTIAL_MANAGER_KEY"); v != "" {
		return normalizeKey([]byte(v))
	}
	if p := os.Getenv("CREDENTIAL_MANAGER_KEY_FILE"); p != "" {
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("read CREDENTIAL_MANAGER_KEY_FILE: %w", err)
		}
		return normalizeKey(raw)
	}
	// No explicit key: derive a stable key from the machine id / a generated
	// seed file, so restarts on the same host keep working.
	seedFile := os.Getenv("CREDENTIAL_MANAGER_KEY_SEED")
	if seedFile == "" {
		seedFile = filepath.Join(os.Getenv("HOME"), ".agentlodge", "credential-manager.key")
	}
	raw, err := os.ReadFile(seedFile)
	if err != nil {
		// Generate and persist a seed.
		seed := make([]byte, 32)
		if _, err := rand.Read(seed); err != nil {
			return nil, fmt.Errorf("generate key seed: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(seedFile), 0o700); err != nil {
			return nil, fmt.Errorf("mkdir seed dir: %w", err)
		}
		if err := os.WriteFile(seedFile, seed, 0o600); err != nil {
			return nil, fmt.Errorf("write key seed: %w", err)
		}
		return seed, nil
	}
	return normalizeKey(raw)
}

// normalizeKey coerces arbitrary key material to exactly 32 bytes by taking
// its hex/base64 decoding if plausible, otherwise hashing it.
func normalizeKey(raw []byte) ([]byte, error) {
	trimmed := raw
	if len(trimmed) >= 64 {
		if b, err := hex.DecodeString(string(trimmed[:64])); err == nil {
			return b, nil
		}
		if b, err := base64.StdEncoding.DecodeString(string(trimmed)); err == nil && len(b) == 32 {
			return b, nil
		}
	}
	if len(trimmed) == 32 {
		return trimmed, nil
	}
	sum := sha256.Sum256(trimmed)
	return sum[:], nil
}

// encryptState serialises and encrypts the state.
func encryptState(key []byte, state *persistentState) ([]byte, error) {
	plain, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plain, nil), nil
}

func decryptState(key, ciphertext []byte) (*persistentState, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce, ct := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	var state persistentState
	if err := json.Unmarshal(plain, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

// persist writes the store to the state file, encrypted. Called on every
// change, so a restart comes back to what the console last saw.
func (a *manager) persist() {
	if a.cfg.stateFile == "" || len(a.cfg.authKey) == 0 {
		return
	}
	state := &persistentState{Credentials: a.creds}
	ct, err := encryptState(a.cfg.authKey, state)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(a.cfg.stateFile), 0o700); err != nil {
		return
	}
	tmp := a.cfg.stateFile + ".tmp"
	if err := os.WriteFile(tmp, ct, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, a.cfg.stateFile)
}

// restore loads a previously persisted store.
func (a *manager) restore() error {
	raw, err := os.ReadFile(a.cfg.stateFile)
	if err != nil {
		return err
	}
	state, err := decryptState(a.cfg.authKey, raw)
	if err != nil {
		return err
	}
	for id, c := range state.Credentials {
		if c != nil {
			a.creds[id] = c
		}
	}
	return nil
}

// parseOwner reads a numeric "uid", "uid:gid" or ":gid" spec for
// CREDENTIAL_MANAGER_SOCKET_OWNER. Names are not accepted (the scratch image
// has no passwd database, so only ids are meaningful).
func parseOwner(spec string) (uid, gid int, err error) {
	uid, gid = keepOwner, keepOwner
	rawUID, rawGID, hasGID := strings.Cut(spec, ":")
	parse := func(s string) (int, error) {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("want numeric ids like 10001:10001, got %q", s)
		}
		return n, nil
	}
	if rawUID != "" {
		if uid, err = parse(rawUID); err != nil {
			return keepOwner, keepOwner, err
		}
	}
	if hasGID && rawGID != "" {
		if gid, err = parse(rawGID); err != nil {
			return keepOwner, keepOwner, err
		}
	}
	if uid == keepOwner && gid == keepOwner {
		return keepOwner, keepOwner, errors.New("no id given")
	}
	return uid, gid, nil
}
