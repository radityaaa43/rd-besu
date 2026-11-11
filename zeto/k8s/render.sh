#!/usr/bin/env bash
# Render the zeto S1 manifests (final-design/zeto/PLAN.md S1) to stdout, or to DIR/<ns>.yaml with -o.
#   render.sh [-o DIR] [-p zeto|stealth] <bi|bank-a|bank-b|all>
#                                                 zeto (default): namespace, 4 NetworkPolicies, party-admin (+ lensa-publisher in bi)
#                                                 stealth: namespace rd-stealth-<party>, 3 NetworkPolicies, party-admin (no Paladin node, no probe)
#   render.sh probe <own> <other>                 throwaway egress probe, everything (dry-run, delete); apply it as the two parts below
#   render.sh probe-listeners <own> <other>       part 1: policy + listeners (apply first, wait for Ready)
#   render.sh probe-pods <own> <other>            part 2: probe-paladin (app=paladin) + probe-control (apply after the listeners are Ready)
#   (probe objects are never part of "all"; delete by label throwaway=zeto-s1-probe)
# Needs bash + sed only. Never talks to a cluster. Cluster 2 (bank-c) is out of scope and refused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b"

die() { echo "render.sh: $*" >&2; exit 2; }
valid() { [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"; }

platform=zeto

party() {
  local p="$1"; valid "$p"
  if [[ "$platform" == stealth ]]; then
    sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-stealth-$p/g" "$here/templates/stealth-party.yaml"
    return
  fi
  sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-zeto-$p/g" "$here/templates/party.yaml"
  if [[ "$p" == bi ]]; then
    echo '---'
    sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-zeto-$p/g" "$here/templates/lensa-publisher.yaml"
  fi
}

probe_args() {
  [[ $# == 2 ]] || die "usage: render.sh probe|probe-listeners|probe-pods <own-party> <other-party>"
  valid "$1"; valid "$2"
  [[ "$1" != "$2" ]] || die "probe needs two different parties"
  S=(-e "s/\${NS}/rd-zeto-$1/g" -e "s/\${OTHER_NS}/rd-zeto-$2/g")
}
probe_listeners() { sed "${S[@]}" "$here/probe/listeners.yaml"; }
probe_pods() {
  sed "${S[@]}" -e 's/\${POD}/probe-paladin/g' -e 's/\${APP}/paladin/g' "$here/probe/probe-pod.yaml"
  echo '---'
  sed "${S[@]}" -e 's/\${POD}/probe-control/g' -e 's/\${APP}/probe-control/g' "$here/probe/probe-pod.yaml"
}

emit_all() { local first=1 p; for p in $parties; do [[ $first == 1 ]] || echo '---'; first=0; party "$p"; done; }

out=""
while [[ "${1:-}" == -o || "${1:-}" == -p ]]; do
  case "$1" in
    -o) out="${2:?-o needs a directory}" ;;
    -p) platform="${2:?-p needs zeto or stealth}"; [[ "$platform" == zeto || "$platform" == stealth ]] || die "unknown platform '$platform' (allowed: zeto stealth)" ;;
  esac
  shift 2
done
case "${1:-}" in
  probe*) [[ "$platform" == zeto ]] || die "the egress probe is zeto-only (stealth has no Paladin node)" ;;
esac
case "${1:-}" in
  probe)           shift; probe_args "$@"; probe_listeners; echo '---'; probe_pods ;;
  probe-listeners) shift; probe_args "$@"; probe_listeners ;;
  probe-pods)      shift; probe_args "$@"; probe_pods ;;
  all)
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in $parties; do party "$p" > "$out/rd-$platform-$p.yaml"; done
    else emit_all; fi ;;
  "") die "usage: render.sh [-o DIR] [-p zeto|stealth] <bi|bank-a|bank-b|all> | probe <own> <other>" ;;
  *)
    if [[ -n "$out" ]]; then mkdir -p "$out"; party "$1" > "$out/rd-$platform-$1.yaml"; else party "$1"; fi ;;
esac
