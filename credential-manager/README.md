# credential-manager

The credential authority for AgentLodge. It is the **only** process that holds
upstream credentials: pasted API keys, paths to key files another process writes,
and the refresh tokens behind Claude (claude.ai) and Codex (ChatGPT)
subscriptions. It mints access tokens before
they expire, keeps what it holds encrypted at rest, and hands out only
short-lived values over a Unix domain socket.

A consumer names a credential by **id** and gets back an access token. It never
sees a refresh token, so a compromise of the console, the database or the
gateway is not a compromise of the subscription.

## Interfaces

```
Unix socket (CREDENTIAL_MANAGER_SOCKET, mode 0600):
  GET    /health                  -> { status, ready, credentials: {id: {...}} }
  GET    /credentials             -> [{ id, kind, source, hint, expiresAt, … }]
  POST   /credentials             -> store a pasted key
                                     {"id","kind":"api-key","label","apiKey"}
  POST   /credentials/import      -> copy a mounted host credentials file in
                                     {"id","kind":"claude"|"codex","label"}
  DELETE /credentials?id=X        -> forget one
  POST   /login/start             -> begin a subscription sign-in
                                     {"kind":"claude","id","label"}
                                     -> { loginId, authorizeUrl, expiresAt }
  POST   /login/finish            -> complete it with the pasted code
                                     {"loginId","code"}
  GET    /token?credential=X      -> { credential, kind, accessToken, expiresAt }
  POST   /token/refresh           -> the same, forcing a mint first
                                     {"credential":"X"}
```

Nothing here ever returns a stored value: a listing carries a masked hint
(`sk-ant-a…cdef`) and an expiry, and that is all the console is shown.

## The four kinds, and how each gets in

**Signing in** (`/login/*`) is the ordinary one, and it is two steps because the
authorising happens in a browser this process does not have. `start` returns an
authorize URL; the operator approves there and the redirect lands on a page
showing a code; `finish` takes that code — `code#state`, as the page prints it —
and exchanges it. PKCE throughout: the verifier is generated here, never leaves,
and the `state` is checked on the way back. This is the same flow `claude login`
uses when it cannot open a browser itself; there is no device-code grant to use
instead.

The endpoints are the ones that CLI uses, and they are not guessable from one
another: authorising happens on `claude.com`, the redirect lands on
`platform.claude.com`, and the token endpoint is a third address again. Both
halves of the exchange — code and refresh — are JSON bodies, not form encoding.

**Pasting a key** (`POST /credentials` with `kind: "api-key"`) is for an ordinary
API key. A subscription cannot be typed in.

**Naming a file** (`POST /credentials` with `kind: "key-file"`) stores a path and
nothing else. The file is read again every time a token is asked for, so whatever
writes it — a docker secret, a secret-manager sidecar, another container sharing a
volume — can rotate it and the next request uses the new value.

