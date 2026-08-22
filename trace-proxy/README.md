# llm-trace-proxy

A zero-dependency transparent forwarding proxy — nothing but Node's built-in modules — for
capturing the API traffic Claude Code and the Codex CLI actually send.

> **This code is maintained here, and is no longer synced from `~/projects/proxy`.**
> Inside AgentLodge it has a job that matters: it is the **audit proxy**, all egress goes
> through it, and with it unconfigured nothing gets out at all (see the "audit proxy" section
> of MANUAL.md in the root). What this repository added is per-request routing by
> `x-forwarded-host`, so one instance serves many upstreams — see "Routing by forwarded host"
> in `proxy.js`.

```
Claude Code / Codex  ──►  http://127.0.0.1:8799  ──►  api.anthropic.com / api.openai.com
                              │
                              └─► traces/  (request headers/body, response headers/body,
                                            SSE event by event, and the reconstruction)
```

Requests pass through as they came in — only `Host` and `accept-encoding` change — and
response bytes come back untouched, with no change in meaning. Claude Code cannot tell the
difference from connecting directly.

## Running it

```bash
node proxy.js                 # 127.0.0.1:8787 by default, interface at /__trace
PROXY_PORT=8799 node proxy.js # a different port
```

In another terminal:

**Claude Code** — one environment variable, and note that BASE_URL carries no `/v1`:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8799 claude
```

**Codex** — it does not read `OPENAI_BASE_URL`, so the provider configuration has to be
overridden with `-c`. Check how you are signed in first (`~/.codex/auth.json`):

| `auth_mode` | Upstream it uses | What `base_url` should be |
|---|---|---|
| `chatgpt` (subscription sign-in, `OPENAI_API_KEY` is null) | `https://chatgpt.com` | `.../backend-api/codex` |
| API key | `https://api.openai.com` | `.../v1` |

Subscription sign-in, which is the common case:

```bash
codex -c model_provider=trace \
  -c 'model_providers.trace.name="trace"' \
  -c 'model_providers.trace.base_url="http://127.0.0.1:8799/backend-api/codex"' \
  -c 'model_providers.trace.wire_api="responses"' \
  -c 'model_providers.trace.requires_openai_auth=true'
```

API key sign-in:

```bash
codex -c model_provider=trace \
  -c 'model_providers.trace.name="trace"' \
  -c 'model_providers.trace.base_url="http://127.0.0.1:8799/v1"' \
  -c 'model_providers.trace.wire_api="responses"' \
  -c 'model_providers.trace.env_key="OPENAI_API_KEY"'
```

`-c` applies to that run alone and leaves your `~/.codex/config.toml` untouched. To make it
permanent, put the `[model_providers.trace]` block in the config file and set
`model_provider = "trace"`. `CODEX_HOME` can also point at an entirely different
configuration directory.

The proxy routes upstreams by path on its own: `/backend-api/*` → `chatgpt.com`,
`/v1/responses` and friends → `api.openai.com`, everything else → `api.anthropic.com`.

Authentication is unchanged: your `x-api-key` or `Authorization: Bearer` is forwarded to the
official endpoint exactly as it arrived, and redacted on the way to disk.

## Reading the traffic

```bash
node view.js              # the list
node view.js 3            # expand #3: headers / system / tools / messages / response / usage / allowance
node view.js 3 --events   # SSE, event by event
node view.js 3 --raw      # the raw JSON
tail -f traces/index.jsonl
```

## What is in traces/

One directory per request:

| File | Contents |
|---|---|
| `request.json` | method, URL, upstream, every request header (keys redacted) |
| `request.body.json` | the request body verbatim |
| `request.summary.json` | a structured summary: model, system blocks, the tool list, each message, and how many cache_control breakpoints |
| `response.headers.json` | status code, every response header, and TTFB |
| `quota.json` | allowance and rate-limit headers (see below) |
| `response.stream.jsonl` | streaming: one SSE event per line, `{t, event, data}` |
| `response.reconstructed.json` | streaming: the final text, thinking, tool_use and usage, rebuilt |
| `response.body.json` | the body of a non-streaming response |
| `meta.json` | the per-request summary, shaped like a line of `index.jsonl` |

