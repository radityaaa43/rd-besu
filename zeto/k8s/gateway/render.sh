#!/usr/bin/env bash
# Render the zeto S16 manifests (final-design/zeto/PLAN.md S16: gateway per party, own mTLS CA) to stdout, or to DIR/rd-zeto-<party>-gateway.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all> [--lensa-cidr CIDR]... [--opa-config FILE] [--bundle-path latest]
# Per party, in namespace rd-zeto-<party> (never `paladin`): ConfigMaps bank-gw-<N>-envoy (opa/envoy/node<N>.yaml with the mTLS block of
# opa/mtls/envoy-mtls.sh, upstreams paladin-node<N>.<ns>:8548, besu-rpc.<ns>:8545 and, for target `sink`, bundle-server.<ns>:8081) and bank-gw-opa-v2 (opa/opa.yaml); Deployment + Service
# bank-gw-<N> copied from opa/k8s/bank-gw-<N>.yaml (only the namespace changes); Service bank-gw-<N>-ext (NodePort; LoadBalancer for bank-c on
# cluster 2, no cloud annotations: those are added later by flags, like zeto/k8s/besu/render.sh net --acl-id); NetworkPolicies.
#   --lensa-cidr   limit the gateway ports to this source (repeatable); default: any source on 8548/8545, mTLS is the gate (README, assumptions)
#   --bundle-path latest   OPA pulls <name>/latest.tar.gz (bi/latest.tar.gz, bank/latest.tar.gz) from the per-party bundle-server (S17, zeto/k8s/bundle-server) instead of
#                  the old <N>/bi.tar.gz, <N>/bank.tar.gz of namespace `paladin` (default, unchanged); only the two --set=bundles.<name>.resource args of the Deployment change
#   --opa-config   ConfigMap bank-gw-opa-v2 content from FILE instead of opa/opa.yaml (the party's opa-config.yaml = opa.yaml + public keys, from opa/keys.sh)
# NOT rendered: Secrets bank-gw-<N>-mtls (opa/mtls/gen-party-certs.sh) and bundle-sink-token (created by the party), the namespace (S1), Ingress.
# bi=1 bank-a=2 bank-b=3 bank-c=4 (names bank-gw-<N>, node<N>). Needs bash, sed, awk. Never talks to a cluster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
parties="bi bank-a bank-b bank-c"

die() { echo "render.sh: $*" >&2; exit 2; }
num() { case "$1" in bi) echo 1 ;; bank-a) echo 2 ;; bank-b) echo 3 ;; bank-c) echo 4 ;; *) die "unknown party '$1' (allowed: $parties)" ;; esac; }
indent() { sed 's/^/    /'; }

