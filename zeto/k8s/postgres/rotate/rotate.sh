#!/bin/bash
# S21 R1/D: replace the Paladin DB password of ONE party with a hex value generated here, inside the cluster, and put it where the node needs it:
#   - the live Paladin CR node<N> `spec.config` gets `db.postgres.dsn: postgres://<user>:<hex>@paladin-pg.<ns>.svc.cluster.local:5432/<db>?sslmode=disable`
#     (option D: no spec.database.passwordSecret and no dsnParams, so the fork never prints its `REMOVE: DSN=` WARN line; the git render has NO dsn);
#   - the Secret paladin-pg-credentials key `password` (kept consistent, so a re-init cannot diverge).
# The value never leaves this process: not in argv, not in a log, not on the host. Only step names, status codes and counts are printed. NO `set -x`.
# Order: generate -> ALTER ROLE (SQL on stdin) -> verify NEW works -> PATCH the CR -> PATCH the Secret -> verify OLD fails -> read back.
# Any failure after the ALTER restores what was changed (CR config, then the old DB password) and prints SECRET-NOT-UPDATED / CR-NOT-UPDATED (exit 1);
# if a restore fails too: exit 2 (manual repair). The pinned postgres image has no curl/wget/kubectl: the API calls are hand-written HTTP/1.1 over
# `openssl s_client` with the cluster CA (never -k); chunked responses are un-framed before parsing.
set -uo pipefail
SA=/var/run/secrets/kubernetes.io/serviceaccount
API_HOST="${API_HOST:-${KUBERNETES_SERVICE_HOST:-}}"; API_PORT="${API_PORT:-${KUBERNETES_SERVICE_PORT:-443}}"
CA_FILE="${CA_FILE:-$SA/ca.crt}"; TOKEN_FILE="${TOKEN_FILE:-$SA/token}"
SECRET=paladin-pg-credentials
export HOME="${TMPDIR:-/tmp}"
export PGHOST="${PGHOST:-${PALADIN_PG_SERVICE_HOST:-paladin-pg}}"
fail() { echo "FAIL: $*"; exit "${2:-1}"; }
for v in API_HOST NS NODE PGUSER PGDATABASE PGPASSWORD; do [ -n "${!v:-}" ] || fail "missing $v" 2; done
old="$PGPASSWORD"; STATUS=""; BODY=""

# api METHOD PATH [JSON]: sets STATUS (HTTP code, empty on a TLS/connect failure) and BODY (un-chunked, never printed)
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
Accept-Encoding: identity
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
Accept-Encoding: identity
Connection: close

HEAD
    fi
  } | openssl s_client -quiet -ign_eof -verify_return_error -verify_ip "$API_HOST" -CAfile "$CA_FILE" -connect "$API_HOST:$API_PORT" 2>/dev/null)
  STATUS=$(printf '%s' "$resp" | sed -n '1s#^HTTP/[0-9.]* \([0-9][0-9]*\).*#\1#p')
  # body = after the first blank line; drop chunk-size lines (a line of hex only), then join (compact JSON has no meaningful newline)
  BODY=$(printf '%s' "$resp" | sed '1,/^\r*$/d' | sed -E '/^[0-9a-fA-F]+\r?$/d' | tr -d '\r\n')
  [ -n "$STATUS" ]
}
secret_path="/api/v1/namespaces/$NS/secrets/$SECRET"
cr_path="/apis/core.paladin.io/v1alpha1/namespaces/$NS/paladins/$NODE"
rv() { printf '%s' "$BODY" | sed -n 's/.*"resourceVersion": *"\([0-9][0-9]*\)".*/\1/p' | head -1; }
sql() { psql -X -At -v ON_ERROR_STOP=1 "$@"; }
count_sql="select count(*) from pg_tables where schemaname='public'"
set_role_password() { printf 'ALTER ROLE "%s" PASSWORD %s;\n' "$PGUSER" "'$1'"; }
patch_cr() { api PATCH "$cr_path" '{"spec":{"config":"'"$1"'"}}'; [ "$STATUS" = 200 ]; }

