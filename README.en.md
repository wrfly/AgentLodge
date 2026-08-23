# AgentLodge

**[中文](./README.md) · [English](./README.en.md)**

Claude Code and Codex, wrapped as a multi-tenant web service. Every user gets
their own sandboxed agent; you hold one upstream key and hand out none.

- **The real API key never leaves the gateway process.** Agents carry a
  20-minute ticket bound to `(user, conversation, turn)`, so metering cannot be
  bypassed and a compromised container leaks nothing worth having.
- **Quota is enforced mid-turn**, not just at the door — an agent loop that runs
  away is stopped while it runs, not billed for afterwards.
- **Every outbound request can be recorded** through an audit proxy, with the
  full prompt, for as long as your compliance rules say.
- **Agents run in containers**, one per user, each with its own workspace.

## Features

**Accounts**
- [x] Invite-code registration, plus email invites bound to one address (SendGrid)
- [x] Access token + refresh-token rotation; **a replayed token is treated as a leak** and
      every session for that user is revoked
- [x] Password change, password reset, multi-device management, instant lockout on suspend
- [x] Failed logins throttled by IP and by address, separately

**Metering and quota**
- [x] Every agent request goes through the gateway; usage is sniffed off the SSE stream call
      by call
- [x] The quota gate stops a turn from inside it; daily / weekly / monthly / total periods,
      with the reset moment settable to the hour
- [x] Global concurrency gate (≤3 in flight by default), per-user rotation, AIMD back-off,
      tunable without a restart
- [x] Billing by tokens or by money; the price table is editable and past bills keep the
      price of their time
- [x] **Each user is shown their own allowance**, never the shared plan's — the response
      headers are rewritten from their quota
- [x] **The administrator alone sees the upstream plan's real utilisation** and reset times

**Isolation**
- [x] One long-lived container per user: non-root, all capabilities dropped, memory / CPU /
      PID limits
- [x] Only that user's workspace is mounted, and the container holds no credential
- [x] Workspace paths are resolved for real, with symlink escapes covered by tests

**Ways in**
- [x] The web app: a close copy of the Claude interface, with memory, attachments, Markdown
      and syntax highlighting
- [x] Your own CLI: one command to install, then run `claude` as usual
- [x] Both wire protocols — Anthropic Messages and OpenAI Responses
- [x] Upstream providers can be added, edited and switched live, including a built-in mock

**Operations**
- [x] An audit proxy that records every outbound request, full prompt, with a switch and a
      purge in the console
- [x] Quotas, prices, concurrency, providers and site settings all change without a restart
- [x] Interface and API messages in English, Chinese, Japanese and Russian
- [x] Images split by component; two files and `docker compose` bring the stack up

**Not yet**
- [ ] Balance trends and three-way reconciliation, conversation search, attachments
      referenced inside a conversation (M4)
- [ ] Multi-instance deployment — the concurrency gate becomes a Redis semaphore (M5)

## Quick start

```bash
npm install
JWT_SECRET=$(openssl rand -base64 32) npm run dev
```

Open http://localhost:5173 and the console prints a bootstrap invite code — the
first account to use it becomes the administrator.

You need `claude` and/or `codex` on the machine. Whichever is missing simply
says so on its own page; the other still works.

Offering only one is a supported setup — an administrator switches the other
off under **System settings → Agents**, and it disappears from the interface
entirely rather than sitting there looking broken.

To try it without spending anything, point the upstream at the built-in mock
provider — see the manual.

## Deploying from images

No clone needed — two files is the whole of it:

```bash
curl -fsSLO https://raw.githubusercontent.com/wrfly/AgentLodge/master/docker/compose.release.yml
curl -fsSL  https://raw.githubusercontent.com/wrfly/AgentLodge/master/docker/env.release.example -o .env
$EDITOR .env                  # at minimum JWT_SECRET, AUDIT_ADMIN_TOKEN, DATA_DIR
docker compose -f compose.release.yml up -d
docker pull docker.io/wrfly/agentlodge-agent:latest
```

Images are split by component and published to Docker Hub. `:latest` is the newest release
and `:master` is the rolling build of the branch. A fork publishes under its own owner with
nothing to edit. The agent image's labels say which claude and codex versions are inside it.

## Where to look next

| | |
|---|---|
| [MANUAL.md](./MANUAL.md) | Running it, upstreams, the audit proxy, deployment, environment variables |
| [DESIGN.md](./DESIGN.md) | Why it is built this way |
