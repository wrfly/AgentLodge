# AgentLodge

**[火星文](./README.md) · [English](./README.en.md) · [中文](./README.zh.md)**

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