echo "step 1: generate (hex, 24 random bytes) and read state"
new=$(openssl rand -hex 24) || fail "openssl rand"
[[ "$new" =~ ^[0-9a-f]{48}$ ]] || fail "generated value has the wrong shape"
c0=$(sql -c "$count_sql") || fail "login with the current password"
api GET "$secret_path"; [ "$STATUS" = 200 ] || fail "GET Secret before: status '${STATUS:-none}' (TLS or RBAC)"
rv0=$(rv); [ -n "$rv0" ] || fail "no resourceVersion in the Secret"
api GET "$cr_path"; [ "$STATUS" = 200 ] || fail "GET Paladin CR $NODE: status '${STATUS:-none}' (TLS or RBAC)"
# the JSON string value of spec.config (a YAML text with \n and \" escapes), taken from the live CR so ONLY the dsn line changes
oldcfg=$(printf '%s' "$BODY" | grep -o -E '"config":"([^"\\]|\\.)*"' | head -1 | sed -e 's/^"config":"//' -e 's/"$//')
[ -n "$oldcfg" ] || fail "no spec.config in the CR"
n_pg=$(printf '%s' "$oldcfg" | grep -o -F '\n  postgres:\n' | wc -l)
[ "$n_pg" = 1 ] || fail "spec.config must contain exactly one '  postgres:' line under db (found $n_pg)"
if printf '%s' "$oldcfg" | grep -q -E 'dsnParams|\{\{\.password\}\}|passwordSecret'; then fail "spec.config still has the templated DSN (dsnParams/{{.password}}): apply the option-D CR render first"; fi
dsn_line='    dsn: postgres://'"$PGUSER"':%s@paladin-pg.'"$NS"'.svc.cluster.local:5432/'"$PGDATABASE"'?sslmode=disable'
# drop a dsn line left by an earlier run, then insert the new one right after `  postgres:`; the sed script comes from a pipe, so the value is not in argv
base=$(printf '%s' "$oldcfg" | sed -e 's/\\n    dsn: [^\\]*//')
newcfg=$(printf '%s' "$base" | sed -f <(printf 's#\\\\n  postgres:\\\\n#\\\\n  postgres:\\\\n%s\\\\n#\n' "$(printf "$dsn_line" "$new")"))
[ "$newcfg" != "$base" ] || fail "inserting the dsn line changed nothing"

echo "step 2: ALTER ROLE (SQL on stdin)"
set_role_password "$new" | psql -X -q -v ON_ERROR_STOP=1 >/dev/null || fail "ALTER ROLE"

echo "step 3: verify the NEW password works"
PGPASSWORD="$new" sql -c 'select 1' >/dev/null || fail "NEW-LOGIN-FAILS after ALTER ROLE (the old password no longer works either: manual repair)" 2
revert_db() { set_role_password "$old" | PGPASSWORD="$new" psql -X -q -v ON_ERROR_STOP=1 >/dev/null; }

echo "step 4: update the Paladin CR spec.config (dsn line only)"
if ! patch_cr "$newcfg"; then
  echo "CR-NOT-UPDATED: PATCH status '${STATUS:-none}'"
  if revert_db; then echo "old password restored"; exit 1; fi
  echo "REVERT-FAILED: the database has the new password and the CR the old one: manual repair"; exit 2
fi

echo "step 5: update the Secret (kept consistent)"
b64=$(printf '%s' "$new" | base64 -w0)
api PATCH "$secret_path" '{"data":{"password":"'"$b64"'"}}'
if [ "$STATUS" != 200 ]; then
  echo "SECRET-NOT-UPDATED: PATCH status '${STATUS:-none}'"
  if patch_cr "$oldcfg" && revert_db; then echo "CR and old password restored"; exit 1; fi
  echo "REVERT-FAILED: manual repair (CR config and/or database password)"; exit 2
fi

echo "step 6: verify the OLD password fails, read back"
if PGPASSWORD="$old" sql -c 'select 1' >/dev/null 2>&1; then fail "OLD password still works" 3; fi
api GET "$secret_path"; [ "$STATUS" = 200 ] || fail "GET Secret after: status '${STATUS:-none}'" 4
rv1=$(rv)
printf '%s' "$BODY" | grep -q -F -f <(printf '"password":"%s"' "$b64") || fail "Secret does not hold the new value" 4
[ "$rv0" != "$rv1" ] || fail "Secret resourceVersion did not change ($rv0)" 4
api GET "$cr_path"; [ "$STATUS" = 200 ] || fail "GET Paladin CR after: status '${STATUS:-none}'" 4
printf '%s' "$BODY" | grep -q -F -f <(printf '%s' "$(printf "$dsn_line" "$new")") || fail "CR spec.config does not hold the new dsn line" 4
c1=$(PGPASSWORD="$new" sql -c "$count_sql") || fail "login with the new password after the update" 4
[ "$c0" = "$c1" ] || fail "table count changed $c0 -> $c1" 4
echo "ROTATED: CR $NODE spec.config dsn set, Secret $SECRET resourceVersion before=$rv0 after=$rv1; old password rejected; new password works; public tables $c0 == $c1"
