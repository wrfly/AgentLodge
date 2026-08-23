# One image for both the main service and the gateway; ROLE decides which half runs.
#
# The app role needs a container-engine client: it creates each user's agent container
# through the socket mounted into it. The gateway role has no use for one, but not enough
# use to justify a second image.

FROM node:22-bookworm-slim AS build
WORKDIR /src
# Every `resolved` in the lockfile points at the registry that produced it — an internal
# mirror, for this repository — so building anywhere else is a parade of ENOTFOUND: npm
# follows `resolved`, not the configured registry.
# replace-registry-host=always rewrites that host to the one below. When the two already
# agree it does nothing, so internal builds are unaffected.
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_replace_registry_host=always
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @agentlodge/server --include-workspace-root
COPY apps/server apps/server
RUN npm -w @agentlodge/server run build \
 && npm ci --omit=dev --workspace @agentlodge/server --include-workspace-root \
 # Workspaces hoist everything to the root node_modules, so apps/server/node_modules often
 # does not exist at all and the COPY below fails with "no such file or directory". An empty
 # directory covers that; when a nested dependency really does appear (a version conflict) it
 # has contents and gets copied as before.
 && mkdir -p apps/server/node_modules

FROM node:22-bookworm-slim
# Talks to the engine **on the host** through the mounted socket; no engine runs in here.
# Which client to install depends on which engine the host runs, and not on this image:
#
#   podman (default)  Debian has **no** podman-remote package. This originally named it, and
#                     the build could only fail: `E: Unable to locate package podman-remote`.
#                     Installing podman itself and invoking it under another name works,
#                     because podman reads argv[0] and switches to remote mode when the
#                     basename is podman-remote — confirmed by trying it. The layer costs
#                     ~30MB, more than a bare client, but avoids pinning a static binary
#                     pulled from GitHub.
#   docker            Just the CLI binary out of the official static bundle; no daemon. Also
#                     needs PODMAN_BIN pointed at docker and DOCKER_HOST at the mounted
#                     socket — see compose.docker.yml.
# The default suits a source build against docker/compose.yml, which is written for podman.
# The published images are built with `docker`, because compose.release.yml is written for
# it — an image with the wrong client says `spawn docker ENOENT` and container isolation is
# simply off. See .github/workflows/release.yml.
ARG CONTAINER_CLIENT=podman
ARG DOCKER_CLI_VERSION=29.7.2
RUN set -eux; \
    apt-get update; \
    if [ "$CONTAINER_CLIENT" = docker ]; then \
      apt-get install -y --no-install-recommends ca-certificates curl; \
      curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" \
        | tar -xzf - -C /usr/local/bin --strip-components=1 docker/docker; \
    else \
      apt-get install -y --no-install-recommends podman; \
      ln -sf /usr/bin/podman /usr/local/bin/podman-remote; \
    fi; \
    rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CONTAINER_HOST=unix:///run/podman/podman.sock \
    PODMAN_BIN=podman-remote
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/apps/server/node_modules apps/server/node_modules
COPY --from=build /src/apps/server/dist apps/server/dist
COPY --from=build /src/apps/server/package.json apps/server/
# The database and the workspaces both live here; compose mounts a named volume over it
VOLUME /data
CMD ["node", "apps/server/dist/index.js"]
