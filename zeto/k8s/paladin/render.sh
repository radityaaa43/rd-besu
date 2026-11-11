#!/usr/bin/env bash
# Render the zeto S9 manifests (final-design/zeto/PLAN.md S9: Paladin node per party) to stdout, or to DIR/<ns>-paladin.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all>   operator (SA, Role, RoleBinding, ConfigMap, Deployment) + Paladin CR node<N>
# bi=node1 bank-a=node2 bank-b=node3 bank-c=node4 (the node number is the Zeto owner key name, bi@node1 ...). bank-c is cluster 2.
# Needs bash + sed only. Never talks to a cluster. CRDs are NOT rendered: README step 1 (cluster 2 has none, user approval).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b bank-c"

die() { echo "render.sh: $*" >&2; exit 2; }
num() { case "$1" in bi) echo 1 ;; bank-a) echo 2 ;; bank-b) echo 3 ;; bank-c) echo 4 ;; *) die "unknown party '$1' (allowed: $parties)" ;; esac; }
subst() { sed -e "s/\${PARTY}/$1/g" -e "s/\${NS}/rd-zeto-$1/g" -e "s/\${N}/$(num "$1")/g" "$here/templates/paladin.yaml"; }

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
[[ $# == 1 ]] || die "usage: render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all>"
sel="$1"; [[ "$sel" == all ]] && sel="$parties" || num "$sel" >/dev/null
[[ -z "$out" ]] || mkdir -p "$out"
first=1
for p in $sel; do
  if [[ -n "$out" ]]; then subst "$p" > "$out/rd-zeto-$p-paladin.yaml"
  else [[ $first == 1 ]] || echo '---'; first=0; subst "$p"; fi
done
