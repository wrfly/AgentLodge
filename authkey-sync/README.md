# auther

The credential authority for the AgentLodge gateway. It is the **only** process
that holds upstream subscription refresh tokens (Claude / claude.ai and Codex /
ChatGPT). It refreshes access tokens proactively before they expire, persists
the rotated tokens encrypted at rest, and serves the current token to consumers.

A consumer never sees a refresh token — it only ever receives a short-lived
access token, over a Unix domain socket and/or as a single-line file drop.

## Interfaces

```
Unix socket (AUTHER_SOCKET, mode 0600):
  GET  /health              -> { status, ready, providers:{claude:{ok,expiresAt},...} }
  GET  /token?provider=X    -> { provider, accessToken, expiresAt, accountId? }
  POST /token/refresh       -> same shape, forces a refresh
                               body: {"provider":"claude"}

Optional file drop (AUTH_KEY_FILE), for consumers that read a key from a file
(e.g. the AgentLodge app-gateway's core/secret-file.ts): the current claude
access token, written atomically as a single line.
```

The gateway (`credential-proxy`) calls the socket; the AgentLodge app-gateway
can keep reading the file drop, so both integration styles work against the same
authoritative token.

## How it works

On startup the auther loads each provider's credential from its backing store:

- **claude** — `CLAUDE_CREDENTIALS_FILE` (`~/.claude/.credentials.json`), with a
  fallback to the macOS Keychain (`Claude Code-credentials`). It reads the
  `claudeAiOauth` block: `accessToken`, `refreshToken`, `expiresAt` (unix ms),
  `refreshTokenExpiresAt`, `scopes`, `clientId`.
- **codex** — `~/.codex/auth.json` (`CODEX_HOME`), reading `tokens.access_token`,
  `tokens.refresh_token`, `tokens.account_id`.

A background ticker pre-refreshes any token within `REFRESH_LEAD_SECONDS` of
expiry, so `/token` almost always returns a cached, valid value with no upstream
call. A 401 upstream causes the gateway to call `/token/refresh`, which forces a
fresh mint before the single retry.

The refresh token is treated as rotatable: when the token endpoint returns a new
one it is kept, otherwise the old one is retained (matching the CLIs' own
behaviour). A token endpoint `invalid_grant` means the refresh token is dead —
the auther then fails to mint and the operator must re-run `claude login` /
`codex login` on the host.

## Persistence (encrypted at rest)

When `AUTHER_STATE_FILE` is set, the rotated tokens (including refresh tokens,
which is why encryption matters) are written there under AES-256-GCM. The key
comes from, in order:

1. `AUTHER_KEY` — a 32-byte key (raw, hex, or base64);
2. `AUTHER_KEY_FILE` — a file containing that key;
3. otherwise a generated seed at `~/.agentlodge/auther.key` (survives restarts
   on the same host, but not container rebuilds — supply `AUTHER_KEY` for that).

Without `AUTHER_STATE_FILE`, the auther re-reads the credential files on startup
instead; the encryption machinery is still used to derive the key so the flag
being absent degrades to "load from disk".

## Configuration

| Variable                 | Default                                    | Meaning                                          |
| ------------------------ | ------------------------------------------ | ------------------------------------------------ |
| `AUTHER_SOCKET`          | `/run/agentlodge/auther.sock`              | Unix socket the gateway dials                    |
| `CLAUDE_CREDENTIALS_FILE`| `~/.claude/.credentials.json`              | Claude credential source                         |
| `CLAUDE_OAUTH_CLIENT_ID` | `9d1c250a-…`                               | client_id used when the file has none            |
| `CLAUDE_OAUTH_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token`| Claude refresh endpoint                          |
| `CLAUDE_OAUTH_SCOPES`    | *(file's scopes)*                          | fallback scopes when the file has none           |
| `CODEX_HOME`             | `~/.codex`                                 | directory holding `auth.json`                    |
| `OPENAI_OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token`      | Codex refresh endpoint                           |
| `OPENAI_OAUTH_CLIENT_ID` | `app_EMoamEEZ…`                            | Codex client id                                  |
| `REFRESH_LEAD_SECONDS`   | `60`                                       | pre-refresh this many seconds before expiry      |
| `HTTP_TIMEOUT`           | `30s`                                      | token endpoint timeout                           |
| `AUTH_KEY_FILE`          | *(unset: no file drop)*                    | where to publish the access token as a file      |
| `AUTH_KEY_MODE`          | `0600`                                     | mode of the published file                       |
| `AUTH_KEY_OWNER`         | *(leave as-is)*                            | `uid:gid` for the published file                 |
| `AUTHER_STATE_FILE`      | *(unset: no persistence)*                  | encrypted at-rest state path                     |
| `AUTHER_KEY` / `AUTHER_KEY_FILE` | *(generated seed)*                  | encryption key                                   |

## Security

- The socket is mode `0600`, in a directory the container and the gateway share;
  other host processes cannot connect.
- The gateway (`credential-proxy`) receives only access tokens, never a refresh
  token, so a compromise of the gateway cannot exfiltrate the long-lived
  credential.
- Persisted state is AES-256-GCM; without `AUTHER_KEY` it is keyed by a host
  seed file.
- In `docker/compose.yml` the container runs `read_only`, drops all capabilities
  except `DAC_READ_SEARCH` (read the host user's 0600 credential file) and
  `CHOWN` (hand the file drop to the consumer's uid), and has `network_mode:
  none` — it holds a refresh token, so it can reach as little as possible.

## Run it

```sh
CLAUDE_CREDENTIALS_DIR=~/.claude docker compose up -d --build
```

Mount the credential **directory**, never the file: `claude login` replaces the
file by rename, and a single-file bind mount pins the old inode so the auther
would keep serving the token from the moment it started.

## Development

```sh
go test ./...
```

`example/.credentials.json` is a placeholder used by the default source so
nothing has to be configured to see the auther start.
