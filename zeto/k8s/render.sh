#!/usr/bin/env bash
# Render the zeto S1 manifests (final-design/zeto/PLAN.md S1) to stdout, or to DIR/<ns>.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|all>     namespace, 4 NetworkPolicies, party-admin (+ lensa-publisher in bi)
#   render.sh probe <own-party> <other-party>     throwaway egress probe (never part of "all"; delete by label throwaway=zeto-s1-probe)
# Needs bash + sed only. Never talks to a cluster. Cluster 2 (bank-c) is out of scope and refused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b"

die() { echo "render.sh: $*" >&2; exit 2; }
valid() { [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"; }

party() {
  local p="$1"; valid "$p"
  sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-zeto-$p/g" "$here/templates/party.yaml"
  if [[ "$p" == bi ]]; then
    echo '---'
    sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-zeto-$p/g" "$here/templates/lensa-publisher.yaml"
  fi
}

probe() {
  local own="$1" other="$2"; valid "$own"; valid "$other"
  [[ "$own" != "$other" ]] || die "probe needs two different parties"
  local s=(-e "s/\${NS}/rd-zeto-$own/g" -e "s/\${OTHER_NS}/rd-zeto-$other/g")
  sed "${s[@]}" "$here/probe/listeners.yaml"
  echo '---'
  sed "${s[@]}" -e 's/\${POD}/probe-paladin/g' -e 's/\${APP}/paladin/g' "$here/probe/probe-pod.yaml"
  echo '---'
  sed "${s[@]}" -e 's/\${POD}/probe-control/g' -e 's/\${APP}/probe-control/g' "$here/probe/probe-pod.yaml"
}

emit_all() { local first=1 p; for p in $parties; do [[ $first == 1 ]] || echo '---'; first=0; party "$p"; done; }

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  probe) [[ $# == 3 ]] || die "usage: render.sh probe <own-party> <other-party>"; probe "$2" "$3" ;;
  all)
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in $parties; do party "$p" > "$out/rd-zeto-$p.yaml"; done
    else emit_all; fi ;;
  "") die "usage: render.sh [-o DIR] <bi|bank-a|bank-b|all> | probe <own> <other>" ;;
  *)
    if [[ -n "$out" ]]; then mkdir -p "$out"; party "$1" > "$out/rd-zeto-$1.yaml"; else party "$1"; fi ;;
esac
