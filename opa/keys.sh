#!/usr/bin/env bash
# Bundle signing keys, one per owner: bi, bank-a, bank-b, bank-c (the bank-bi bundle of node 1 is BI's, signed with bi).
# Private keys (<id>.pem, mode 600) stay in $OPA_KEYS_DIR (default ~/.opa-keys), OUTSIDE the repo; never commit them.
# Existing private keys are never overwritten. Also renders $OPA_KEYS_DIR/opa-config.yaml = opa.yaml + the public keys,
# which is what ConfigMap bank-gw-opa-v2 carries (see README).
set -euo pipefail
DIR=${OPA_KEYS_DIR:-$HOME/.opa-keys}
HERE=$(cd "$(dirname "$0")" && pwd)
IDS="bi bank-a bank-b bank-c"
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
for id in $IDS; do
  [ -f "$DIR/$id.pem" ] || openssl genrsa -out "$DIR/$id.pem" 2048 2>/dev/null
  openssl rsa -in "$DIR/$id.pem" -pubout -out "$DIR/$id.pub" 2>/dev/null
done
{
  cat "$HERE/opa.yaml"
  echo "keys:"
  for id in $IDS; do
    printf '  %s:\n    algorithm: RS256\n    key: |\n' "$id"
    sed 's/^/      /' "$DIR/$id.pub"
  done
} > "$DIR/opa-config.yaml"
echo "keys in $DIR: $(ls "$DIR" | tr '\n' ' ')"
