package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractToken(t *testing.T) {
	path := strings.Split(defaultJSONPath, ".")

	tests := []struct {
		name    string
		raw     string
		want    string
		wantErr string
	}{
		{
			name: "documented shape",
			raw:  `{"claudeAiOauth": {"accessToken": "abc"}}`,
			want: "abc",
		},
		{
			name: "ignores sibling fields",
			raw:  `{"other": 1, "claudeAiOauth": {"refreshToken": "r", "accessToken": "abc", "expiresAt": 123}}`,
			want: "abc",
		},
		{
			name:    "missing leaf",
			raw:     `{"claudeAiOauth": {"refreshToken": "r"}}`,
			wantErr: `"claudeAiOauth.accessToken" not found`,
		},
		{
			name:    "missing parent",
			raw:     `{"other": {}}`,
			wantErr: `"claudeAiOauth" not found`,
		},
		{
			name:    "parent is not an object",
			raw:     `{"claudeAiOauth": "nope"}`,
			wantErr: `"claudeAiOauth" is not an object`,
		},
		{
			name:    "leaf is not a string",
			raw:     `{"claudeAiOauth": {"accessToken": 42}}`,
			wantErr: `want a string`,
		},
		{
			name:    "empty leaf",
			raw:     `{"claudeAiOauth": {"accessToken": ""}}`,
			wantErr: `is empty`,
		},
		{
			name:    "invalid json",
			raw:     `{`,
			wantErr: `parse json`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := extractToken([]byte(tc.raw), path)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("got %q, want error containing %q", got, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("got error %v, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExtractTokenCustomPath(t *testing.T) {
	got, err := extractToken([]byte(`{"a": {"b": {"c": "deep"}}}`), []string{"a", "b", "c"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "deep" {
		t.Fatalf("got %q, want %q", got, "deep")
	}
}

func newConfig(t *testing.T, dir string) config {
	t.Helper()
	return config{
		source:   filepath.Join(dir, "credentials.json"),
		target:   filepath.Join(dir, "secrets", "auth.key"),
		jsonPath: strings.Split(defaultJSONPath, "."),
		interval: defaultInterval,
		mode:     defaultMode,
		uid:      keepOwner,
		gid:      keepOwner,
	}
}

func writeSource(t *testing.T, cfg config, token string) {
	t.Helper()
	body := `{"claudeAiOauth": {"accessToken": "` + token + `"}}`
	if err := os.WriteFile(cfg.source, []byte(body), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
}

func readTarget(t *testing.T, cfg config) string {
	t.Helper()
	got, err := os.ReadFile(cfg.target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	return string(got)
}

func TestSyncOnce(t *testing.T) {
	dir := t.TempDir()
	cfg := newConfig(t, dir)

	// First run creates the target directory and file.
	writeSource(t, cfg, "abc")
	updated, err := syncOnce(cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !updated {
		t.Fatal("first sync reported no update")
	}
	if got := readTarget(t, cfg); got != "abc" {
		t.Fatalf("got %q, want %q", got, "abc")
	}

	info, err := os.Stat(cfg.target)
	if err != nil {
		t.Fatalf("stat target: %v", err)
	}
	if info.Mode().Perm() != defaultMode {
		t.Fatalf("got mode %o, want %o", info.Mode().Perm(), defaultMode)
	}

	// An unchanged source is a no-op.
	updated, err = syncOnce(cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated {
		t.Fatal("second sync rewrote an unchanged key")
	}

	// A rotated token propagates.
	writeSource(t, cfg, "xyz")
	updated, err = syncOnce(cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !updated {
		t.Fatal("rotated token was not written")
	}
	if got := readTarget(t, cfg); got != "xyz" {
		t.Fatalf("got %q, want %q", got, "xyz")
	}

	// A target deleted underneath us is restored.
	if err := os.Remove(cfg.target); err != nil {
		t.Fatalf("remove target: %v", err)
	}
	if _, err := syncOnce(cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := readTarget(t, cfg); got != "xyz" {
		t.Fatalf("got %q, want %q", got, "xyz")
	}
}

func TestSyncOnceKeepsLastGoodKey(t *testing.T) {
	dir := t.TempDir()
	cfg := newConfig(t, dir)

	writeSource(t, cfg, "abc")
	if _, err := syncOnce(cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// A truncated or half-written source must not clobber a working key.
	if err := os.WriteFile(cfg.source, []byte(`{"claudeAiOauth":`), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	if _, err := syncOnce(cfg); err == nil {
		t.Fatal("want an error for malformed json")
	}
	if got := readTarget(t, cfg); got != "abc" {
		t.Fatalf("got %q, want the previous key %q", got, "abc")
	}

	// So must a source that disappears.
	if err := os.Remove(cfg.source); err != nil {
		t.Fatalf("remove source: %v", err)
	}
	if _, err := syncOnce(cfg); err == nil {
		t.Fatal("want an error for a missing source")
	}
	if got := readTarget(t, cfg); got != "abc" {
		t.Fatalf("got %q, want the previous key %q", got, "abc")
	}
}

func TestLoadConfig(t *testing.T) {
	// Nothing set: both paths come from the defaults, and the mounts decide
	// what sits behind them.
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.source != defaultSource {
		t.Fatalf("got source %q, want %q", cfg.source, defaultSource)
	}
	if cfg.target != defaultTarget {
		t.Fatalf("got target %q, want %q", cfg.target, defaultTarget)
	}
	if strings.Join(cfg.jsonPath, ".") != defaultJSONPath {
		t.Fatalf("got path %v, want %q", cfg.jsonPath, defaultJSONPath)
	}
	if cfg.interval != defaultInterval || cfg.mode != defaultMode {
		t.Fatalf("got interval %s mode %o", cfg.interval, cfg.mode)
	}
	if cfg.uid != keepOwner || cfg.gid != keepOwner {
		t.Fatalf("got owner %d:%d, want the file left alone", cfg.uid, cfg.gid)
	}

	t.Setenv("CREDENTIALS_FILE", "/elsewhere/creds.json")
	t.Setenv("POLL_INTERVAL", "10s")
	t.Setenv("AUTH_KEY_MODE", "640")
	t.Setenv("TOKEN_JSON_PATH", "a.b")
	cfg, err = loadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.source != "/elsewhere/creds.json" {
		t.Fatalf("got source %q, want the override", cfg.source)
	}
	if cfg.interval.String() != "10s" {
		t.Fatalf("got interval %s, want 10s", cfg.interval)
	}
	if cfg.mode != 0o640 {
		t.Fatalf("got mode %o, want 640", cfg.mode)
	}
	if strings.Join(cfg.jsonPath, ".") != "a.b" {
		t.Fatalf("got path %v, want a.b", cfg.jsonPath)
	}
}

func TestLoadConfigRejectsBadInput(t *testing.T) {
	t.Run("bad interval", func(t *testing.T) {
		t.Setenv("POLL_INTERVAL", "soon")
		if _, err := loadConfig(); err == nil {
			t.Fatal("want an error for an unparseable interval")
		}
	})

	t.Run("bad owner", func(t *testing.T) {
		t.Setenv("AUTH_KEY_OWNER", "claude:claude")
		if _, err := loadConfig(); err == nil {
			t.Fatal("want an error for a non-numeric owner")
		}
	})

	t.Run("empty path segment", func(t *testing.T) {
		t.Setenv("TOKEN_JSON_PATH", "a..b")
		if _, err := loadConfig(); err == nil {
			t.Fatal("want an error for an empty path segment")
		}
	})
}

func TestParseOwner(t *testing.T) {
	tests := []struct {
		spec     string
		uid, gid int
		wantErr  bool
	}{
		{spec: "10001:10001", uid: 10001, gid: 10001},
		{spec: "10001", uid: 10001, gid: keepOwner},
		{spec: "10001:", uid: 10001, gid: keepOwner},
		{spec: ":10001", uid: keepOwner, gid: 10001},
		{spec: "0:0", uid: 0, gid: 0},
		{spec: "claude", wantErr: true},
		{spec: "10001:claude", wantErr: true},
		{spec: "-1", wantErr: true},
		{spec: ":", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.spec, func(t *testing.T) {
			uid, gid, err := parseOwner(tc.spec)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("got %d:%d, want an error", uid, gid)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if uid != tc.uid || gid != tc.gid {
				t.Fatalf("got %d:%d, want %d:%d", uid, gid, tc.uid, tc.gid)
			}
		})
	}
}

// A chown the process is not allowed to make must fail loudly rather than
// leave a key nobody can read.
func TestSyncOnceReportsChownFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root, where the chown would succeed")
	}

	dir := t.TempDir()
	cfg := newConfig(t, dir)
	cfg.uid, cfg.gid = 0, 0
	writeSource(t, cfg, "abc")

	if _, err := syncOnce(cfg); err == nil {
		t.Fatal("want an error when the chown is not permitted")
	}
	if _, err := os.Stat(cfg.target); !os.IsNotExist(err) {
		t.Fatalf("target should not exist, stat gave %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(cfg.target))
	if err != nil {
		t.Fatalf("read target dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}
