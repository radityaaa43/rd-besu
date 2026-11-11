#!/usr/bin/env bash
# Render the zeto S1 manifests (final-design/zeto/PLAN.md S1, S2) to stdout, or to DIR/rd-zeto-<party>.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|all>      cluster 1: namespace, 4 NetworkPolicies, party-admin (+ lensa-publisher in bi)
#   render.sh probe <own> <other>                  throwaway egress probe, everything (dry-run, delete); apply it as the two parts below
#   render.sh probe-listeners <own> <other>        part 1: policy + listeners (apply first, wait for Ready)
#   render.sh probe-pods <own> <other>             part 2: probe-paladin (app=paladin) + probe-control (apply after the listeners are Ready)
#   render.sh --cluster 2 [--ns-only] bank-c       cluster 2 (S2): bank-c only, label cluster="2"; --ns-only = the Namespace doc alone (GO 1),
#                                                  without it the same objects as cluster 1 minus lensa-publisher (GO 2)
#   render.sh --cluster 2 probe|probe-listeners|probe-pods bank-c    probe inside rd-zeto-bank-c only (listeners + control in the same namespace)
# Probe objects are never part of "all"; delete by label throwaway=zeto-s1-probe.
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
  {
    sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-zeto-$p/g" "$here/templates/party.yaml"
    if [[ "$p" == bi ]]; then
      echo '---'
      sed -e "s/\${PARTY}/$p/g" -e "s/\${NS}/rd-zeto-$p/g" "$here/templates/lensa-publisher.yaml"
    fi
  } | c2 | first_doc
}

probe_args() {
  local own other
  if [[ $cluster == 2 ]]; then
    [[ $# == 1 ]] || die "usage: render.sh --cluster 2 probe|probe-listeners|probe-pods bank-c"
    valid "$1"; own="$1"; other="$1"
  else
    [[ $# == 2 ]] || die "usage: render.sh probe|probe-listeners|probe-pods <own-party> <other-party>"
    valid "$1"; valid "$2"
    [[ "$1" != "$2" ]] || die "probe needs two different parties"
    own="$1"; other="$2"
  fi
  S=(-e "s/\${NS}/rd-zeto-$own/g" -e "s/\${OTHER_NS}/rd-zeto-$other/g")
}
probe_listeners() {
  if [[ $cluster == 2 ]]; then sed "${S[@]}" "$here/probe/listeners-samens.yaml"
  else sed "${S[@]}" "$here/probe/listeners.yaml"; fi
}
probe_pods() {
  sed "${S[@]}" -e 's/\${POD}/probe-paladin/g' -e 's/\${APP}/paladin/g' "$here/probe/probe-pod.yaml"
  echo '---'
  sed "${S[@]}" -e 's/\${POD}/probe-control/g' -e 's/\${APP}/probe-control/g' "$here/probe/probe-pod.yaml"
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
  probe*) [[ $ns_only == 0 ]] || die "--ns-only does not apply to the probe" ;;
esac

case "${1:-}" in
  probe)           shift; probe_args "$@"; probe_listeners; echo '---'; probe_pods ;;
  probe-listeners) shift; probe_args "$@"; probe_listeners ;;
  probe-pods)      shift; probe_args "$@"; probe_pods ;;
  all)
    [[ $cluster == 1 ]] || die "--cluster 2 renders bank-c only"
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in $parties; do party "$p" > "$out/rd-zeto-$p.yaml"; done
    else emit_all; fi ;;
  "") die "usage: render.sh [-o DIR] [--cluster 2 [--ns-only]] <bi|bank-a|bank-b|all|bank-c> | probe <own> <other>" ;;
  *)
    if [[ -n "$out" ]]; then mkdir -p "$out"; party "$1" > "$out/rd-zeto-$1.yaml"; else party "$1"; fi ;;
esac