Readable directories are an allowlist: `CREDENTIAL_FILE_ROOTS`, colon-separated
like PATH, default `/run/secrets`. The path is administrator input and whatever is
read goes out as Authorization to an address the administrator also chose, so
without the allowlist "any path" would mean any file in this container can be sent
to any server. A path outside it, a relative path, or a symlink resolving outside
it is refused when it is stored. `GET /files` lists what is actually there, with a
fingerprint (first 8 hex of the contents' sha256) so a replaced file can be
confirmed to have reached this process.

**Importing** (`/credentials/import`) copies a credentials file mounted into
this container, which is the host's own `claude login` / `codex login` output:

- **claude** — `CLAUDE_CREDENTIALS_FILE` (`~/.claude/.credentials.json`), with a
  fallback to the macOS Keychain (`Claude Code-credentials`). It reads the
  `claudeAiOauth` block: `accessToken`, `refreshToken`, `expiresAt` (unix ms),
  `refreshTokenExpiresAt`, `scopes`, `clientId`.
- **codex** — `~/.codex/auth.json` (`CODEX_HOME`), reading `tokens.access_token`,
  `tokens.refresh_token`, `tokens.account_id`.

Those two files also **seed** the store on first start, so a deployment that
configures nothing still has `claude` and `codex` to point a provider at. Seeding
never overwrites what is stored: signing in from the console replaces the host
copy on purpose, and a restart must not undo that.

Once a subscription is in here, this service owns its rotation. The token
endpoint hands out a new refresh token as it goes and the host's file keeps the
old one, so re-running `claude login` on the host changes nothing here until it
is imported again — and, the other way round, the host's copy goes stale. Decide
which side owns a subscription and leave it there.

## Refreshing

A background ticker mints any token within `REFRESH_LEAD_SECONDS` of expiry, so
`/token` almost always answers from what is already held with no upstream call.
A 401 upstream makes the gateway call `/token/refresh`, which forces a mint
before its single retry.

A refresh that fails while the current token is still valid is not an error —
the token endpoint being briefly unreachable should not take the upstream down
with it. A token endpoint `invalid_grant` means the refresh token is dead: sign
in again from the console, or `claude login` on the host and import.

## Persistence (encrypted at rest)

The store is written to `CREDENTIAL_MANAGER_STATE_FILE` under AES-256-GCM. The
key comes from, in order:

1. `CREDENTIAL_MANAGER_KEY` — a 32-byte key (raw, hex, or base64);
2. `CREDENTIAL_MANAGER_KEY_FILE` — a file containing that key;
3. otherwise a generated seed at `CREDENTIAL_MANAGER_KEY_SEED`.

The seed makes a first run work with no configuration, and it is worth being
clear about what it does not do: kept in the same volume as the ciphertext, it
protects nothing against someone holding that volume. Supply
`CREDENTIAL_MANAGER_KEY` from the deployment's own secret store to get the
property the encryption is there for.

With no state file configured, the store lives only in memory and comes back
from the seed files on each start.

## Configuration

| Variable                             | Default                                      | Meaning                                       |
| ------------------------------------ | -------------------------------------------- | --------------------------------------------- |
| `CREDENTIAL_MANAGER_SOCKET`          | `/run/agentlodge/credential-manager.sock`    | Unix socket consumers dial                    |
| `CREDENTIAL_MANAGER_SOCKET_OWNER`    | *(leave as-is)*                              | `uid:gid` the socket is handed to             |
| `CLAUDE_CREDENTIALS_FILE`            | `~/.claude/.credentials.json`                | Claude seed / import source                   |
| `CLAUDE_OAUTH_CLIENT_ID`             | `9d1c250a-…`                                 | client_id for sign-in and refresh             |
| `CLAUDE_OAUTH_TOKEN_URL`             | `https://platform.claude.com/v1/oauth/token` | Claude token endpoint                         |
| `CLAUDE_OAUTH_AUTHORIZE_URL`         | `https://claude.com/cai/oauth/authorize`     | where the operator authorises                 |
| `CLAUDE_OAUTH_REDIRECT_URI`          | `https://platform.claude.com/oauth/code/callback` | where that redirect lands             |
| `CLAUDE_OAUTH_SCOPES`                | the six `claude login` asks for              | scopes requested                              |
| `CODEX_HOME`                         | `~/.codex`                                   | directory holding `auth.json`                 |
| `CREDENTIAL_FILE_ROOTS`              | `/run/secrets`                               | directories a `key-file` may point into       |
| `OPENAI_OAUTH_TOKEN_URL`             | `https://auth.openai.com/oauth/token`        | Codex token endpoint                          |
| `OPENAI_OAUTH_CLIENT_ID`             | `app_EMoamEEZ…`                              | Codex client id                               |
| `OPENAI_OAUTH_AUTHORIZE_URL`         | *(unset: Codex is import-only)*              | set it to offer Codex sign-in too             |
| `REFRESH_LEAD_SECONDS`               | `60`                                         | mint this many seconds before expiry          |
| `HTTP_TIMEOUT`                       | `30s`                                        | token endpoint timeout                        |
| `CREDENTIAL_MANAGER_STATE_FILE`      | *(unset: memory only)*                       | encrypted store path                          |
| `CREDENTIAL_MANAGER_KEY` / `_KEY_FILE` | *(generated seed)*                         | encryption key                                |
| `CREDENTIAL_MANAGER_KEY_SEED`        | `~/.agentlodge/credential-manager.key`       | where the generated seed is kept              |

## Security

- The socket is mode `0600` and handed to one uid, so only the container it is
  mounted into can ask for a token. There is no authentication on it and none is
  needed: it is on no network.
- Consumers receive access tokens only. A refresh token never crosses the
  socket, in either direction.
- In `docker/compose.yml` the container runs `read_only`, drops every capability
  except `DAC_READ_SEARCH` (read the host user's 0600 credentials file) and
  `CHOWN` (hand the socket over), and sits on one network with a single purpose:
  reaching the token endpoints it mints against. It listens on no port.

## Run it

```sh
CLAUDE_CREDENTIALS_DIR=~/.claude docker compose up -d --build
```

Mount the credential **directory**, never the file: `claude login` replaces the
file by rename, and a single-file bind mount pins the old inode.

## Development

```sh
go test ./...
```

`example/.credentials.json` is a placeholder used by the default source, so
nothing has to be configured to see the service start.
