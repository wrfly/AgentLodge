# authkey-sync

Watches a JSON credentials file and keeps `/data/secrets/auth.key` — on a
volume shared with other containers — holding just the access token from it.
When the source file changes, the key is rewritten within one poll interval.

Both paths are fixed: it reads `/input/.credentials.json` and writes
`/data/secrets/auth.key`. Mounting is the only setup step — what you put behind
those two paths is your call.

```
CREDENTIALS_FILE                          AUTH_KEY_FILE
{"claudeAiOauth":{"accessToken":"abc"}} ──▶ abc      (no quotes, no trailing newline)
```

## Configuration

| Variable           | Default                     | Meaning                                           |
| ------------------ | --------------------------- | ------------------------------------------------- |
| `CREDENTIALS_FILE` | `/input/.credentials.json`  | JSON file to watch                                 |
| `AUTH_KEY_FILE`    | `/data/secrets/auth.key`    | File to write the token to                         |
| `TOKEN_JSON_PATH`  | `claudeAiOauth.accessToken` | Dotted path to the string to extract               |
| `POLL_INTERVAL`    | `2s`                        | How often the source is re-read (any Go duration)  |
| `AUTH_KEY_MODE`    | `0600`                      | Octal mode of the written key                      |
| `AUTH_KEY_OWNER`   | *(unset: leave as-is)*      | `uid:gid` to give the key, e.g. `10001:10001`      |

## Run it

```sh
CREDENTIALS_DIR=~/.claude docker compose up -d --build
```

That mounts `~/.claude` at `/input`, so `~/.claude/.credentials.json` lands on
the default source path with no configuration at all. To read a differently
named file, mount its directory at `/input` and set `CREDENTIALS_FILE`.

`compose.yml` declares the named volume `agent-secrets`, mounts it at
`/data/secrets` in both the syncer and an example consumer, and hands the key
to uid 10001. To use the key from your own service, mount the same volume
read-only and run as the same uid:

```yaml
services:
  your-service:
    user: "10001:10001"
    volumes:
      - agent-secrets:/data/secrets:ro
```

## Wiring it into AgentLodge

`docker/compose.yml` already has it. The shared volume `agentlodge-authkey` is written by this
service and mounted read-only into the gateway at `/data/secrets/authkey`, so the path to type
into the console's "upstream key → read from a file" field is:

```
/data/secrets/authkey/auth.key
```

A few decisions worth recording:

- What is mounted is a **subdirectory** of `/data/secrets`, not `/data/secrets` itself —
  mounting the parent would hide every key file already in `DATA_DIR/secrets`. The allowlist
  matches by prefix (`inside()` in `core/secret-file.ts`), so a subdirectory is read just fine.
- The volume goes to `gateway` only, not to `app`. `secret-file.ts` says why this is
  deliberate: the gateway is what actually reads the key, and one fewer process able to see a
  secret is better. The cost is that the console's dropdown cannot list the file, so the path
  is typed by hand and the `io` warning on save is expected — it warns without blocking. Add
  the same `:ro` mount to `app` if you would rather have the dropdown and the fingerprint.
- The key is owned by uid 10001, which is the uid the gateway runs as in `compose.docker.yml`.
- Temp files are named `.auth.key-*`, with a leading dot, so the console's directory listing
  skips them instead of offering half-written keys in a dropdown.

## Why it runs as root

Two permission walls meet here, and root is the only thing that clears both:

- The source is typically mode `0600` owned by *your* host user, so a container
  running as any other uid gets `permission denied` reading it.
- The key has to end up readable by the *consumer's* uid, which is a third uid
  again.

So the syncer runs as root, reads the source, and chowns the key to
`AUTH_KEY_OWNER` before publishing it. `compose.yml` drops every Linux
capability except the two this needs — `DAC_READ_SEARCH` to read the source and
`CHOWN` to hand off the key — and adds `read_only: true` and
`no-new-privileges`. The image is `scratch`: one static binary, no shell.

To run unprivileged instead, set `user:` to the uid that owns the credentials
file, drop `AUTH_KEY_OWNER` and `cap_add`, and set `AUTH_KEY_MODE=0644` so other
uids can read the key. That trades secrecy of the key for not being root.

## Things worth knowing

- **Mount the directory, not the file.** `~/.claude/.credentials.json` is
  replaced by rename, not edited in place. A single-file bind mount pins the
  original inode, so the container would keep serving the token the file held
  at startup, forever. `compose.yml` mounts the parent directory read-only for
  this reason.
- **A bad source never clobbers a good key.** If the file goes missing, is
  half-written, or loses the token, the error is logged once and the previous
  key is left in place. Repeated identical errors are not re-logged.
- **Writes are atomic.** The key is written to a temp file in the same
  directory, chmod-ed and chown-ed there, then renamed into place — so a
  consumer reading concurrently sees either the old token or the new one, never
  a truncated one or one with the wrong permissions.
- **The target is compared against disk, not a cached value**, so a recreated
  volume or an outside edit of `auth.key` is repaired on the next tick.
- **Polling, not inotify.** inotify events do not cross the bind-mount boundary
  reliably, and the file is small enough that re-reading it costs nothing.

## Development

```sh
go test ./...
```

`example/.credentials.json` is a placeholder holding a fake token, used as the
default source so `docker compose up` works with no setup.
