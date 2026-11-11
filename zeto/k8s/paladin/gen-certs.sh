#!/usr/bin/env bash
# zeto S10: per-node mTLS material for the Paladin gRPC transport (PLAN S10, orchestrator decision: own CA per node, no shared CA).
#   PALADIN_MTLS_DIR=<dir outside the repo, tmpfs preferred, must not exist> gen-certs.sh <bi|bank-a|bank-b|bank-c> <LB IPv4>
# Writes ca.crt/ca.key (own CA, 5 years) and tls.crt/tls.key (CN = node<N>, SAN IP = the LB IP, serverAuth+clientAuth, 1 year); dir 700, files 600.
# Paladin verifies a peer by CN = node name and by the issuer it publishes in the registry (no SAN/hostname check: tls_verifier.go:138-195), so CN is what matters.
# The caller puts tls.crt, tls.key, ca.crt into Secret paladin-node<N>-mtls and ca.key into the party's own Secret by a pipe, then removes the dir. Prints no key.
set -euo pipefail
case "${1:-}" in bi) n=1 ;; bank-a) n=2 ;; bank-b) n=3 ;; bank-c) n=4 ;; *) echo "gen-certs.sh: party must be bi|bank-a|bank-b|bank-c" >&2; exit 2 ;; esac
ip="${2:-}"; [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "gen-certs.sh: second argument must be the LB IPv4" >&2; exit 2; }
dir="${PALADIN_MTLS_DIR:?set PALADIN_MTLS_DIR to a new directory outside the repo}"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
case "$(realpath -m "$dir")" in "$repo"/*) echo "gen-certs.sh: refusing $dir: inside the repo" >&2; exit 1 ;; esac
[[ ! -e "$dir" ]] || { echo "gen-certs.sh: $dir exists, refusing to overwrite" >&2; exit 1; }
umask 077
mkdir -p "$dir"; chmod 700 "$dir"; cd "$dir"
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 1825 -subj "/CN=paladin-node$n CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt
openssl ecparam -name prime256v1 -genkey -noout -out tls.key
openssl req -new -key tls.key -subj "/CN=node$n" -out tls.csr
{ echo "basicConstraints=CA:FALSE"; echo "keyUsage=digitalSignature"; echo "extendedKeyUsage=serverAuth,clientAuth"; echo "subjectAltName=IP:$ip"; } > tls.ext
openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 365 -extfile tls.ext -out tls.crt 2>/dev/null
rm -f tls.csr tls.ext ca.srl
chmod 600 ./*
echo "wrote $dir: ca.crt ca.key tls.crt tls.key (CN=node$n, SAN IP:$ip)"
