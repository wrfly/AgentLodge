package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// A key held in a file somebody else writes.
//
// The case this exists for: the key is not something a person types. It comes out of a
// docker/podman secret, a cloud secret-manager sidecar, or another container writing into
// a shared volume — and **that** thing rotates it. So what is stored here is a path, and
// the file is read at the moment the key is needed; the next request after a rotation
// already uses the new value, with nothing to restart and nobody to remember.
//
// The cost is that the path becomes administrator-controlled input, and whatever is read
// goes out as Authorization to an upstream address the administrator also chose. "Any
// path" would therefore mean an administrator can ship any file in this container — the
// credential store, its encryption key, the mounted credentials file — to a server of
// their choosing. Hence the roots below.

const (
	// Real keys are on the order of 100 bytes. The ceiling stops a slip that points at
	// something large enough to be interesting.
	maxKeyFileBytes = 16 * 1024
	// Listing limits, so a large mounted volume cannot stall the console.
	maxListDepth   = 3
	maxListEntries = 200
)

// keyFileRoots are the directories a key may be read from, colon-separated like PATH in
// CREDENTIAL_FILE_ROOTS. The default is where docker and podman put secrets.
func keyFileRoots() []string {
	raw := envOr("CREDENTIAL_FILE_ROOTS", "/run/secrets")
	var out []string
	for _, p := range strings.Split(raw, ":") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, filepath.Clean(p))
		}
	}
	return out
}

// realOrSelf resolves symlinks, falling back to the path itself when that fails
// (missing, no permission) so the checks below can report the real reason.
func realOrSelf(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

func inside(child, parent string) bool {
	// CREDENTIAL_FILE_ROOTS=/ is how "no restriction" is written; joining a separator
	// onto that root would give "//", so it needs its own case.
	if parent == string(filepath.Separator) {
		return strings.HasPrefix(child, string(filepath.Separator))
	}
	return child == parent || strings.HasPrefix(child, parent+string(filepath.Separator))
}

// keyFileInfo is what the console may see about a key file: everything except the value.
type keyFileInfo struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	MTime string `json:"mtime"`
	// First 8 hex digits of the contents' sha256. Answers "did the file I just replaced
	// reach this process" without revealing anything.
	Fingerprint string `json:"fingerprint"`
	Hint        string `json:"hint"`
}

// readKeyFile validates the path and reads the value.
//
// Every failure comes back as an error the console shows verbatim: "cannot read it" and
// "read it and it was empty" are entirely different things to act on.
func readKeyFile(input string) (string, *keyFileInfo, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return "", nil, fmt.Errorf("no path given")
	}
	if !filepath.IsAbs(raw) {
		return "", nil, fmt.Errorf("must be an absolute path, as seen inside this container")
	}

	// Clean folds away `..`, so the prefix check cannot be walked around with
	// /run/secrets/../../etc/shadow
	abs := filepath.Clean(raw)
	roots := keyFileRoots()
	allowed := false
	for _, r := range roots {
		if inside(abs, r) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", nil, fmt.Errorf("not in an allowed directory (readable: %s)", strings.Join(roots, ", "))
	}

	st, err := os.Stat(abs)
	if err != nil {
		switch {
		case os.IsNotExist(err):
			return "", nil, fmt.Errorf("no such file: %s", abs)
		case os.IsPermission(err):
			return "", nil, fmt.Errorf("no permission to read %s", abs)
		default:
			return "", nil, fmt.Errorf("cannot read %s: %w", abs, err)
		}
	}

	// A symlink can point outside the allowlist, so the resolved path is checked again.
	// The earlier check still earns its place: a path that is not in the allowlist at all
	// deserves to be told so rather than stat'ed first.
	real := realOrSelf(abs)
	allowed = false
	for _, r := range roots {
		if inside(real, realOrSelf(r)) {
			allowed = true
			break
		}
	}
	if !allowed {
		return "", nil, fmt.Errorf("a symlink pointing outside the allowlist (it resolves to %s)", real)
	}

	if st.IsDir() {
		return "", nil, fmt.Errorf("%s is a directory — point at a file", abs)
	}
	if !st.Mode().IsRegular() {
		return "", nil, fmt.Errorf("%s is not a regular file", abs)
	}
	if st.Size() > maxKeyFileBytes {
		return "", nil, fmt.Errorf("%s is too large (%d bytes); a key file should not exceed %d", abs, st.Size(), maxKeyFileBytes)
	}

	body, err := os.ReadFile(abs)
	if err != nil {
		return "", nil, fmt.Errorf("read %s: %w", abs, err)
	}

	// A BOM plus surrounding whitespace: `echo key > f` leaves a newline and is the most
	// common way to write one of these, so it has to be tolerated.
	value := strings.TrimSpace(strings.TrimPrefix(string(body), "\ufeff"))
	if value == "" {
		return "", nil, fmt.Errorf("%s is empty", abs)
	}

	// The value ends up as an HTTP header. A newline in it fails a long way from the
	// configuration that caused it — and while we are here, name the likely mistake.
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return "", nil, fmt.Errorf(
				"%s is not a single-line token (there are newlines or control characters); this wants the key itself, not a JSON credentials file", abs)
		}
	}

	sum := sha256.Sum256([]byte(value))
	return value, &keyFileInfo{
		Path:        abs,
		Size:        st.Size(),
		MTime:       st.ModTime().UTC().Format(time.RFC3339),
		Fingerprint: hex.EncodeToString(sum[:])[:8],
		Hint:        hint(value),
	}, nil
}

// rootView is one allowlisted directory, as the console draws it.
type rootView struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	Note   string `json:"note,omitempty"`
}

// listKeyFiles is what is actually in the allowlisted directories.
//
// A hand-typed path is easy to get wrong, and getting it wrong surfaces as an upstream
// 401 — too long a chain to debug from. Listing what is there lets it be picked instead.
func listKeyFiles() (roots []rootView, files []map[string]any) {
	budget := maxListEntries
	roots = []rootView{}
	files = []map[string]any{}

	for _, root := range keyFileRoots() {
		st, err := os.Stat(root)
		ok := err == nil && st.IsDir()
		view := rootView{Path: root, Exists: ok}
		if !ok {
			view.Note = "missing or unreadable — mount it and it appears here"
		}
		roots = append(roots, view)
		if !ok {
			continue
		}

		var walk func(dir string, depth int)
		walk = func(dir string, depth int) {
			if depth > maxListDepth || budget <= 0 {
				return
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				return
			}
			sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
			for _, e := range entries {
				if budget <= 0 {
					return
				}
				if strings.HasPrefix(e.Name(), ".") {
					continue
				}
				full := filepath.Join(dir, e.Name())
				st, err := os.Stat(full)
				if err != nil {
					continue
				}
				if st.IsDir() {
					walk(full, depth+1)
					continue
				}
				budget--
				if _, info, err := readKeyFile(full); err == nil {
					files = append(files, map[string]any{
						"path": info.Path, "size": info.Size, "mtime": info.MTime,
						"fingerprint": info.Fingerprint, "hint": info.Hint, "usable": true,
					})
				} else {
					files = append(files, map[string]any{"path": full, "usable": false, "error": err.Error()})
				}
			}
		}
		walk(root, 0)
	}
	return roots, files
}
