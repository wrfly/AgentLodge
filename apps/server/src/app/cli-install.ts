/**
 * The one-liner that points a user's own Claude Code at this server.
 *
 * **The credential is a file, not an environment variable.** ANTHROPIC_BASE_URL is not an
 * auth source — with an empty config directory `claude auth status` reports
 * `{"loggedIn": false, "authMethod": "none"}`, which is why setting it alone still asks the
 * user to sign in. The credentials file *is* that sign-in, and we issue it: with the file in
 * place the same command reports
 * `{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}`, a turn runs
 * against this gateway carrying `Authorization: Bearer <key>`, the allowance headers we send
 * are honoured, and `/usage` prints no figures and makes no outbound connection at all.
 * Nothing rides in a URL either, so the key stays out of shell history and screenshots.
 *
 * **CLAUDE_CONFIG_DIR is what keeps this safe.** The file goes in a directory of ours, so a
 * user's own `~/.claude` login is never touched. The cost is that the AgentLodge session is
 * a separate profile: its own settings.json, MCP servers and history.
 *
 * **This uses an undocumented file format.** The field names come from the CLI's own OAuth
 * save path (`accessToken`, `refreshToken`, `expiresAt`, `scopes`, `subscriptionType`,
 * `rateLimitTier`, `clientId`). The two scopes are load-bearing: `user:inference` is what
 * makes the session count as signed in, `user:profile` is what the account panel checks. A
 * future release can change any of it, so this is a convenience, not a contract.
 */

/**
 * Where the console drops the key into the command.
 *
 * Only the command carries it: the script itself is downloaded from this server and is the
 * same for everybody, so it can be served unauthenticated and read before it is run. The
 * key exists in plaintext exactly once, in the response that created it — the server keeps
 * only a hash and could not fill it in later even if it wanted to.
 */
export const KEY_PLACEHOLDER = '__AGENTLODGE_KEY__';

/** Where the script is served from — see app/routes/cli.ts */
export const SCRIPT_PATH = '/api/cli/install.sh';

/**
 * How long the CLI should consider the credential fresh, in milliseconds.
 *
 * Not a security control: revoking happens here, and takes effect on the next request. It is
 * only there so the CLI does not decide the session is stale and try to refresh it against
 * an endpoint that knows nothing about us. The wrapper recomputes it on every run, so it
 * never goes stale on a machine that has been installed for a long time.
 */
const VALID_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface InstallText {
  /** Wrapper messages, so the script speaks the language the console is in */
  installed: string;
  openShell: string;
  keyFile: string;
  undo: string;
  noClaude: string;
  usage: string;
  noKeyFile: string;
}

/** What the console shows: one line, with the key dropped in where the placeholder is */
export function installCommand(baseUrl: string): string {
  return `curl -fsSL ${baseUrl.replace(/\/+$/, '')}${SCRIPT_PATH} | sh -s -- ${KEY_PLACEHOLDER}`;
}

/**
 * The script that command downloads.
 *
 * The key arrives as an argument and is written to a file of its own; the wrapper reads that
 * file on every run and rebuilds the credentials from it. Replacing a key is therefore one
 * edit — no reinstall, and nothing else in the directory has to be understood to do it.
 */
