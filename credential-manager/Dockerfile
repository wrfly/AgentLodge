FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/credential-manager .

FROM scratch

COPY --from=build /out/credential-manager /usr/local/bin/credential-manager

# The credential manager is the credential authority: it holds upstream subscription
# refresh tokens and serves short-lived access tokens to the gateway over a
# Unix domain socket. It binds /run/agentlodge/credential-manager.sock (CREDENTIAL_MANAGER_SOCKET) and
# reads the host's `claude login` / `codex login` credentials from the mounted
# directories. It writes no secrets to plain files — persisted token state, when
# CREDENTIAL_MANAGER_STATE_FILE is set, is AES-256-GCM encrypted.
ENTRYPOINT ["/usr/local/bin/credential-manager"]
