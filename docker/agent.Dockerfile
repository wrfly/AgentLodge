# The per-user agent container: the CLI in a sandbox, with the workspace mounted in
#
# The full node image rather than slim + apt: on an internal network the container cannot
# reach Debian's repositories, and the full image already carries git, curl and procps,
# which is all the agent needs.
FROM node:22-bookworm

ARG CLAUDE_VERSION=2.1.224
ARG CODEX_VERSION=0.147.0

# The labels below name these versions, and a label that quietly disagrees with what is
# inside is worse than no label at all. So the build records what npm actually resolved and
# fails outright if it is not what the labels are about to claim. `npm list` reads the
# installed tree — no CLI is invoked and nothing touches the network.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force \
    && npm list -g --depth=0 > /etc/agent-versions \
    && cat /etc/agent-versions \
    && { [ "${CLAUDE_VERSION}" = latest ] \
         || grep -q "@anthropic-ai/claude-code@${CLAUDE_VERSION}" /etc/agent-versions; } \
    && { [ "${CODEX_VERSION}" = latest ] \
         || grep -q "@openai/codex@${CODEX_VERSION}" /etc/agent-versions; }

# What is in here is the whole question when a deployment misbehaves, and `docker inspect`
# answers it without starting anything or shelling in.
LABEL org.opencontainers.image.title="AgentLodge agent" \
      org.opencontainers.image.description="Claude Code and Codex, sandboxed per user" \
      org.opencontainers.image.source="https://github.com/wrfly/AgentLodge" \
      dev.agentlodge.claude-code.version="${CLAUDE_VERSION}" \
      dev.agentlodge.codex.version="${CODEX_VERSION}"

RUN useradd -m -u 10001 -s /bin/bash agent

USER agent
ENV HOME=/home/agent \
    DISABLE_TELEMETRY=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_ERROR_REPORTING=1 \
    CODEX_HOME=/home/agent/.codex

# Fallback configuration. In normal operation both directories are covered by the
# per-user persistent directory mounted over them (see .agent-home in containers.ts); these
# are only the defaults for when nothing is mounted.
# The apikey and api entries are not optional: the container holds nothing but a gateway
# ticket, and the CLI must not drop into an interactive login.
RUN mkdir -p /home/agent/.claude /home/agent/.codex \
 && printf '%s\n' '{"includeCoAuthoredBy":false}' > /home/agent/.claude/settings.json \
 && printf '%s\n' 'preferred_auth_method = "apikey"' 'forced_login_method = "api"' \
      > /home/agent/.codex/config.toml

WORKDIR /workspace
# The container itself runs nothing; the CLI is started on demand with podman exec
CMD ["sleep", "infinity"]
