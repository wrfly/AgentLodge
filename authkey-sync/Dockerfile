FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/authkey-sync .

# Ship the mountpoint inside the image so a fresh named volume inherits this
# ownership and mode instead of whatever Docker would invent.
RUN install -d -m 0755 /skel/data/secrets

FROM scratch

COPY --from=build /out/authkey-sync /usr/local/bin/authkey-sync
COPY --from=build /skel/data /data

# Reads /input/.credentials.json and writes /data/secrets/auth.key unless told
# otherwise, so mounting is the only setup step.
#
# Runs as root on purpose: the credentials file it reads is typically mode 0600
# owned by the host user, and the key it writes has to end up owned by whichever
# uid the consuming containers run as. compose.yml drops every capability except
# the two that requires. See README.md for running unprivileged instead.
ENTRYPOINT ["/usr/local/bin/authkey-sync"]
