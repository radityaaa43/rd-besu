#!/bin/bash
# mTLS material of ONE party's gateway with a CA that party owns (zeto S16). Unlike gen-certs.sh (one CA for all gateways, shared Lensa cert),
# a Lensa client cert made here is signed by THIS party's CA only, so another party's gateway refuses it.
#   OPA_MTLS_DIR=<absolute dir outside the repo, must NOT exist> gen-party-certs.sh <bi|bank-a|bank-b|bank-c> [--lensa-client-from <lensa.csr>]
# Writes (dir 700, files 600), prints no key:
#   ca.crt / ca.key          CA of this party (5 years), CN "bank-gw mTLS CA <party>"
#   gw-N.crt / gw-N.key      server cert of bank-gw-N (1 year); SAN: bank-gw-N[-ext][.rd-zeto-<party>[.svc[.cluster.local]]], localhost, 127.0.0.1
#   lensa.crt / lensa.key    Lensa client cert for this gateway (1 year), clientAuth only
# --lensa-client-from: Lensa keeps its own key. The CSR (made by Lensa) is signed with this CA, lensa.crt is written, no lensa.key.
# Secret of the gateway: kubectl -n rd-zeto-<party> create secret generic bank-gw-N-mtls --from-file=ca.crt --from-file=tls.crt=gw-N.crt --from-file=tls.key=gw-N.key
# ca.key stays with the party; Lensa gets ca.crt + lensa.crt (+ lensa.key) for THIS party only.
# N: bi=1 bank-a=2 bank-b=3 bank-c=4. Reuses the openssl calls of gen-certs.sh.
set -euo pipefail
die() { echo "gen-party-certs.sh: $*" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
party="${1:-}"; [ $# -eq 0 ] || shift
csr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lensa-client-from) csr="${2:-}"; [ -n "$csr" ] || die "--lensa-client-from needs a file"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
case "$party" in bi) n=1 ;; bank-a) n=2 ;; bank-b) n=3 ;; bank-c) n=4 ;; *) die "usage: OPA_MTLS_DIR=<dir> $0 <bi|bank-a|bank-b|bank-c> [--lensa-client-from <lensa.csr>]" ;; esac
[ -n "${OPA_MTLS_DIR:-}" ] || die "OPA_MTLS_DIR is not set (no default: the directory must be new and outside the repo)"
case "$OPA_MTLS_DIR" in /*) ;; *) die "OPA_MTLS_DIR must be an absolute path" ;; esac
DIR="$(realpath -m "$OPA_MTLS_DIR")"
roots="$(cd "$here/../.." && pwd -P)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -z "$common" ] || roots="$roots $(dirname "$common")"
for r in $roots; do case "$DIR/" in "$r"/*) die "refusing: $DIR is inside the repo $r" ;; esac; done
[ ! -e "$DIR" ] || die "refusing: $DIR already exists (a CA is never reused or overwritten here)"
if [ -n "$csr" ]; then
  [ -f "$csr" ] || die "--lensa-client-from: $csr is not a file"
  openssl req -in "$csr" -verify -noout 2>/dev/null || die "--lensa-client-from: $csr is not a valid CSR"
  csr="$(realpath "$csr")"
fi

umask 077
mkdir -p "$DIR"; chmod 700 "$DIR"
cd "$DIR"
ns="rd-zeto-$party"

openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 1825 -subj "/CN=bank-gw mTLS CA $party" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt

sign() { # sign <csr> <crt> <extKeyUsage> <subjectAltName or empty>
  { echo "basicConstraints=CA:FALSE"; echo "keyUsage=digitalSignature"; echo "extendedKeyUsage=$3"
    [ -z "$4" ] || echo "subjectAltName=$4"; } > "$2.ext"
  openssl x509 -req -in "$1" -CA ca.crt -CAkey ca.key -set_serial "0x$(openssl rand -hex 16)" -sha256 -days 365 -extfile "$2.ext" -out "$2"
  rm -f "$2.ext"
}
leaf() { # leaf <name> <subject CN> <extKeyUsage> <subjectAltName or empty>
  openssl ecparam -name prime256v1 -genkey -noout -out "$1.key"
  openssl req -new -key "$1.key" -subj "/CN=$2" -out "$1.csr"
  sign "$1.csr" "$1.crt" "$3" "$4"
  rm -f "$1.csr"
}

san="DNS:bank-gw-$n,DNS:bank-gw-$n.$ns,DNS:bank-gw-$n.$ns.svc,DNS:bank-gw-$n.$ns.svc.cluster.local"
san="$san,DNS:bank-gw-$n-ext,DNS:bank-gw-$n-ext.$ns,DNS:bank-gw-$n-ext.$ns.svc,DNS:bank-gw-$n-ext.$ns.svc.cluster.local,DNS:localhost,IP:127.0.0.1"
leaf "gw-$n" "bank-gw-$n" serverAuth "$san"
if [ -n "$csr" ]; then sign "$csr" lensa.crt clientAuth ""; else leaf lensa "lensa-$party" clientAuth ""; fi
chmod 600 ./*.key ./*.crt
echo "wrote $DIR (party $party, gateway bank-gw-$n):"; ls -l "$DIR" | sed '1d'