gateway() { # gateway <party> <opa-config file> <cidr>...
  local p="$1" cfg="$2"; shift 2
  local n ns env dep ext
  n="$(num "$p")"; ns="rd-zeto-$p"
  env="$(sed -e "s/paladin-node$n\.paladin\.svc\.cluster\.local/paladin-node$n.$ns.svc.cluster.local/" \
             -e "s/besu-node-validator-$n\.besu\.svc\.cluster\.local/besu-rpc.$ns.svc.cluster.local/" \
             -e "s/besu-node-validator-$n:8545/besu-rpc:8545/" \
             -e "s/bundle-server\.paladin\.svc\.cluster\.local/bundle-server.$ns.svc.cluster.local/" "$repo/opa/envoy/node$n.yaml")"
  grep -q "paladin-node$n.$ns.svc.cluster.local" <<<"$env" && grep -q "besu-rpc.$ns.svc.cluster.local" <<<"$env" && grep -q "bundle-server.$ns.svc.cluster.local" <<<"$env" || die "opa/envoy/node$n.yaml: upstream hostnames not found, template changed?"
  env="$("$repo/opa/mtls/envoy-mtls.sh" <(printf '%s\n' "$env"))"
  [[ "$(grep -c '^  namespace: paladin$' "$repo/opa/k8s/bank-gw-$n.yaml")" == 2 ]] || die "opa/k8s/bank-gw-$n.yaml: expected 2 'namespace: paladin' lines"
  dep="$(sed "s/^  namespace: paladin\$/  namespace: $ns/" "$repo/opa/k8s/bank-gw-$n.yaml")"
  if [[ -n "$BPATH" ]]; then
    grep -q -- "--set=bundles.bi.resource=$n/bi.tar.gz" <<<"$dep" && grep -q -- "--set=bundles.bank.resource=$n/bank.tar.gz" <<<"$dep" || die "opa/k8s/bank-gw-$n.yaml: bundles.<name>.resource args not found, template changed?"
    dep="$(sed -e "s#--set=bundles.bi.resource=$n/bi.tar.gz#--set=bundles.bi.resource=bi/latest.tar.gz#" -e "s#--set=bundles.bank.resource=$n/bank.tar.gz#--set=bundles.bank.resource=bank/latest.tar.gz#" <<<"$dep")"
  fi
  ext=NodePort; local ann="" lbsr="" etp=""
  if [[ -n "$ACL" ]]; then
    ext=LoadBalancer; etp=$'  externalTrafficPolicy: Cluster\n'
    ann=$'  annotations:\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-status: "on"\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-type: white\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id: '"$ACL"$'\n    service.beta.kubernetes.io/backend-type: eni\n'
    lbsr="  loadBalancerSourceRanges:"; local c; for c in "${EXTCIDRS[@]}"; do lbsr+=$'\n'"    - $c"; done; lbsr+=$'\n'
  fi
  cat <<YAML
# zeto S16: gateway bank-gw-$n of party $p in $ns. Secret bank-gw-$n-mtls (ca.crt, tls.crt, tls.key) and bundle-sink-token are created by the party, not rendered.
apiVersion: v1
kind: ConfigMap
metadata:
  name: bank-gw-$n-envoy
  namespace: $ns
data:
  envoy.yaml: |
$(indent <<<"$env")
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: bank-gw-opa-v2
  namespace: $ns
data:
  opa.yaml: |
$(indent < "$cfg")
---
$dep
---
# Lensa path: $ext on 8548 (Paladin) and 8545 (Besu), behind the gateway's mTLS. NodePort = host Lensa only (removed when the host Lensa is retired); LoadBalancer only behind --acl-id + --external-cidr (bank-c).
apiVersion: v1
kind: Service
metadata:
  name: bank-gw-$n-ext
  namespace: $ns
  labels: {app: bank-gw, node: node$n}
${ann}spec:
  type: $ext
${lbsr}${etp}  selector: {app: bank-gw, node: node$n}
  ports:
  - {name: paladin, port: 8548, targetPort: 8548}
  - {name: besu, port: 8545, targetPort: 8545}
---
# Paladin: RPC 8548 only from the gateway pods; the operator keeps 8548/8549 (as in opa/k8s/networkpolicy.yaml); metrics 6100 from the namespace.
# Transport 9000 stays with paladin-transport-ingress (S10).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: paladin-ingress
  namespace: $ns
  labels: {part-of: rd-zeto, party: $p}
spec:
  podSelector:
    matchLabels: {app: paladin}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {matchLabels: {app: bank-gw}}
        - podSelector: {matchLabels: {app.kubernetes.io/name: paladin-operator}}
      ports: [{protocol: TCP, port: 8548}]
    - from:
        - podSelector: {matchLabels: {app.kubernetes.io/name: paladin-operator}}
      ports: [{protocol: TCP, port: 8549}]
    - from:
        - podSelector: {}
      ports: [{protocol: TCP, port: 6100}]
---
# Gateway: only the two doors. Source: the Lensa path (NodePort/LB traffic arrives from node or LB addresses), any source unless --lensa-cidr is given.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bank-gw-ingress
  namespace: $ns
  labels: {part-of: rd-zeto, party: $p}
spec:
  podSelector:
    matchLabels: {app: bank-gw}
  policyTypes: [Ingress]
  ingress:
YAML
  if [[ $# -gt 0 ]]; then
    echo "    - from:"; local c; for c in "$@"; do printf '        - ipBlock: {cidr: %s}\n' "$c"; done
    echo "      ports: [{protocol: TCP, port: 8548}, {protocol: TCP, port: 8545}]"
  else
    echo "    - ports: [{protocol: TCP, port: 8548}, {protocol: TCP, port: 8545}]"
  fi
}

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
[[ $# -ge 1 ]] || die "usage: render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all> [--lensa-cidr CIDR]... [--opa-config FILE] [--bundle-path latest]"
sel="$1"; shift
BPATH=""; cidrs=(); cfg="$repo/opa/opa.yaml"; ACL=""; EXTCIDRS=()
while [[ $# -gt 0 ]]; do case "$1" in
  --lensa-cidr) c="${2:?--lensa-cidr needs a CIDR}"; [[ "$c" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "bad --lensa-cidr '$c'"; cidrs+=("$c"); shift 2 ;;
  --acl-id) ACL="${2:?--acl-id needs an ACL id}"; [[ "$ACL" =~ ^acl-[a-z0-9]+$ ]] || die "bad --acl-id"; shift 2 ;;
  --external-cidr) c="${2:?--external-cidr needs a CIDR}"; [[ "$c" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "bad --external-cidr '$c'"; EXTCIDRS+=("$c"); shift 2 ;;
  --bundle-path) BPATH="${2:?--bundle-path needs a value}"; [[ "$BPATH" == latest ]] || die "--bundle-path: only 'latest' is supported"; shift 2 ;;
  --opa-config) cfg="${2:?--opa-config needs a file}"; [[ -f "$cfg" ]] || die "--opa-config: $cfg is not a file"; shift 2 ;;
  *) die "unknown option $1" ;; esac; done
[[ "$sel" == all ]] && sel="$parties" || num "$sel" >/dev/null
if [[ -n "$ACL" || ${#EXTCIDRS[@]} -gt 0 ]]; then
  [[ "$sel" == bank-c ]] || die "--acl-id/--external-cidr (LoadBalancer) are for bank-c only"
  [[ -n "$ACL" && ${#EXTCIDRS[@]} -gt 0 ]] || die "--acl-id and --external-cidr only together"
fi
[[ -z "$out" ]] || mkdir -p "$out"
first=1
for p in $sel; do
  if [[ -n "$out" ]]; then gateway "$p" "$cfg" "${cidrs[@]}" > "$out/rd-zeto-$p-gateway.yaml"
  else [[ $first == 1 ]] || echo '---'; first=0; gateway "$p" "$cfg" "${cidrs[@]}"; fi
done
