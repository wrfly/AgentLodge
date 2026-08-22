#!/bin/bash
# AgentLodge smoke test — everything that costs no tokens.
#
#   npm run selftest            # defaults to localhost:8787
#   API=http://x:8787 npm run selftest
#
# Needs the service already running and two accounts to exist: an administrator and an
# ordinary user. Override any of these to point at a different pair.
#
#   ALICE_EMAIL / ALICE_PW    the administrator
#   BOB_EMAIL   / BOB_PW      the ordinary user, used for the isolation checks
#
# Note that repeated failed sign-ins trip the login throttle for 15 minutes, so a run
# against an instance where these accounts do not exist will lock the address out for a
# while. That is why the sign-in below aborts rather than carrying on.
API=${API:-http://localhost:8787}
ALICE_EMAIL=${ALICE_EMAIL:-alice@example.com}
BOB_EMAIL=${BOB_EMAIL:-bob@example.com}
ALICE_PW=${ALICE_PW:-newpassword456}
BOB_PW=${BOB_PW:-password123}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ✓ $1"; }
no() { fail=$((fail+1)); echo "  ✗ $1   $2"; }
t()  { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "want[$2] got[$3]"; fi; }
jq_() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

echo "── Authentication ──"
LOGIN=$(curl -s -X POST $API/api/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$ALICE_EMAIL\",\"password\":\"$ALICE_PW\"}" -c "$TMP/jar")
AT=$(echo "$LOGIN" | jq_ "d.get('accessToken','')")
if [ -z "$AT" ]; then
  # Everything downstream needs this token. Carrying on would turn one missing account into
  # forty cascading 401s that read like the product is broken, and each retry pushes the
  # login throttle further out.
  echo "  ✗ cannot sign in as $ALICE_EMAIL"
  echo "      $LOGIN"
  echo
  echo "  This smoke test needs an administrator and an ordinary user to already exist."
  echo "  Point it at yours:  ALICE_EMAIL=… ALICE_PW=… BOB_EMAIL=… BOB_PW=… npm run selftest"
  exit 1
fi
ok "signing in returns an access token"
t "signing in returns the user" "$ALICE_EMAIL" "$(echo "$LOGIN" | jq_ "d['user']['email']")"
t "a wrong password is refused" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$ALICE_EMAIL\",\"password\":\"wrong\"}")"
t "no token is refused" "401" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/conversations)"
t "a forged token is refused" "401" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/conversations -H 'authorization: Bearer forged.token.here')"
REFRESH=$(curl -s -X POST $API/api/auth/refresh -b "$TMP/jar" -c "$TMP/jar")
NEW_AT=$(echo "$REFRESH" | jq_ "d.get('accessToken','')")
[ -n "$NEW_AT" ] && ok "refresh renews the session" || no "refresh" "$REFRESH"
# Rotation invalidates the parent session, so the old access token dies at once. By design.
t "the old access token dies on rotation" "401" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/conversations -H "authorization: Bearer $AT")"
AT="$NEW_AT"
t "the new access token works" "200" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/conversations -H "authorization: Bearer $AT")"

echo "── Conversation CRUD ──"
# A deliberately non-ASCII title: it has to survive JSON, SQLite, and the way back out.
CID=$(curl -s -X POST $API/api/conversations -H "authorization: Bearer $AT" -H 'content-type: application/json' \
  -d '{"agent":"claude","title":"selftest 自测 · тест"}' | jq_ "d['id']")
[ -n "$CID" ] && ok "creating a conversation" || no "creating a conversation" ""
t "reading it back, non-ASCII intact" "selftest 自测 · тест" "$(curl -s $API/api/conversations/$CID -H "authorization: Bearer $AT" | jq_ "d['title']")"
curl -s -X PATCH $API/api/conversations/$CID -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"title":"renamed"}' -o /dev/null
t "renaming" "renamed" "$(curl -s $API/api/conversations/$CID -H "authorization: Bearer $AT" | jq_ "d['title']")"
curl -s -X PATCH $API/api/conversations/$CID -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"model":"test-model","effort":"high"}' -o /dev/null
t "setting the model" "test-model" "$(curl -s $API/api/conversations/$CID -H "authorization: Bearer $AT" | jq_ "d['model']")"
t "setting the effort" "high" "$(curl -s $API/api/conversations/$CID -H "authorization: Bearer $AT" | jq_ "d['effort']")"
t "it appears in the list" "True" "$(curl -s "$API/api/conversations?agent=claude" -H "authorization: Bearer $AT" | jq_ "any(c['id']=='$CID' for c in (d if isinstance(d,list) else d.get('conversations',[])))")"

