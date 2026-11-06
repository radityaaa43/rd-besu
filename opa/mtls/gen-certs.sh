#!/bin/bash
# mTLS material for the OPA gateways, written OUTSIDE the repo (default ~/.opa-mtls, dir 700, files 600). Never commit it.
#   ca.crt / ca.key          private CA (5 years), signs everything below
#   gw-N.crt / gw-N.key      server cert of bank-gw-N (1 year); SAN: the service names, localhost, 127.0.0.1
#   lensa.crt / lensa.key    Lensa's client cert (1 year), clientAuth only
# Idempotent: an existing file is kept. FORCE=1 re-issues the leaf certs (not the CA); delete ca.* by hand to rotate the CA.
# The Secret per gateway is created from these files (README, "mTLS"); Lensa reads LENSA_GW_MTLS_DIR=<this dir>.
set -euo pipefail
DIR="${OPA_MTLS_DIR:-$HOME/.opa-mtls}"
case "$DIR" in "$(cd "$(dirname "$0")/../../.." && pwd)"/*) echo "refusing: $DIR is inside the repo" >&2; exit 1;; esac
umask 077
mkdir -p "$DIR"; chmod 700 "$DIR"
cd "$DIR"

if [ ! -f ca.key ] || [ ! -f ca.crt ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out ca.key
  openssl req -x509 -new -key ca.key -sha256 -days 1825 -subj "/CN=bank-gw mTLS CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt
fi

leaf() { # leaf <name> <subject CN> <extKeyUsage> <subjectAltName or empty>
  local name=$1 cn=$2 eku=$3 san=$4
  if [ -f "$name.crt" ] && [ -z "${FORCE:-}" ]; then return; fi
  openssl ecparam -name prime256v1 -genkey -noout -out "$name.key"
  openssl req -new -key "$name.key" -subj "/CN=$cn" -out "$name.csr"
  { echo "basicConstraints=CA:FALSE"; echo "keyUsage=digitalSignature"; echo "extendedKeyUsage=$eku"
    [ -z "$san" ] || echo "subjectAltName=$san"; } > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 365 -extfile "$name.ext" -out "$name.crt"
  rm -f "$name.csr" "$name.ext"
}

for n in 1 2 3 4; do
  leaf "gw-$n" "bank-gw-$n" serverAuth \
    "DNS:bank-gw-$n,DNS:bank-gw-$n.paladin,DNS:bank-gw-$n.paladin.svc,DNS:bank-gw-$n.paladin.svc.cluster.local,DNS:localhost,IP:127.0.0.1"
done
leaf lensa lensa clientAuth ""
chmod 600 ./*.key ./*.crt
echo "wrote $DIR:"; ls -l "$DIR"
