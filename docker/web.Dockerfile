# Frontend static assets plus Caddy.
# The frontend is entirely static, so the build output is baked into the Caddy image and no
# node is needed at runtime.

FROM node:22-bookworm-slim AS build
WORKDIR /src
# Same reasoning as the comment in server.Dockerfile: `resolved` in the lockfile points at
# whichever registry produced it, building elsewhere gets ENOTFOUND, and these two arguments
# rewrite the host to the current registry.
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_replace_registry_host=always
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace @agentlodge/web --include-workspace-root
COPY apps/web apps/web
RUN npm -w @agentlodge/web run build

FROM caddy:2
COPY --from=build /src/apps/web/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