echo "── Isolation between users ──"
BT=$(curl -s -X POST $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$BOB_EMAIL\",\"password\":\"$BOB_PW\"}" | jq_ "d.get('accessToken','')")
[ -n "$BT" ] || no "signing in as $BOB_EMAIL" "the isolation checks below will all report 401"
t "bob cannot read alice's conversation" "404" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/conversations/$CID -H "authorization: Bearer $BT")"
t "bob cannot delete alice's conversation" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/api/conversations/$CID -H "authorization: Bearer $BT")"
t "an ordinary user cannot reach the admin API" "403" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/admin/users -H "authorization: Bearer $BT")"
t "an ordinary user cannot change a provider" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/api/admin/providers -H "authorization: Bearer $BT" -H 'content-type: application/json' -d '{"name":"x","kind":"mock"}')"

echo "── Workspace files ──"
echo "hello from selftest" > "$TMP/up.txt"
t "uploading a file" "True" "$(curl -s -X POST "$API/api/conversations/$CID/files" -H "authorization: Bearer $AT" -F "file=@$TMP/up.txt" | jq_ "bool(d)")"
t "it shows up in the listing" "True" "$(curl -s "$API/api/conversations/$CID/files" -H "authorization: Bearer $AT" | jq_ "any('up.txt' in (f.get('path') or '') for f in (d if isinstance(d,list) else d.get('files',[])))")"
t "the preview has the right contents" "1" "$(curl -s "$API/api/conversations/$CID/files/preview?path=up.txt" -H "authorization: Bearer $AT" | grep -c 'hello from selftest')"
t "directory traversal is blocked (resolveInside returns null)" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/conversations/$CID/files/preview?path=../../../etc/passwd" -H "authorization: Bearer $AT")"
curl -s -X DELETE "$API/api/conversations/$CID/files?path=up.txt" -H "authorization: Bearer $AT" -o /dev/null
t "deleting a file" "False" "$(curl -s "$API/api/conversations/$CID/files" -H "authorization: Bearer $AT" | jq_ "any('up.txt' in (f.get('path') or '') for f in (d if isinstance(d,list) else d.get('files',[])))")"

echo "── Memory ──"
curl -s -X PUT $API/api/me/memory -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"content":"# selftest memory\nCodename SELFTEST-1"}' -o /dev/null
t "writing memory and reading it back" "True" "$(curl -s $API/api/me/memory -H "authorization: Bearer $AT" | jq_ "'SELFTEST-1' in (d.get('content') or '')")"

echo "── Request traces (per-user visibility) ──"
t "own trace list is readable" "True" "$(curl -s $API/api/me/traces -H "authorization: Bearer $AT" | jq_ "'traces' in d")"
t "signed out reads nothing" "401" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/me/traces)"
t "a malformed id is blocked" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/me/traces/..%2f..%2fetc" -H "authorization: Bearer $AT")"
TRID=$(curl -s $API/api/me/traces -H "authorization: Bearer $AT" | jq_ "(d['traces'][0]['id'] if d['traces'] else '')")
if [ -n "$TRID" ]; then
  t "own trace detail is readable" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/me/traces/$TRID" -H "authorization: Bearer $AT")"
  t "somebody else holding the id still cannot read it" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/me/traces/$TRID" -H "authorization: Bearer $BT")"
else
  echo "  · skipping the detail check (no trace data yet)"
fi