`traces/index.jsonl` is the global index, one line per request.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_PORT` / `PROXY_HOST` | `8787` / `127.0.0.1` | where it listens |
| `TRACE_DIR` | `./traces` | where traces are written |
| `UPSTREAM_URL` | — | pin the upstream, bypassing the automatic routing |
| `ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | |
| `OPENAI_UPSTREAM` | `https://api.openai.com` | |
| `PROXY_REDACT` | `1` | `0` records keys verbatim |
| `PROXY_HTTP2` | `0` | HTTP/1.1 by default, matching what Claude Code negotiates directly; `1` uses HTTP/2 |
| `PROXY_IDENTITY` | `0` | `1` asks the upstream not to compress — cheaper, but no longer a faithful copy |
| `PROXY_TIMEOUT_MS` | `900000` | upstream timeout |
| `PROXY_UI_PREFIX` | `/__trace` | where the interface is mounted under the proxy's port; empty means not mounted |
| `UI_PORT` / `UI_HOST` | `8080` / `127.0.0.1` | only used when running `server.js` on its own |

Automatic upstream routing: `/v1/responses`, `/v1/chat/completions`, `/v1/completions`,
`/v1/embeddings` and `/backend-api/*` go to OpenAI; `/v1/models` is decided by the presence of
`x-api-key` or `anthropic-version`; everything else goes to Anthropic.

## Which API carries usage and allowance

The endpoints and fields below were taken out of the local `claude` and `codex` binaries.

**Claude Code**
- `GET /api/oauth/usage` — what the `/usage` panel reads, and OAuth (subscription) accounts
  only. It returns `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` and
  `seven_day_oauth_apps`, each with `utilization` and `resets_at`. Sending a fake token gets
  `OAuth access token is invalid` rather than a 404, so the endpoint really is there.
- Every `/v1/messages` **response header set** carries live allowance figures too, which is
  what Claude Code's rate-limit warnings are based on:
  `anthropic-ratelimit-unified-status` / `-reset` / `-5h-utilization` / `-7d-utilization` /
  `-overage-status` / `-overage-in-use` / `-overage-reset` / `-grace-status` /
  `-upgrade-paths` / `-fallback`.
- Related but different: `/api/claude_code/policy_limits` (organisation policy) and
  `/v1/organizations/spend_limits` (spending caps).
- Per-request token counts come from `usage` in the response body or SSE stream
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).

**Codex**
- No usage endpoint of its own. The allowance rides along with the response from
  `/backend-api/codex/responses` (ChatGPT subscription) or `/v1/responses` (API key):
  - **response headers**: `x-codex-credits-balance`, `x-codex-credits-has-credits`,
    `x-codex-credits-unlimited`, `x-codex-rate-limit-reached-type`, `x-codex-active-limit`
  - **inside the SSE stream**: a `rate_limits` structure with `primary` and `secondary`, each
    carrying `used_percent`, `window_minutes`, `resets_at` and `plan_type`
- So the usage `codex /status` shows is whatever came back with the last request, not the
  result of a query.

The proxy pulls all of the above into `quota.json` and into `rate_limits` in
`response.reconstructed.json`, and `node view.js <#>` lists them separately.

## Pinning device_id

Claude Code's `device_id` lives in the `userID` field of `~/.claude.json` — generated at
random on first run and persisted, not a machine fingerprint — and goes out inside the body's
`metadata.user_id`:

```json
{"device_id":"094aec26…","account_uuid":"d5ebd251-…","session_id":"53dca3aa-…"}
```

A different HOME means a different value, so every `docker run` without a mounted home gets a
new device_id. To keep it stable:

```bash
PROXY_DEVICE_ID=<your value>   node proxy.js   # rewrite every one to this
PROXY_DEVICE_ID=sticky         node proxy.js   # pin the first one seen, stored in <TRACE_DIR>/.device-id
```

sticky suits containers: the first container's device_id is remembered and every container
after it uses that one.

**`device_id` only; `account_uuid` is not touched.** That one is the account's identity and
travels with the sign-in credential. Changing it would be both out of bounds and pointless —
the credential already says who you are.

