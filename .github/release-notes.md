## Deploying __VERSION__

Two files, attached below, and nothing to clone. The `.env` example on this page already
carries `AGENTLODGE_TAG=__VERSION__`, so what comes up is **this** release rather than
whatever is newest — all five images, the per-user agent container included.

```sh
mkdir agentlodge && cd agentlodge
base=https://github.com/wrfly/AgentLodge/releases/download/v__VERSION__
curl -fsSLO "$base/compose.release.yml"
curl -fsSL  "$base/env.release.example" -o .env

# JWT_SECRET, AUDIT_ADMIN_TOKEN, DATA_DIR and DOCKER_GID have no default worth guessing,
# and compose refuses to start until they are set. Every other line has one.
$EDITOR .env

# DATA_DIR, owned by the uid app, gateway and the agents all run as
sudo install -d -o 10001 -g 10001 /srv/agentlodge/data

docker compose -f compose.release.yml up -d
```

The first administrator's invite code is printed once, on the first start; whoever
registers with it is the administrator.

```sh
docker compose -f compose.release.yml logs app | grep -A1 'invite code'
```

## Upgrading to __VERSION__

Take this page's compose file as well, not the tag alone: a release's settings and its
images are cut together, and the previous file may not set what these images read.

```sh
curl -fsSLO "https://github.com/wrfly/AgentLodge/releases/download/v__VERSION__/compose.release.yml"
sed -i 's/^#*AGENTLODGE_TAG=.*/AGENTLODGE_TAG=__VERSION__/' .env
docker compose -f compose.release.yml pull
docker compose -f compose.release.yml up -d
```

`pull` is not optional: `up` only fetches an image it does not already have, so a host that
has run AgentLodge before would go on serving what it cached.

## Images

`docker.io/wrfly/agentlodge-*`, all five tagged `__VERSION__`. `latest` follows the newest
release; `master` is the rolling build of the branch.

| image | what it is |
|---|---|
| `agentlodge-server` | app and gateway — one image, two roles |
| `agentlodge-web` | Caddy, the console, the landing page |
| `agentlodge-agent` | the per-user agent container |
| `agentlodge-audit-proxy` | records every outbound request, prompts included |
| `agentlodge-credential-manager` | holds the upstream credentials; nothing else does |

The agent image's labels say which claude and codex versions are inside it.