echo "── Quota and usage ──"
t "the quota endpoint answers" "True" "$(curl -s $API/api/me/quota -H "authorization: Bearer $AT" | jq_ "'used' in d")"
t "the usage endpoint answers" "True" "$(curl -s $API/api/me/usage -H "authorization: Bearer $AT" | jq_ "bool(d)")"

echo "── Admin console ──"
t "user list" "True" "$(curl -s $API/api/admin/users -H "authorization: Bearer $AT" | jq_ "len(d if isinstance(d,list) else d.get('users',[]))>=2")"
t "invite codes" "True" "$(curl -s $API/api/admin/invites -H "authorization: Bearer $AT" | jq_ "isinstance(d,(list,dict))")"
t "system settings, encrypted entries included" "True" "$(curl -s $API/api/admin/settings -H "authorization: Bearer $AT" | jq_ "bool(d)")"
t "audit log" "True" "$(curl -s $API/api/admin/audit-logs -H "authorization: Bearer $AT" | jq_ "isinstance(d,(list,dict))")"
t "provider list" "True" "$(curl -s $API/api/admin/providers -H "authorization: Bearer $AT" | jq_ "any(p['active'] for p in d['providers'])")"
GATE=$(curl -s $API/api/admin/gate -H "authorization: Bearer $AT")
t "gate status: enabled" "True" "$(echo "$GATE" | jq_ "d['enabled']")"
t "gate status: containers ready" "True" "$(echo "$GATE" | jq_ "d['containers']['ok']")"
t "concurrency limit is changeable (forwarded over HTTP to the gateway)" "5" "$(curl -s -X PATCH $API/api/admin/gate -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"maxConcurrency":5}' | jq_ "d.get('max', d.get('effectiveMax'))")"
curl -s -X PATCH $API/api/admin/gate -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"maxConcurrency":3}' -o /dev/null
t "an out-of-range concurrency limit is refused" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/api/admin/gate -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"maxConcurrency":999}')"

echo "── Metering gateway authentication ──"
GW=${GW:-http://127.0.0.1:8788}
t "no ticket is refused" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/v1/messages -H 'content-type: application/json' -d '{"model":"x","messages":[]}')"
t "a forged ticket is refused" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/v1/messages -H 'authorization: Bearer fake' -H 'content-type: application/json' -d '{"model":"x","messages":[]}')"
# This endpoint forwards using the real upstream key, so it must never be open
t "count_tokens needs authentication too" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/v1/messages/count_tokens -H 'content-type: application/json' -d '{"model":"x","messages":[]}')"

echo "── API keys (the bring-your-own-CLI entrance) ──"
MSG='{"model":"claude-sonnet-4-5","max_tokens":32,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
t "an empty name is refused" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/api/me/api-keys -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"name":"  "}')"
NEWKEY=$(curl -s -X POST $API/api/me/api-keys -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"name":"selftest"}')
PLAIN=$(echo "$NEWKEY" | jq_ "d['plaintext']")
KID=$(echo "$NEWKEY" | jq_ "d['key']['id']")
case "$PLAIN" in al_*) ok "creation returns the plaintext, prefixed al_";; *) no "creating a key" "$NEWKEY";; esac
t "the listing holds no plaintext" "False" "$(curl -s $API/api/me/api-keys -H "authorization: Bearer $AT" | jq_ "'$PLAIN' in json.dumps(d)")"
t "Authorization: Bearer works" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/v1/messages -H "authorization: Bearer $PLAIN" -H 'content-type: application/json' -d "$MSG")"
t "x-api-key works too" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/v1/messages -H "x-api-key: $PLAIN" -H 'content-type: application/json' -d "$MSG")"
t "codex's /v1/responses works" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/v1/responses -H "authorization: Bearer $PLAIN" -H 'content-type: application/json' -d '{"model":"m","stream":true,"input":[{"role":"user","content":"hi"}]}')"
t "usage is attributed to this key" "True" "$(curl -s $API/api/me/api-keys -H "authorization: Bearer $AT" | jq_ "any(k['id']=='$KID' and (k['usage'] or {}).get('calls',0)>0 for k in d['keys'])")"
t "bob cannot revoke alice's key" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/api/me/api-keys/$KID -H "authorization: Bearer $BT")"
t "revoking your own" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/api/me/api-keys/$KID -H "authorization: Bearer $AT")"
t "a revoked key dies immediately" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $GW/v1/messages -H "authorization: Bearer $PLAIN" -H 'content-type: application/json' -d "$MSG")"
t "revoking twice is a 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/api/me/api-keys/$KID -H "authorization: Bearer $AT")"