**With this on, the proxy is no longer a pure passthrough**, which sits awkwardly against a
tool whose job is recording traffic faithfully. So every rewrite leaves a mark:

- `request.rewrites.json` records `field` / `from` / `to`
- `meta.json` and `index.jsonl` carry a `rewritten` field
- `request.body.json` holds the **rewritten** body, which is what actually went upstream
- the startup banner says in yellow that rewriting is on

## Requests that are not recorded

**Browser noise is handled automatically.** A browser opening the interface asks for
`/favicon.ico`, `/robots.txt` and the like on its own. None of it is API traffic, and
forwarding it upstream only earns a 404. The proxy answers locally — a built-in icon for the
favicon, 204 for the rest — so nothing goes out and nothing is recorded. A request to the same
path carrying `x-api-key` or `Authorization` is unaffected and forwarded as usual: this stops
browsers, not programs.

**A blocklist of your own**, `PROXY_TRACE_SKIP`: matching requests are **still forwarded**, but
never written to disk, never indexed, never logged, and they consume no trace number.

```bash
PROXY_TRACE_SKIP='/v1/models*,HEAD /api/hello,*.ico' node proxy.js
```

Entry format:

| Written as | Means |
|---|---|
| `/favicon.ico` | that path, any method |
| `HEAD /api/hello` | HEAD only — Claude Code's connectivity probe |
| `/v1/models*` | prefix wildcard, `*` matches anything |
| `*.ico` | suffix wildcard |

Empty by default, because filtering your traffic uninvited is not this tool's place. The
usual candidate is `HEAD /api/hello`, the connectivity probe Claude Code sends periodically,
which tells you nothing beyond "the network is up".

To clear noise already recorded:

```bash
# see what would go first
node -e 'const fs=require("fs");fs.readFileSync("traces/index.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse).filter(r=>/favicon|robots/.test(r.path)).forEach(r=>console.log(r.dir))'
```

## Concurrency

**Off by default.** Switched on, it caps in-flight upstream requests and queues the rest
locally:

```bash
PROXY_MAX_CONCURRENT=4 node proxy.js
```

One slot covers a whole request, retries included. Time spent queued goes into `queued_ms` in
the trace, shows in the interface as a `⧗410ms` marker, and is printed in the log:

```
#3 ⧗ queued 409ms (in flight 2/2, queue 3)
```

Measured with six concurrent requests against an upstream taking 400ms each:

| Setting | Wall clock |
|---|---|
| unlimited | 460ms |
| `PROXY_MAX_CONCURRENT=2` | 1271ms (3 rounds) |
| `PROXY_MAX_CONCURRENT=1` | 2494ms (6 rounds) |

**Why it is off by default**: a streaming request holds its slot for a long time — tens of
seconds for one reply is ordinary — so a low limit visibly drags Claude Code down, and it
already runs subagents and tool calls in parallel. Turn it on against your account's real
limit once you start seeing 429s.

**How it relates to retries**: concurrency control prevents (requests do not get refused) and
retrying recovers (they were refused, try again), and the two complement each other. But note
that Anthropic's rate limiting is measured in **RPM, input TPM and output TPM**: concurrency
is not a rate. Capping it flattens a burst, and a sustained rate over the limit still earns a
429.

