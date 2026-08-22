# The audit proxy (trace-proxy). All egress passes through it, and it writes complete
# requests and responses to disk.
#
# A separate image rather than reusing server.Dockerfile: that one only COPYs
# apps/server/dist and has no trace-proxy/. And trace-proxy has **no dependencies at all**
# — nothing but Node's built-in modules — so there is no npm install here and no build stage.
#
# One instance per upstream, told apart by UPSTREAM_URL — see the audit-* services in
# compose.yml.

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Code only. traces-demo and traces-chain are local debugging data and stay out of the image.
# ui.html is server.js's template. Without it the offline viewing path is gone:
# `node trace-proxy/server.js` comes up and answers 500 "ui.html missing". The live /__trace
# interface is switched off at runtime (PROXY_UI_PREFIX=""), but mounting the traces volume
# into this image afterwards is the **only** graphical way to read the history, so it ships.
COPY trace-proxy/proxy.js trace-proxy/server.js trace-proxy/view.js trace-proxy/ui.html trace-proxy/

# The CommonJS marker. trace-proxy/ uses require while the root package.json says
# "type": "module", and without this file Node loads proxy.js as ESM and fails on the first
# line with "require is not defined".
#
#
# **It must not be COPYed.** It is generated (gitignored; see
# scripts/ensure-trace-proxy-cjs.mjs), so on a clean clone it does not exist and the COPY
# takes the whole build down with `"/trace-proxy/package.json": not found` — the very first
# step of a deployment. It is written here instead, meaning the same thing the script does.
RUN printf '%s\n' '{"name":"@agentlodge/trace-proxy-marker","private":true,"type":"commonjs"}' \
    > trace-proxy/package.json

# Audit data. compose mounts a named volume here; back it up and control access to it as
# your compliance requirements demand.
VOLUME /traces

CMD ["node", "trace-proxy/proxy.js"]
