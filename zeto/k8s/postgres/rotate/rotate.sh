#!/bin/bash
# S21 R1: replace the Paladin DB password of ONE party with a hex value generated here, inside the cluster. Runs as a one-shot Job (render.sh).
# The value never leaves this process: not in argv, not in a log, not on the host. Only step names, status codes and counts are printed. NO `set -x`.
# Order: generate -> ALTER ROLE (SQL on stdin) -> verify NEW works -> PATCH the Secret -> verify OLD fails -> GET the Secret (resourceVersion, new value held).
# If the Secret update fails after the ALTER: the old password is restored and "SECRET-NOT-UPDATED" is printed (exit 1); if the restore fails too: exit 2.
# The pinned postgres image has no curl/wget/kubectl, so the API calls are hand-written HTTP/1.1 over `openssl s_client` with the cluster CA (never -k).
set -uo pipefail
SA=/var/run/secrets/kubernetes.io/serviceaccount
API_HOST="${API_HOST:-${KUBERNETES_SERVICE_HOST:-}}"; API_PORT="${API_PORT:-${KUBERNETES_SERVICE_PORT:-443}}"
CA_FILE="${CA_FILE:-$SA/ca.crt}"; TOKEN_FILE="${TOKEN_FILE:-$SA/token}"
SECRET=paladin-pg-credentials
export HOME="${TMPDIR:-/tmp}"
export PGHOST="${PGHOST:-${PALADIN_PG_SERVICE_HOST:-paladin-pg}}"
fail() { echo "FAIL: $*"; exit "${2:-1}"; }
for v in API_HOST NS PGUSER PGDATABASE PGPASSWORD; do [ -n "${!v:-}" ] || fail "missing $v" 2; done
old="$PGPASSWORD"; STATUS=""; BODY=""

# api METHOD PATH [JSON]: sets STATUS (HTTP code, empty on a TLS/connect failure) and BODY (never printed)
api() {
  local method="$1" path="$2" body="${3-}" tok resp
  tok=$(cat "$TOKEN_FILE") || { STATUS=""; return 1; }
  resp=$({
    if [ -n "$body" ]; then
      sed 's/$/\r/' <<HEAD
$method $path HTTP/1.1
Host: $API_HOST
Authorization: Bearer $tok
Accept: application/json
Content-Type: application/merge-patch+json
Content-Length: ${#body}
Connection: close

HEAD
      printf '%s' "$body"
    else
      sed 's/$/\r/' <<HEAD
$method $path HTTP/1.1
Host: $API_HOST
Authorization: Bearer $tok
Accept: application/json
Connection: close

HEAD
    fi
  } | openssl s_client -quiet -ign_eof -verify_return_error -verify_ip "$API_HOST" -CAfile "$CA_FILE" -connect "$API_HOST:$API_PORT" 2>/dev/null)
  STATUS=$(printf '%s' "$resp" | sed -n '1s#^HTTP/[0-9.]* \([0-9][0-9]*\).*#\1#p')
  BODY="$resp"
  [ -n "$STATUS" ]
}
secret_path="/api/v1/namespaces/$NS/secrets/$SECRET"
rv() { printf '%s' "$BODY" | sed -n 's/.*"resourceVersion": *"\([0-9][0-9]*\)".*/\1/p' | head -1; }
sql() { psql -X -At -v ON_ERROR_STOP=1 "$@"; }
count_sql="select count(*) from pg_tables where schemaname='public'"

echo "step 1: generate (hex, 24 random bytes) and read state"
new=$(openssl rand -hex 24) || fail "openssl rand"
[[ "$new" =~ ^[0-9a-f]{48}$ ]] || fail "generated value has the wrong shape"
c0=$(sql -c "$count_sql") || fail "login with the current password"
api GET "$secret_path"; [ "$STATUS" = 200 ] || fail "GET Secret before: status '${STATUS:-none}' (TLS or RBAC)"
rv0=$(rv); [ -n "$rv0" ] || fail "no resourceVersion in the Secret"

echo "step 2: ALTER ROLE (SQL on stdin)"
printf 'ALTER ROLE "%s" PASSWORD %s;\n' "$PGUSER" "'$new'" | psql -X -q -v ON_ERROR_STOP=1 >/dev/null || fail "ALTER ROLE"

echo "step 3: verify the NEW password works"
PGPASSWORD="$new" sql -c 'select 1' >/dev/null || fail "NEW-LOGIN-FAILS after ALTER ROLE (the old password no longer works either: manual repair)" 2

echo "step 4: update the Secret"
b64=$(printf '%s' "$new" | base64 -w0)
api PATCH "$secret_path" '{"data":{"password":"'"$b64"'"}}'
if [ "$STATUS" != 200 ]; then
  echo "SECRET-NOT-UPDATED: PATCH status '${STATUS:-none}'"
  if printf 'ALTER ROLE "%s" PASSWORD %s;\n' "$PGUSER" "'$old'" | PGPASSWORD="$new" psql -X -q -v ON_ERROR_STOP=1 >/dev/null; then
    echo "old password restored"; exit 1
  fi
  echo "REVERT-FAILED: the database has the new password and the Secret the old one: manual repair"; exit 2
fi

echo "step 5: verify the OLD password fails"
if PGPASSWORD="$old" sql -c 'select 1' >/dev/null 2>&1; then fail "OLD password still works" 3; fi

echo "step 6: read back"
api GET "$secret_path"; [ "$STATUS" = 200 ] || fail "GET Secret after: status '${STATUS:-none}'" 4
rv1=$(rv)
printf '%s' "$BODY" | grep -q -F -f <(printf '"password":"%s"' "$b64") || fail "Secret does not hold the new value" 4
[ "$rv0" != "$rv1" ] || fail "resourceVersion did not change ($rv0)" 4
c1=$(PGPASSWORD="$new" sql -c "$count_sql") || fail "login with the new password after the update" 4
[ "$c0" = "$c1" ] || fail "table count changed $c0 -> $c1" 4
echo "ROTATED: Secret $SECRET resourceVersion before=$rv0 after=$rv1; old password rejected; new password works; public tables $c0 == $c1"