echo "── Audit proxy enforcement ──"
PROV=$(curl -s $API/api/admin/providers -H "authorization: Bearer $AT")
ACTIVE_ID=$(echo "$PROV" | jq_ "next((p['id'] for p in d['providers'] if p['active']), '')")
OLD_BASE=$(echo "$PROV" | jq_ "next((p['baseUrl'] for p in d['providers'] if p['active']), '')")
t "a provider no longer carries auditProxyUrl (it is global now)" "True" "$(echo "$PROV" | jq_ "not any('auditProxyUrl' in p for p in d['providers'])")"
# Loopback upstreams are exempt, so the local one is allowed today; a public address depends
# on whether the server has AUDIT_PROXY_URL configured.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/api/admin/providers/$ACTIVE_ID -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"baseUrl":"https://api.anthropic.com"}')
if [ "$CODE" = "400" ]; then
  ok "with no audit proxy configured, switching to a public upstream is refused"
elif [ "$CODE" = "200" ]; then
  ok "with an audit proxy configured, an allowlisted public upstream is permitted"
else
  no "switching to a public upstream" "wanted 400 or 200, got $CODE"
fi
# Put it back, rather than leave the dev environment on a broken configuration
curl -s -X PATCH $API/api/admin/providers/$ACTIVE_ID -H "authorization: Bearer $AT" -H 'content-type: application/json' -d "{\"baseUrl\":\"$OLD_BASE\"}" -o /dev/null
t "the original configuration is restored" "True" "$(curl -s $API/api/admin/providers -H "authorization: Bearer $AT" | jq_ "next((p['baseUrl'] for p in d['providers'] if p['active']), '') == '$OLD_BASE'")"

echo "── Audit proxy settings ──"
AP=$(curl -s $API/api/admin/audit-proxy -H "authorization: Bearer $AT")
t "the endpoint answers" "True" "$(echo "$AP" | jq_ "'configured' in d")"
if [ "$(echo "$AP" | jq_ "d.get('editable') is True")" = "True" ]; then
  t "the locked retry setting cannot be changed" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/api/admin/audit-proxy -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"retry":3}')"
  t "a malformed host is refused" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/api/admin/audit-proxy -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"allow":["a.com/../b"]}')"
else
  echo "  · skipped (no audit proxy running here, which is the dev default)"
fi

echo "── Server-side error localisation ──"
# Deliberately an unauthenticated GET rather than a failed sign-in: the login path is
# throttled, and a locale check has no business burning attempts against that counter.
LOC() { curl -s $API/api/conversations ${1:+-H "accept-language: $1"} | jq_ "d.get('error','')"; }
EN=$(LOC); ZH=$(LOC zh-CN); JA=$(LOC ja); DE=$(LOC de-DE); QV=$(LOC 'ja;q=0.2,zh-CN;q=0.9')
[ -n "$EN" ] && ok "an error comes back with no Accept-Language" || no "default locale" "empty error"
[ "$ZH" != "$EN" ] && ok "Accept-Language: zh-CN changes the message" || no "zh-CN" "same as English: $ZH"
[ "$JA" != "$EN" ] && [ "$JA" != "$ZH" ] && ok "ja is its own translation" || no "ja" "got [$JA]"
t "an unknown language falls back to English" "$EN" "$DE"
t "q-values pick the highest-weighted match" "$ZH" "$QV"

echo "── Cleanup ──"
curl -s -X DELETE $API/api/conversations/$CID -H "authorization: Bearer $AT" -o /dev/null
t "deleting the conversation" "404" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/conversations/$CID -H "authorization: Bearer $AT")"

echo
echo "════ $pass passed · $fail failed ════"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
