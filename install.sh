#!/bin/sh
# AgentLodge — one command from nothing to a running deployment.
#
#   curl -fsSL https://raw.githubusercontent.com/wrfly/AgentLodge/master/install.sh | sh
#
# It writes an .env with freshly generated secrets, brings the stack up, and prints the
# first administrator's invite code. Nothing has to be filled in by hand.
#
# Piping a script into a shell means trusting what comes down the wire. To read it first:
#
#   curl -fsSLO https://raw.githubusercontent.com/wrfly/AgentLodge/master/install.sh
#   less install.sh && sh install.sh
#
# Settings, all optional:
#   DIR=/srv/agentlodge      where the deployment lives          (default ./agentlodge)
#   PORT=8080                the port to serve on                (default 80)
#   SITE=lodge.example.com   the address Caddy answers on; a real domain gets a
#                            certificate, anything else stays plain http
#   TAG=master               image channel                       (default latest)
#   START=0                  write the files and stop, for reading .env before anything runs
set -eu

REPO="https://raw.githubusercontent.com/wrfly/AgentLodge/master"
DIR="${DIR:-$PWD/agentlodge}"
PORT="${PORT:-80}"
SITE="${SITE:-localhost}"
TAG="${TAG:-latest}"
START="${START:-1}"

say()  { printf '  %s\n' "$*"; }
die()  { printf '\n  %s\n\n' "$*" >&2; exit 1; }

# ---- what has to be there before anything is written ------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed — https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "this needs docker compose v2 (\`docker compose\`, not \`docker-compose\`)"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon — is it running, and is this user in the docker group?"
command -v openssl >/dev/null 2>&1 || die "openssl is needed to generate the secrets"
command -v curl >/dev/null 2>&1 || die "curl is needed to fetch the compose file"

DOCKER_GID="$(getent group docker 2>/dev/null | cut -d: -f3 || true)"
[ -n "$DOCKER_GID" ] || die "no docker group on this host; app needs its gid to reach the socket"

DATA="$DIR/data"
if [ -e "$DIR/.env" ]; then
  die "$DIR/.env already exists — this script writes a fresh deployment, and overwriting it
  would change JWT_SECRET, which makes every existing session and encrypted setting unreadable.
  Remove it deliberately, or run with DIR=… somewhere else."
fi

printf '\n  Installing AgentLodge into %s\n\n' "$DIR"
mkdir -p "$DIR"
cd "$DIR"

# ---- the two files a deployment is made of ----------------------------------
say "fetching compose.release.yml"
curl -fsSL "$REPO/docker/compose.release.yml" -o compose.release.yml

# ---- secrets, generated rather than asked for -------------------------------
JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
AUDIT_ADMIN_TOKEN="$(openssl rand -base64 32 | tr -d '\n')"
CREDENTIAL_MANAGER_KEY="$(openssl rand -hex 32)"
TZ_HOST="$(cat /etc/timezone 2>/dev/null || readlink -f /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || echo UTC)"

# A real domain gets a certificate from Caddy, which needs ports 80 and 443 to answer the
# ACME challenge — so a domain deployment does not get to move the port. Anything else is
# served over plain http, and then the cookies must not be marked Secure or no browser
# will send them back.
IS_DOMAIN=0
case "$SITE" in
  localhost|127.0.0.1|::1) IS_DOMAIN=0 ;;
  *[a-zA-Z]*.*[a-zA-Z]*)   IS_DOMAIN=1 ;;
esac

if [ "$IS_DOMAIN" = "1" ]; then
  SECURE=true
  BASE="https://$SITE"
  PORTS="HTTP_PORT=80
HTTPS_PORT=443"
  [ "$PORT" = "80" ] || say "note: PORT is ignored for a domain — Caddy needs 80 and 443 to get a certificate"
else
  SECURE=false
  [ "$PORT" = "80" ] && BASE="http://$SITE" || BASE="http://$SITE:$PORT"
  PORTS="HTTP_PORT=$PORT"
fi

say "writing .env"
umask 077
cat > .env <<ENVEOF
# Written by install.sh on $(date -Iseconds). The three secrets below are this deployment's
# own; losing JWT_SECRET signs everyone out and makes the encrypted settings unreadable,
# and losing CREDENTIAL_MANAGER_KEY makes the stored upstream credentials unreadable.
JWT_SECRET=$JWT_SECRET
AUDIT_ADMIN_TOKEN=$AUDIT_ADMIN_TOKEN
CREDENTIAL_MANAGER_KEY=$CREDENTIAL_MANAGER_KEY

DATA_DIR=$DATA
DOCKER_GID=$DOCKER_GID
AGENTLODGE_TAG=$TAG

SITE_ADDRESS=$SITE
APP_BASE_URL=$BASE
SECURE_COOKIES=$SECURE
$PORTS
TZ=$TZ_HOST
ENVEOF
umask 022

# ---- the data directory belongs to the uid the containers run as ------------
say "creating $DATA (owned by uid 10001, which app, gateway and the agents run as)"
if [ "$(id -u)" = "0" ]; then
  install -d -o 10001 -g 10001 "$DATA"
else
  sudo install -d -o 10001 -g 10001 "$DATA"
fi

# ---- up ---------------------------------------------------------------------
if [ "$START" = "0" ]; then
  printf '\n'
  say "wrote $DIR/.env and $DIR/compose.release.yml, and started nothing (START=0)"
  say "start it with: cd $DIR && docker compose -f compose.release.yml up -d"
  printf '\n'
  exit 0
fi

say "pulling images and starting (this takes a few minutes the first time)"
docker compose -f compose.release.yml up -d

# ---- the invite code the app prints on a fresh database ---------------------
say "waiting for the first administrator invite code"
CODE=""
i=0
while [ $i -lt 60 ]; do
  CODE="$(docker compose -f compose.release.yml logs app 2>/dev/null \
    | sed -n 's/.*│  \([A-Z0-9]\{4\}-[A-Z0-9]\{4\}-[A-Z0-9]\{4\}\) *│.*/\1/p' | tail -1)"
  [ -n "$CODE" ] && break
  i=$((i + 1))
  sleep 2
done

printf '\n  ╭─────────────────────────────────────────────────────────╮\n'
printf '  │  AgentLodge is up                                       │\n'
printf '  ╰─────────────────────────────────────────────────────────╯\n\n'
say "address        $BASE"
if [ -n "$CODE" ]; then
  say "invite code    $CODE"
  say "               register with it — the first account is the administrator"
else
  say "invite code    not printed yet; find it with:"
  say "               docker compose -f $DIR/compose.release.yml logs app | grep -A1 'invite code'"
fi
printf '\n'
say "secrets        $DIR/.env      back it up; JWT_SECRET and CREDENTIAL_MANAGER_KEY cannot be recovered"
say "state          $DATA          database, workspaces, traces"
printf '\n'
say "next           sign in, then Admin console → System settings:"
say "               1. Upstream credentials — sign a subscription in, or paste an API key"
say "               2. Upstream providers   — the address, pointed at that credential"
say "               3. Models               — what users can pick, or pull the list from the upstream"
printf '\n'
