#!/usr/bin/env bash
# Render the stealth L0 manifests (final-design/stealth/PLAN.md S1) to stdout, or to DIR/rd-stealth-<party>.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|all>     namespace rd-stealth-<party>, 3 NetworkPolicies, party-admin (SA, Role, RoleBinding)
# Needs bash + sed only. Never talks to a cluster. Cluster 2 (bank-c) is out of scope and refused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b"

die() { echo "render.sh: $*" >&2; exit 2; }
valid() { [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"; }

party() {
  local p="$1"; valid "$p"
  sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-stealth-$p/g" "$here/templates/party.yaml"
}

emit_all() { local first=1 p; for p in $parties; do [[ $first == 1 ]] || echo '---'; first=0; party "$p"; done; }

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  all)
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in $parties; do party "$p" > "$out/rd-stealth-$p.yaml"; done
    else emit_all; fi ;;
  "") die "usage: render.sh [-o DIR] <bi|bank-a|bank-b|all>" ;;
  *)
    if [[ -n "$out" ]]; then mkdir -p "$out"; party "$1" > "$out/rd-stealth-$1.yaml"; else party "$1"; fi ;;
esac
