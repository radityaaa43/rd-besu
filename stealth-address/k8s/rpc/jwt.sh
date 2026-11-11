#!/usr/bin/env bash
# Generate the RS256 keypair of the stealth RPC node INSIDE the party namespace as Secret stealth-rpc-jwt (public.pem, private.pem).
# The pair lives only in a 077 tmpfs dir for the duration of the command (removed by trap), is never printed, never leaves the cluster.
# Only public.pem is mounted into besu-rpc; private.pem is read by the cluster admin when minting a one-off token (mint-token.sh).
#   KUBECONFIG=<party kubeconfig> ./jwt.sh <bi|bank-a|bank-b|bank-c>
set -euo pipefail
umask 077
party="${1:?usage: jwt.sh <bi|bank-a|bank-b|bank-c>}"
case "$party" in bi|bank-a|bank-b|bank-c) ;; *) echo "jwt.sh: unknown party '$party'" >&2; exit 2 ;; esac
command -v openssl >/dev/null || { echo "jwt.sh: openssl missing" >&2; exit 2; }
d="$(mktemp -d /dev/shm/stealth-jwt.XXXXXX)"
trap 'rm -rf "$d"' EXIT
openssl genrsa -out "$d/private.pem" 2048 2>/dev/null
openssl rsa -in "$d/private.pem" -pubout -out "$d/public.pem" 2>/dev/null
kubectl -n "rd-stealth-$party" create secret generic stealth-rpc-jwt --from-file=public.pem="$d/public.pem" --from-file=private.pem="$d/private.pem"
echo "jwt.sh: Secret stealth-rpc-jwt is in rd-stealth-$party (keys not shown)"