export function installScript(baseUrl: string, text: InstallText): string {
  const base = baseUrl.replace(/\/+$/, '');

  return `#!/bin/sh
# Points the Claude Code on this machine at AgentLodge.
#
# It writes one directory and one line:
#   ~/.agentlodge/key          the key, on its own — replace it here, nothing else to redo
#   ~/.agentlodge/claude       a config directory of its own, rebuilt from that key on each run
#   ~/.agentlodge/bin/claude   a wrapper that runs the real claude against it
#   one line on your shell rc, putting that bin directory first on PATH
#
# Your own claude.ai login lives in ~/.claude and is not read, written or displaced.
set -eu

KEY="\${1:-}"
if [ -z "$KEY" ]; then
  echo '${text.usage}' >&2
  exit 1
fi

BASE_URL='${base}'
ROOT="\${AGENTLODGE_HOME:-$HOME/.agentlodge}"
MARK='# agentlodge'

case "\${SHELL##*/}" in
  zsh)  RC="$HOME/.zshrc" ;;
  bash) if [ -f "$HOME/.bash_profile" ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
  *)    RC="$HOME/.profile" ;;
esac

# Resolved before our own bin directory is on PATH, and remembered — otherwise a second run
# would find the wrapper and have it call itself.
if [ -f "\$ROOT/real-claude" ]; then
  REAL=\$(cat "\$ROOT/real-claude")
else
  REAL=\$(command -v claude || true)
fi
if [ -z "\$REAL" ] || [ ! -x "\$REAL" ]; then
  echo '${text.noClaude}' >&2
  exit 1
fi

mkdir -p "\$ROOT/claude" "\$ROOT/bin"
printf '%s\\n' "\$REAL" > "\$ROOT/real-claude"

umask 077
printf '%s\\n' "\$KEY" > "\$ROOT/key"
chmod 600 "\$ROOT/key"

# A config directory of our own starts with no onboarding state, so Claude Code runs its
# first-run wizard — pick a theme, then sign in — even though the credential is already
# there. Measured: without this line the wrapper opens on "Welcome to Claude Code / Let's
# get started" and asks the user to log in, which is the one thing this whole script exists
# to avoid. Marking onboarding done skips straight to the prompt.
CONFIG="\$ROOT/claude/.claude.json"
if [ ! -f "\$CONFIG" ]; then
  printf '%s\\n' '{"hasCompletedOnboarding":true}' > "\$CONFIG"
elif ! grep -q 'hasCompletedOnboarding' "\$CONFIG"; then
  # Inserted after the opening brace, so whatever the CLI has already written is kept.
  # A temp file rather than sed -i, which takes a different argument on BSD.
  sed '1s/^{/{"hasCompletedOnboarding":true,/' "\$CONFIG" > "\$CONFIG.tmp" && mv "\$CONFIG.tmp" "\$CONFIG"
fi

cat > "\$ROOT/bin/claude" <<WRAPPER
#!/bin/sh
# The credential is rebuilt from the key file on every run, so replacing the key is one edit.
set -eu
ROOT='\$ROOT'
if [ ! -r "\\$ROOT/key" ]; then
  echo '${text.noKeyFile}' >&2
  exit 1
fi
umask 077
TMP="\\$ROOT/claude/.credentials.json.\\$\\$"
printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"","expiresAt":%s,"scopes":["user:inference","user:profile"],"subscriptionType":"max"}}\\n' \\
  "\\$(cat "\\$ROOT/key")" "\\$(( \\$(date +%s) * 1000 + ${VALID_MS} ))" > "\\$TMP"
mv "\\$TMP" "\\$ROOT/claude/.credentials.json"
# A key exported in the environment outranks the credential file and would send the session
# straight upstream instead of here, with no quota and no accounting.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CLAUDE_CONFIG_DIR="\\$ROOT/claude"
export ANTHROPIC_BASE_URL='\$BASE_URL'
exec '\$REAL' "\\$@"
WRAPPER
chmod +x "\$ROOT/bin/claude"

cat > "\$ROOT/uninstall.sh" <<UNINSTALL
#!/bin/sh
set -eu
# grep exits 1 when it selects nothing, which is exactly the case where the rc file holds our
# line and nothing else — without the fallback that line would survive the uninstall.
if [ -f '\$RC' ]; then
  grep -v '\$MARK' '\$RC' > '\$RC.agentlodge.tmp' || true
  mv '\$RC.agentlodge.tmp' '\$RC'
fi
rm -rf '\$ROOT'
echo 'AgentLodge removed. Your own claude is unchanged.'
UNINSTALL
chmod +x "\$ROOT/uninstall.sh"

if ! grep -q "\$MARK" "\$RC" 2>/dev/null; then
  printf '%s\\n' "export PATH=\\"\$ROOT/bin:\\\$PATH\\"  \$MARK" >> "\$RC"
fi

echo '${text.installed}'
echo "  ${text.openShell}"
echo "  ${text.keyFile} \$ROOT/key"
echo "  ${text.undo} \$ROOT/uninstall.sh"
`;
}
