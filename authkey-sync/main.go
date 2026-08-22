// Command authkey-sync keeps a plain-text auth key in sync with a JSON
// credentials file.
//
// Both paths are fixed by default -- /input/.credentials.json in, and
// /data/secrets/auth.key out -- so the mounts decide which host file is read
// and which volume the key lands on. It pulls a single string out of the source
// (claudeAiOauth.accessToken by default) and writes just that string to the
// target. The source is polled, so an update on the host -- including the
// rewrite-and-rename dance most credential writers use -- propagates within one
// poll interval.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultSource   = "/input/.credentials.json"
	defaultTarget   = "/data/secrets/auth.key"
	defaultJSONPath = "claudeAiOauth.accessToken"
	defaultInterval = 2 * time.Second
	defaultMode     = os.FileMode(0o600)
	// keepOwner is the os.Chown convention for "leave this id alone".
	keepOwner = -1
)

type config struct {
	source   string
	target   string
	jsonPath []string
	interval time.Duration
	mode     os.FileMode
	uid, gid int
}

func loadConfig() (config, error) {
	cfg := config{
		source:   envOr("CREDENTIALS_FILE", defaultSource),
		target:   envOr("AUTH_KEY_FILE", defaultTarget),
		jsonPath: strings.Split(envOr("TOKEN_JSON_PATH", defaultJSONPath), "."),
		interval: defaultInterval,
		mode:     defaultMode,
		uid:      keepOwner,
		gid:      keepOwner,
	}

	if v := os.Getenv("POLL_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return cfg, fmt.Errorf("POLL_INTERVAL %q: %w", v, err)
		}
		if d <= 0 {
			return cfg, fmt.Errorf("POLL_INTERVAL %q must be positive", v)
		}
		cfg.interval = d
	}

	if v := os.Getenv("AUTH_KEY_MODE"); v != "" {
		m, err := strconv.ParseUint(v, 8, 32)
		if err != nil {
			return cfg, fmt.Errorf("AUTH_KEY_MODE %q: want an octal mode like 0640: %w", v, err)
		}
		cfg.mode = os.FileMode(m)
	}

	if v := os.Getenv("AUTH_KEY_OWNER"); v != "" {
		uid, gid, err := parseOwner(v)
		if err != nil {
			return cfg, fmt.Errorf("AUTH_KEY_OWNER %q: %w", v, err)
		}
		cfg.uid, cfg.gid = uid, gid
	}

	for _, key := range cfg.jsonPath {
		if key == "" {
			return cfg, fmt.Errorf("TOKEN_JSON_PATH %q has an empty segment", strings.Join(cfg.jsonPath, "."))
		}
	}

	return cfg, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// parseOwner reads a numeric "uid", "uid:gid" or ":gid" spec. Names are not
// accepted: the consumer's user does not exist in this image's (empty) passwd
// database, so only ids are meaningful here.
func parseOwner(spec string) (uid, gid int, err error) {
	uid, gid = keepOwner, keepOwner

	rawUID, rawGID, hasGID := strings.Cut(spec, ":")
	parse := func(s string) (int, error) {
		n, err := strconv.Atoi(s)
		if err != nil {
			return 0, fmt.Errorf("want numeric ids like 10001:10001, got %q", s)
		}
		if n < 0 {
			return 0, fmt.Errorf("id %d is negative", n)
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

// extractToken walks a dotted path through the decoded JSON and returns the
// string found at the end of it.
func extractToken(raw []byte, path []string) (string, error) {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", fmt.Errorf("parse json: %w", err)
	}

	cur := doc
	for i, key := range path {
		obj, ok := cur.(map[string]any)
		if !ok {
			return "", fmt.Errorf("%q is not an object", strings.Join(path[:i], "."))
		}
		cur, ok = obj[key]
		if !ok {
			return "", fmt.Errorf("%q not found", strings.Join(path[:i+1], "."))
		}
	}

	token, ok := cur.(string)
	if !ok {
		return "", fmt.Errorf("%q is %T, want a string", strings.Join(path, "."), cur)
	}
	if token == "" {
		return "", fmt.Errorf("%q is empty", strings.Join(path, "."))
	}
	return token, nil
}

// writeAtomic replaces target in a single rename, so a reader never observes a
// half-written key, nor one that is briefly world-readable or owned by the
// wrong user.
func writeAtomic(cfg config, data []byte) error {
	dir := filepath.Dir(cfg.target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, ".auth.key-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	if err := tmp.Chmod(cfg.mode); err != nil {
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if cfg.uid != keepOwner || cfg.gid != keepOwner {
		if err := tmp.Chown(cfg.uid, cfg.gid); err != nil {
			return fmt.Errorf("chown temp file to %d:%d (only root may do this): %w", cfg.uid, cfg.gid, err)
		}
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmp.Name(), cfg.target); err != nil {
		return fmt.Errorf("rename onto %s: %w", cfg.target, err)
	}
	return nil
}

// syncOnce reads the source and refreshes the target if it drifted. It reports
// whether the target was rewritten.
func syncOnce(cfg config) (bool, error) {
	raw, err := os.ReadFile(cfg.source)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", cfg.source, err)
	}

	token, err := extractToken(raw, cfg.jsonPath)
	if err != nil {
		return false, fmt.Errorf("%s: %w", cfg.source, err)
	}

	// Compare against what is on disk rather than against a cached value, so a
	// recreated volume or an outside edit of the target is repaired too.
	if current, err := os.ReadFile(cfg.target); err == nil && string(current) == token {
		return false, nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("read %s: %w", cfg.target, err)
	}

	if err := writeAtomic(cfg, []byte(token)); err != nil {
		return false, err
	}
	return true, nil
}

func run(ctx context.Context, cfg config) error {
	log.Printf("watching %s (%s) -> %s every %s",
		cfg.source, strings.Join(cfg.jsonPath, "."), cfg.target, cfg.interval)

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	// lastErr keeps a missing or malformed source file from filling the log
	// with the same line every tick.
	var lastErr string
	for {
		updated, err := syncOnce(cfg)
		switch {
		case err != nil:
			if msg := err.Error(); msg != lastErr {
				log.Printf("sync failed: %v", err)
				lastErr = msg
			}
		case updated:
			log.Printf("wrote %s", cfg.target)
			lastErr = ""
		default:
			lastErr = ""
		}

		select {
		case <-ctx.Done():
			log.Print("shutting down")
			return nil
		case <-ticker.C:
		}
	}
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg); err != nil {
		log.Fatal(err)
	}
}
