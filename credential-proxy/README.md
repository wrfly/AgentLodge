# credential-proxy — a credential-injecting proxy

A TypeScript rewrite of `llm-auth-gateway` (Python/FastAPI).

> **Not the same thing as AgentLodge's metering gateway** (`apps/server/src/gateway`), despite
> the similar name. The metering gateway knows **who** is calling — the ticket carries a
> userId — and bills per person, enforces per-user quotas, and queues fairly. This service has
> one fixed `GATEWAY_TOKEN`, so every caller shares a single identity: it looks after **keys**,
> not people. The two chain happily, with the metering gateway pointing at this one as its
> upstream.

## What it is for

Callers — including CLIs inside containers — **hold no upstream key at all**, only a
`GATEWAY_TOKEN`. The real credentials exist solely in the **credential manager** sidecar, never in this
process; this gateway receives only short-lived access tokens over a Unix socket:

```
container / caller ──GATEWAY_TOKEN──▶ credential-proxy ──▶ upstream
                                            │
                          ┌─────────────────┼─────────────────┐
                          ▼                 ▼                 ▼
                    DeepSeek           Anthropic            Codex
                  your API key       credential manager (claude)    credential manager (codex)
                                       over UDS            over UDS
```

## Routing

| Path | Goes to | Credential source |
|---|---|---|
| `/v1/messages*`, `/v1/complete` | `api.anthropic.com` | credential manager `/token?provider=claude` |
| `/v1/responses*` | `chatgpt.com/backend-api/codex` | credential manager `/token?provider=codex` |
| everything else under `/v1/*` | `api.deepseek.com` | `DEEPSEEK_API_KEY` |

An `x-gateway-provider: deepseek\|anthropic\|codex` header overrides the inference.

## What changed from the Python version

**Added: usage metering that actually meters.** The original had a concurrency semaphore and
no accounting whatsoever. Usage is now pulled out of the stream as it is forwarded, appended
to JSONL, and summarised in memory:

```bash
curl -H "Authorization: Bearer $GATEWAY_TOKEN" http://127.0.0.1:8795/usage
```

All three upstreams hide usage somewhere different, and all three are handled — see the
comment at the top of `src/usage.ts`. Anthropic splits it across `message_start` and
`message_delta` (output is cumulative, so take the maximum rather than the sum); OpenAI puts
it at the top level; Codex reports it in `response.completed`.

**Removed: `rewrite_system_for_billing`.** When the caller was not Claude Code, the original
demoted their real system prompt into a user message, forged a `You are Claude Code` preamble
and an `x-anthropic-billing-header`, all so Anthropic's billing classifier would read the
traffic as the official CLI. This version **injects authentication and nothing else** — no
rewritten request bodies, no forged identity headers.

Running the real Claude Code or Codex CLI inside a container is unaffected: those headers come
from the CLI itself, and the gateway passes them through as they are.

**What changed from the old single-process design**: the credential stores (file →
Keychain → env fallback, refresh-on-401) moved out of this process into the credential manager. This
gateway now calls the credential manager over a Unix socket, gets back an access token, and keeps the
single retry-on-401. The concurrency semaphore and metering are unchanged.

## Running it

The credential manager must be reachable at `CREDENTIAL_MANAGER_SOCKET` before this gateway can serve `/v1/messages`
or `/v1/responses` (DeepSeek works without it). Dependencies resolve upwards from the
repository root's `node_modules`, so there is nothing separate to install.

```bash
cd credential-proxy
cp .env.example .env    # at minimum, GATEWAY_TOKEN, DEEPSEEK_API_KEY, CREDENTIAL_MANAGER_SOCKET
npm start
npm test                # usage-parsing unit tests, entirely offline
npm run typecheck
```

## Pointing codex at it

Change the DeepSeek provider in `~/.codex/config.toml` to address the gateway, and the key no
longer has to live in a config file:

```toml
[model_providers.deepseek]
name = "deepseek"
base_url = "http://127.0.0.1:8795/v1"
wire_api = "responses"
experimental_bearer_token = "<GATEWAY_TOKEN>"
```

> Worth rotating whatever plaintext `sk-...` DeepSeek key is in that config today, and putting
> the new one only in the gateway's `.env`.

## Security

- It **refuses to start** when `GATEWAY_HOST` is not a loopback address and `GATEWAY_TOKEN` is
  empty.
- It holds **no** refresh token — subscription credentials live in the credential manager, reachable only
  over the mode-0600 `CREDENTIAL_MANAGER_SOCKET`, so a compromise of this gateway cannot exfiltrate them.
- Reach it remotely over an SSH port-forward, rather than listening publicly.
- `GATEWAY_MAX_CONCURRENT` caps concurrency, so a shared subscription allowance cannot be
  drained by one burst.