A full queue or a wait that times out returns 429 with an `x-proxy-queue` header, stating
plainly that **the proxy generated this** and it is not the upstream's answer. In the trace it
is recorded as `phase: proxy-queue`.

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_DEVICE_ID` | empty | pin device_id: a value, or `sticky` to keep the first one seen |
| `PROXY_TRACE_SKIP` | empty | requests not to record; comma-separated, `*` and method prefixes allowed |
| `PROXY_MAX_CONCURRENT` | `0` | maximum in-flight requests, `0` = unlimited |
| `PROXY_QUEUE_MAX` | `200` | queue ceiling; beyond it, 429 |
| `PROXY_QUEUE_TIMEOUT_MS` | `120000` | longest a single request may queue |

## Retries

On by default, and **only while not one byte has reached the client**.

That boundary is hard. Once the response starts forwarding, retrying is off the table: the
upstream generates from scratch, the client receives a second `message_start`, and the SSE
stream is ruined — the Anthropic API has no way to resume. So a response that drops mid-flight
(`connection closed mid-response`) is **never retried**; the scene is recorded in full instead.

**The upstream's opinion comes first.** Anthropic states it outright with an `x-should-retry`
header — a rate-limiting 429 carries `x-should-retry: true` — and the official SDK reads the
same header. Only in its absence does the status-code list apply.

| Case | Retried |
|---|---|
| `x-should-retry: true` (a 429, say) | ✅ |
| `x-should-retry: false` | ❌ passed straight to the client |
| no such header, status ∈ `429,502,503,504,529` | ✅ |
| a connection-level error with **no response header received** (ECONNRESET, ETIMEDOUT, socket hang up…) | ✅ |
| **the response had already started** | ❌ record the scene, do not retry |
| `500` | ❌ see below |

**500 is deliberately absent**: it can mean "the upstream handled it and the reply failed", and
retrying then means **being billed twice**. The entries on the list generally mean the request
was never processed at all, which makes a retry safe. To change it, set
`PROXY_RETRY_STATUS=429,500,502,503,504,529`.

Backoff uses the upstream's `retry-after` if it sent one, and otherwise exponential backoff
with jitter (500ms → 1s → 2s…, capped at 30s).

Every failure goes into `retry_log` in the trace, and the interface shows a `↻2` marker with
the full history:

```json
{"attempt":1,"status":429,"should_retry_header":"true","waited_ms":211}
{"attempt":2,"status":429,"should_retry_header":"true","waited_ms":328}
```

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_RETRY` | `2` | maximum retries, `0` disables |
| `PROXY_RETRY_BASE_MS` | `500` | backoff base |
| `PROXY_RETRY_MAX_MS` | `30000` | backoff ceiling |
| `PROXY_RETRY_STATUS` | `429,502,503,504,529` | the fallback list when there is no `x-should-retry` |

## Fidelity: what the proxy actually changes

**First, the frame.** Anthropic can only observe the proxy → upstream leg; the client → proxy
leg is on your own machine. So fidelity is a question about the upstream leg alone.

### Two facts, established by measurement

Captured with `ja3-probe.js`, whose handshake fails on purpose so no API call happens:

**1. Claude Code negotiates HTTP/1.1 when connecting directly, not HTTP/2.**
Its ClientHello advertises ALPN `["http/1.1"]` and nothing else. So this proxy **also uses
HTTP/1.1 by default**, to match (`PROXY_HTTP2=1` switches to h2, which moves *away* from the
real thing). Earlier versions defaulted to h2, copying curl's behaviour — that was a mistake.

**2. Claude Code's TLS stack is BoringSSL, not Node's OpenSSL.**
The binary holds 173 `boringssl` strings and `Bun/1.4.0` — it is a single-file executable
compiled with Bun. The ClientHellos differ considerably:

| | ciphers | extension order | JA3 |
|---|---|---|---|
| Claude Code (Bun/BoringSSL) | 17 | `23,65281,10,11,35,16,5,13,18,51,45,43` | `e97f5146…` |
| this proxy (Node 22/OpenSSL) | 52 | `65281,0,11,10,35,16,22,23,13,43,45,51` | `a44663b9…` |

**JA3/JA4 therefore cannot be aligned by configuration**; the difference is inherent to two
TLS implementations. What the proxy does align is the part it can: it declares ALPN
`["http/1.1"]` explicitly, where Node sends no such extension at all. Matching even the
fingerprint would, in principle, mean running this proxy under Bun — also BoringSSL — which is
**untested here**, as Bun is not installed on this machine.

### At the HTTP layer: what changes

| Difference | Why |
|---|---|
| header names lowercased | a product of Node parsing HTTP/1.1; values are untouched |
| `Host` rewritten to the upstream host | unavoidable for a reverse proxy |
| `Connection: keep-alive` added | Node's Agent appends it at the socket layer; the proxy's code never writes it |
| `content-length` recomputed and moved to the end | same value |
| repeated headers folded | `X-Rep: v1` + `X-Rep: v2` → `x-rep: v1, v2`, which RFC-wise means the same |

