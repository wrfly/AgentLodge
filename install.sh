#!/bin/sh
# AgentLodge — one command from nothing to a running deployment.
#
#   curl -fsSL https://u.kfd.me/X7 | sh
#
# It asks for the address to serve on and otherwise takes the defaults below. Settings can
# also be given up front — note where they go in the pipe, since `SITE=… curl … | sh` sets
# it for curl and not for the shell that runs this:
#
#   curl -fsSL https://u.kfd.me/X7 | SITE=lodge.example.com PORT=9000 sh
#
# It writes an .env with freshly generated secrets, brings the stack up, and prints the
# first administrator's invite code. Nothing has to be filled in by hand.
#
# Piping a script into a shell means trusting what comes down the wire. To read it first:
#
#   curl -fsSL https://u.kfd.me/X7 -o install.sh
#   less install.sh && sh install.sh
#
# Settings, all optional:
#   DIR=/srv/agentlodge      where the deployment lives          (default ./agentlodge)
#   PORT=9000                the port to serve on                (default 8080)
#   SITE=lodge.example.com   the address Caddy answers on; a real domain gets a
#                            certificate, anything else stays plain http
#   TAG=latest               image channel                       (default master)
#   START=0                  write the files and stop, for reading .env before anything runs
set -eu

REPO="https://raw.githubusercontent.com/wrfly/AgentLodge/master"
DIR="${DIR:-$PWD/agentlodge}"
PORT_GIVEN="${PORT+yes}"
PORT="${PORT:-8080}"
# Whether the address was given, which decides whether there is anything to ask about
SITE_GIVEN="${SITE+yes}"
SITE="${SITE:-localhost}"
# master is the rolling build of the branch and has every service. `latest` follows the
# newest release tag, which is only a complete stack once a release has been cut that
# contains all of them.
TAG="${TAG:-master}"
START="${START:-1}"
YES="${YES:-0}"

say()  { printf '  %s\n' "$*"; }
die()  { printf '\n  %s\n\n' "$*" >&2; exit 1; }

# Whether something is already listening. Unknown counts as free: a wrong "taken" would
# move a port the operator asked for, which is worse than letting docker say it clearly.
port_taken() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -q -- "[:.]$1$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -q -- "[:.]$1$"
  else
    return 1
  fi
}

# The first free port at or above a candidate
free_port() {
  p=$1
  i=0
  while port_taken "$p" && [ $i -lt 50 ]; do
    p=$((p + 1))
    i=$((i + 1))
  done
  printf '%s' "$p"
}

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

# Piped into sh, stdin is the script itself, so a question has to be asked on the terminal
# directly. Where there is none — CI, a cron job, a pipe with no tty behind it — this does
# nothing and the defaults stand. Opening the device is the test: it can exist and still
# not be attachable.
# Piped into sh, stdin is the script itself, so a question has to be asked on the terminal
# directly. Where there is none — CI, a cron job — every default stands and nothing blocks.
#
# The test is a subshell on purpose: `exec 3<>/dev/tty` is a special builtin, and a
# redirection it cannot satisfy kills a non-interactive shell outright, before any `||`
# can run. Failing inside a subshell only fails the subshell.
have_tty() { ( : >/dev/tty ) 2>/dev/null; }

tty_say() { have_tty && printf '%s\n' "$*" > /dev/tty; return 0; }

# Prints the answer, or the default when there is nothing to ask on and when the answer is
# an empty line
prompt() {
  if ! have_tty; then
    printf '%s' "$2"
    return 0
  fi
  printf '  %s [%s]: ' "$1" "$2" > /dev/tty
  answer=""
  IFS= read -r answer < /dev/tty || answer=""
  if [ -n "$answer" ]; then printf '%s' "$answer"; else printf '%s' "$2"; fi
  return 0
}

if [ "$YES" != "1" ] && { [ -z "$SITE_GIVEN" ] || [ -z "$PORT_GIVEN" ]; } && have_tty; then
  tty_say ""
  tty_say "  Where this deployment will be reached."
  tty_say "  A domain gets a certificate from Caddy; anything else is served over plain http."
  tty_say ""
  [ -z "$SITE_GIVEN" ] && SITE="$(prompt "address" "$SITE")"
  # A domain is served on 80 and 443 whatever anybody types — Caddy answers the ACME
  # challenge there or not at all — so there is no port to ask about
  case "$SITE" in
    *[a-zA-Z]*.*[a-zA-Z]*) : ;;
    *) [ -z "$PORT_GIVEN" ] && PORT="$(prompt "port   " "$PORT")" ;;
  esac
  tty_say ""
fi

IS_DOMAIN=0
case "$SITE" in
  localhost|127.0.0.1|::1) IS_DOMAIN=0 ;;
  *[a-zA-Z]*.*[a-zA-Z]*)   IS_DOMAIN=1 ;;
esac

# Whatever will actually be published has to be free, and saying so here beats a docker
# endpoint error after the images have been pulled
if [ "$IS_DOMAIN" = "1" ]; then
  port_taken 80  && die "port 80 is in use, and Caddy needs it to answer the certificate challenge"
  port_taken 443 && die "port 443 is in use, and Caddy needs it to serve $SITE"
else
  port_taken "$PORT" && die "port $PORT is already in use — pick another"
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
if [ "$IS_DOMAIN" = "1" ]; then
  # A name Caddy can get a certificate for. It needs 80 and 443 to answer the ACME
  # challenge, so the port is not ours to move.
  ADDRESS="$SITE"
  SECURE=true
  BASE="https://$SITE"
  PORTS="HTTP_PORT=80
HTTPS_PORT=443"
  [ "$PORT" = "80" ] || say "note: PORT is ignored for a domain — Caddy needs 80 and 443 for its certificate"
else
  # A bare port, not a hostname. Given `localhost`, Caddy issues itself a certificate from
  # its local CA and redirects http to https — which, behind a published port that is not
  # 443, lands the browser somewhere that is not this deployment. `:80` says plain http,
  # any Host, which is what a local or reverse-proxied deployment wants.
  ADDRESS=":80"
  SECURE=false
  [ "$PORT" = "80" ] && BASE="http://$SITE" || BASE="http://$SITE:$PORT"
  # Nothing is served over TLS here, but the compose file publishes 443 all the same — so
  # it gets a high port that is actually free rather than one more thing fighting over 443
  PORTS="HTTP_PORT=$PORT
HTTPS_PORT=$(free_port "${HTTPS_PORT:-8443}")"
fi

say "address        $BASE"
say "images         ${TAG}"
say "data           $DATA"
printf '\n'
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
# The socket credential-manager listens on and gateway dials. Under this deployment rather
# than the shared /run/agentlodge, so a second deployment on the same host does not bind
# over the first one's socket and quietly serve its credentials.
CREDENTIAL_MANAGER_SOCKET_DIR=$DIR/run
DOCKER_GID=$DOCKER_GID
AGENTLODGE_TAG=$TAG

SITE_ADDRESS=$ADDRESS
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

# Pulled explicitly rather than left to `up`. Both channels are moving tags, and `up`
# only fetches an image it does not already have — on a machine that installed once
# before, that silently keeps whatever was cached, however old.
say "pulling images (a few minutes the first time)"
docker compose -f compose.release.yml pull

say "starting"
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
