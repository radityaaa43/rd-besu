#!/usr/bin/env bash
# Mint a short-lived RS256 JWT for the stealth RPC node (Besu docs, use-besu-api/authenticate: payload `permissions` + `exp`). Prints the token only.
#   mint-token.sh --key-file <private.pem> [--ttl <seconds, default 900, max 3600>] --permissions eth:*,net:*,web3:*
# Key source for the one-off proofs (cluster admin): kubectl -n rd-stealth-<p> get secret stealth-rpc-jwt -o jsonpath='{.data.private\.pem}' | base64 -d > <tmpfs file>
# Permissions are limited to the eth/net/web3 groups; `*:*` is refused. The long-lived minter is project code inside the signer (stealth S9).
set -euo pipefail
key="" ttl=900 perms=""
while [[ $# -gt 0 ]]; do case "$1" in
  --key-file) key="${2:?}"; shift 2 ;;
  --ttl) ttl="${2:?}"; shift 2 ;;
  --permissions) perms="${2:?}"; shift 2 ;;
  *) echo "mint-token.sh: unknown option $1" >&2; exit 2 ;; esac; done
[[ -r "$key" ]] || { echo "mint-token.sh: --key-file missing or unreadable" >&2; exit 2; }
[[ "$ttl" =~ ^[0-9]+$ && "$ttl" -ge 1 && "$ttl" -le 3600 ]] || { echo "mint-token.sh: --ttl must be 1..3600" >&2; exit 2; }
[[ -n "$perms" ]] || { echo "mint-token.sh: --permissions needed" >&2; exit 2; }
list=""
IFS=',' read -ra P <<< "$perms"
for p in "${P[@]}"; do
  [[ "$p" =~ ^(eth|net|web3):(\*|[A-Za-z_]+)$ ]] || { echo "mint-token.sh: permission '$p' not allowed (eth|net|web3 groups only)" >&2; exit 2; }
  list+="${list:+,}\"$p\""
done
b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
iat="$(date +%s)"
hdr="$(printf '{"alg":"RS256","typ":"JWT"}' | b64u)"
pl="$(printf '{"permissions":[%s],"iat":%d,"exp":%d}' "$list" "$iat" "$((iat + ttl))" | b64u)"
sig="$(printf '%s.%s' "$hdr" "$pl" | openssl dgst -sha256 -sign "$key" | b64u)"
printf '%s.%s.%s\n' "$hdr" "$pl" "$sig"