**Not one character of a business header's value changes**, and nothing is dropped or
injected. `Accept-Encoding` is **no longer rewritten** either: compressed bytes reach the
client as they arrived, and the proxy decompresses only for the trace (gzip, deflate, br and
zstd all verified).

**In the response direction**, names are likewise lowercased and repeats folded, and Node adds
`Date`, `Connection` and `Keep-Alive`. Multiple `Set-Cookie` headers were confirmed to survive
as separate headers rather than being folded.

With `PROXY_HTTP2=1`, the lowercasing and `Connection` differences disappear — h2 requires
lowercase and forbids `Connection` anyway — at the cost of using a protocol Claude Code would
not have used on its own.

### Scope-of-use checks

The proxy runs two local checks. Neither reports anything anywhere; both simply print to the
terminal.

- **Listening address**: `127.0.0.1` by default. A non-loopback address earns a warning in
  red, because any machine on that network could then use your credentials.
- **Credential count**: only an 8-character hash of each credential is kept, never the
  credential. Seeing several different ones on one instance prints a warning once, because
  that is what account sharing looks like — and account sharing is the thing that actually
  gets accounts banned.

Neither changes how anything is forwarded. They are warnings and nothing else.

### On getting banned

`ANTHROPIC_BASE_URL` is an environment variable Claude Code supports officially — it is how
corporate gateways work — and HTTP/1.1 is an officially supported transport for the Anthropic
API. Using a proxy is not itself a violation. The work above exists to make captured traffic
resemble a direct connection more closely, not to evade detection; and evading fingerprint
detection is beyond this proxy regardless, as the JA3 section explains.

Two files per request are written for checking this yourself:

- `raw_headers` in `request.json` — the case and order the client sent
- `forwarded.headers.json` — the headers the proxy actually sent upstream, with a `protocol`
  field naming h1 or h2

`meta.json` and `index.jsonl` record `upstream_http_version` and `content_encoding`.

## Known boundaries

- A reverse proxy only, the `ANTHROPIC_BASE_URL` arrangement. Not an HTTP CONNECT proxy, and
  no root certificate to install.
- Request bodies are read fully into memory before forwarding — fine at LLM request sizes, and
  unsuitable for large file uploads.
- Upstream h2 and compression pass through as they are, but the client ↔ proxy leg is still
  plaintext HTTP/1.1. That leg is on your machine, invisible to the server, and does not
  affect fidelity.
- `traces/` holds complete prompts and responses. Keys are redacted but **the conversations
  are in plaintext** — do not commit them.
- Claude Code does not honour `SSLKEYLOGFILE` (no keylog was produced), so passively
  decrypting a direct connection is not an alternative to this proxy.

## Interface authentication

The interface shows **everybody's complete prompts**, so `/__trace` — including `/api/*` and
SSE — admits two kinds of request:

- **a loopback address** — a browser on this machine, curl on this machine, or `docker exec`
  into the container
- **the admin token** — `Authorization: Bearer <PROXY_ADMIN_TOKEN>`, the `trace_admin` cookie,
  or a one-shot `?token=`: on a match it sets an HttpOnly, SameSite=Lax cookie and 302s the
  query string away, so the token never lingers in the address bar, the history, or a referer

"Loopback" is decided by the **socket peer**, not by `X-Forwarded-For`, which a client can
forge. So with the proxy in a container and you reaching it from the host through a published
port, the peer is a bridge address and **not** loopback, and that case needs the token. With
no `PROXY_ADMIN_TOKEN` configured, loopback is the only way in — better one more
`docker exec` than everybody's conversations sitting on the network by default.

## The web interface

The interface is **mounted on the proxy's own port** by default, so there is no second process
to start:

```bash
node proxy.js
#   proxy      ->  http://127.0.0.1:8787
#   interface  ->  http://127.0.0.1:8787/__trace     (a browser at the root is sent there)
```

