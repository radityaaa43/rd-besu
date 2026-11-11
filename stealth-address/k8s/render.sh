#!/usr/bin/env bash
# Render the stealth L0 manifests (final-design/stealth/PLAN.md S1, S2) to stdout, or to DIR/rd-stealth-<party>.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|all>      cluster 1: namespace rd-stealth-<party>, 3 NetworkPolicies, party-admin (SA, Role, RoleBinding)
#   render.sh --cluster 2 [--ns-only] bank-c       cluster 2 (S2): bank-c only, label cluster="2"; --ns-only = the Namespace doc alone (GO 1),
#                                                  without it the same objects as cluster 1 (GO 2)
# Needs bash + sed + awk only. Never talks to a cluster. bank-c is refused without --cluster 2; with it, anything but bank-c is refused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b"
cluster=1
ns_only=0
out=""

die() { echo "render.sh: $*" >&2; exit 2; }
valid() {
  if [[ "$1" == bank-c && $cluster == 1 ]]; then die "bank-c is on cluster 2: use --cluster 2"; fi
  [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"
}

# cluster 2 objects carry cluster="2" (flow-style labels and the block-style Namespace labels)
c2() {
  if [[ $cluster == 2 ]]; then
    sed -e 's/party: bank-c}/party: bank-c, cluster: "2"}/' -e '/^    party: bank-c$/a\    cluster: "2"'
  else cat; fi
}
first_doc() { if [[ $ns_only == 1 ]]; then awk '/^---$/{exit} {print}'; else cat; fi; }

party() {
  local p="$1"; valid "$p"
  sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-stealth-$p/g" "$here/templates/party.yaml" | c2 | first_doc
}

emit_all() { local first=1 p; for p in $parties; do [[ $first == 1 ]] || echo '---'; first=0; party "$p"; done; }

while [[ "${1:-}" == -o || "${1:-}" == --cluster || "${1:-}" == --ns-only ]]; do
  case "$1" in
    -o) out="${2:?-o needs a directory}"; shift 2 ;;
    --cluster) [[ "${2:-}" == 2 ]] || die "--cluster supports only 2"; cluster=2; parties="bank-c"; shift 2 ;;
    --ns-only) ns_only=1; shift ;;
  esac
done
[[ $ns_only == 0 || $cluster == 2 ]] || die "--ns-only needs --cluster 2"

case "${1:-}" in
  all)
    [[ $cluster == 1 ]] || die "--cluster 2 renders bank-c only"
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in $parties; do party "$p" > "$out/rd-stealth-$p.yaml"; done
    else emit_all; fi ;;
  "") die "usage: render.sh [-o DIR] [--cluster 2 [--ns-only]] <bi|bank-a|bank-b|all|bank-c>" ;;
  *)
    if [[ -n "$out" ]]; then mkdir -p "$out"; party "$1" > "$out/rd-stealth-$1.yaml"; else party "$1"; fi ;;
esac