The official API uses only `/v1/*` and `/api/*`, so the `/__trace` prefix cannot collide with
it. Interface requests are handled in place: never traced, never forwarded upstream. Set
`PROXY_UI_PREFIX=/xxx` for a different prefix, or `PROXY_UI_PREFIX=` for none at all.

It also runs on its own — to read history, or to point the interface at another directory:

```bash
node server.js                                   # http://127.0.0.1:8080
UI_PORT=9000 TRACE_DIR=./traces node server.js
```

The interface only reads `traces/`. With the proxy running, new requests arrive live over SSE
(the green dot at the top right means connected); without it, the history is still there.

- **KPIs across the top**: requests, failures, total input and output tokens, cache hit rate,
  average duration
- **Left column**: the request list with status code, duration, model, ↑input ↓output ⚡cache
  hits; searchable by path and model, filterable to errors only or streamed only; a new
  request flashes as it arrives
- **Right column, five tabs**
  - `Overview` — the key fields, a **token breakdown bar** (cache read, cache write, new
    input, output, with values and proportions), allowance headers, thinking, the reply text,
    and tool calls
  - `Request` — request headers, parameters, system block by block with CACHE breakpoints
    marked, a table of tool sizes, and every message expanded
  - `Response` — response headers, the SSE reconstruction, and the non-streaming body
  - `SSE` — a timeline event by event, coloured by type (text green, tools yellow, start blue,
    end orange); click a row for the full JSON
  - `Files` — open any raw file this request wrote
- **Keys**: `j` / `k` to move, `/` to focus the search box
- The theme follows the system, and the top right switches it by hand

The palette is a categorical one checked for colour-vision deficiency, verified separately in
light and dark. Every segment of the token breakdown bar is labelled with its value, so colour
never carries information on its own.

## How to read a trace — four layers, coarse to fine

After a real session, drill down as far as you need:

**① Live** — the proxy's own terminal is the first view, two lines per request:
```
#7 → POST /v1/messages [api.anthropic.com] model=... msgs=42 tools=17 stream=true cache_bp=4 body=284KB
#7 ← 200 SSE 8213ms in=4821 out=96 cache_r=18400 cache_w=2100 stop=tool_use 0007-...
```
At a glance: how far the context has grown, how many tools went along, whether the cache hit,
and why this turn stopped.

**② The list** — `node view.js`, to find the number of the one you want.

**③ The main view** — `node view.js 7`, laid out on one screen: request headers with keys
redacted, model/max_tokens/cache breakpoint count, system block by block (how many characters,
which blocks carry `CACHE`), the tool list (how many characters each description and schema
costs), every message (each block's type, tool_use inputs, tool_result returns), allowance
headers in their own section, and the complete reply, tool_use and usage rebuilt from the SSE
stream.

**④ Frame by frame, or raw** — `node view.js 7 --events` shows how the SSE stream was
delivered, which is what to use for debugging truncated streams and tool-input assembly;
`node view.js 7 --raw` prints the raw JSON.

Below that there are just files: everything in `traces/<directory>/` is ordinary JSON or JSONL.

```bash
# which tools the request carried
jq -r '.tools[].name' traces/0007*/request.body.json

# reassemble a streamed reply into plain text
jq -r 'select(.data.delta.type=="text_delta") | .data.delta.text' traces/0007*/response.stream.jsonl | tr -d '\n'

# cache hit trends across requests
jq -r 'select(.usage) | "\(.id)\t\(.model)\tin=\(.usage.input_tokens)\tcache_read=\(.usage.cache_read_input_tokens)"' traces/index.jsonl

# every failed request
jq -r 'select(.status>=400) | "\(.id)\t\(.status)\t\(.path)"' traces/index.jsonl

# the largest request bodies
jq -s 'sort_by(-.request_bytes)[:5][] | "\(.id)\t\(.request_bytes)B\t\(.path)"' -r traces/index.jsonl
```

The upstream project shipped a `traces-demo/` sample, which this repository **removed**: trace
directories are gitignored wholesale (`trace-proxy/traces*/`), and a sample sitting among them
invites the assumption that such a directory is safe to commit. To see it working, capture one
yourself — `npm run dev:free`, then `npm run trace:view`.
