#!/usr/bin/env bash
# Render the zeto S9/S10 manifests (final-design/zeto/PLAN.md S9: Paladin node per party; S10: cross-cluster transport endpoint) to stdout, or to DIR/<ns>-paladin.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all> [--transport-host HOST]
#        operator (SA, Role, RoleBinding, ConfigMap, Deployment) + paused sts stub + Paladin CR node<N>. --transport-host adds
#        externalHostname = HOST (the node's own LB IP: the endpoint other nodes dial) and transports[0].tls {certName, secretName} paladin-node<N>-mtls (the CRD requires certName; no issuer).
#   render.sh transport <party> [--external-cidr CIDR]... [--acl-id acl-X [--clb-health-cidr 100.64.0.0/10]]
#        Service paladin-transport (LoadBalancer TCP 9000) + NetworkPolicy paladin-transport-ingress. --acl-id needs a CIDR (loadBalancerSourceRanges).
#   render.sh probe-listener <party>               throwaway pod carrying the node's selector labels, `nc -l 9000` only (no Paladin process)
#   render.sh probe-client <party> <name> <IPv4>   throwaway pod in the party's ns that connects to <IPv4>:9000 and prints OPEN|BLOCKED(timeout)|REFUSED (REFUSED = reached, nothing listening)
# bi=node1 bank-a=node2 bank-b=node3 bank-c=node4 (the node number is the Zeto owner key name, bi@node1 ...). bank-c is cluster 2.
# Needs bash + sed only. Never talks to a cluster. CRDs are NOT rendered (cluster 2 already has them, owned by another project).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b bank-c"

die() { echo "render.sh: $*" >&2; exit 2; }
num() { case "$1" in bi) echo 1 ;; bank-a) echo 2 ;; bank-b) echo 3 ;; bank-c) echo 4 ;; *) die "unknown party '$1' (allowed: $parties)" ;; esac; }
host_ok() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$1" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]]; }
subst() {
  local th="${2:-}"
  sed -e "s/\${PARTY}/$1/g" -e "s/\${NS}/rd-zeto-$1/g" -e "s/\${N}/$(num "$1")/g" "$here/templates/paladin.yaml" |
    if [[ -n "$th" ]]; then
      sed -e "s|^          \"address\": \"0.0.0.0\"\$|          \"address\": \"0.0.0.0\",\n          \"externalHostname\": \"$th\"|" \
          -e "s|^        - {name: transport-grpc, port: 9000, targetPort: 9000, protocol: TCP}\$|&\n      tls:\n        certName: paladin-node$(num "$1")-mtls\n        secretName: paladin-node$(num "$1")-mtls|"
    else cat; fi
}

transport() {
  local p="$1"; shift; local n; n="$(num "$p")" ns="rd-zeto-$p" cidrs=() acl="" health=""
  while [[ $# -gt 0 ]]; do case "$1" in
    --external-cidr) cidrs+=("${2:?--external-cidr needs a CIDR}"); shift 2 ;;
    --acl-id) acl="${2:?--acl-id needs an ACL id}"; shift 2 ;;
    --clb-health-cidr) health="${2:?--clb-health-cidr needs a CIDR}"; shift 2 ;;
    *) die "transport: unknown option $1" ;; esac; done
  local ann="" lbsr=""
  if [[ -n "$acl" ]]; then
    [[ "$acl" =~ ^acl-[a-z0-9]+$ ]] || die "transport: --acl-id must match acl-[a-z0-9]+"
    [[ -n "${cidrs[*]:-}" ]] || die "transport: --acl-id needs at least one --external-cidr (loadBalancerSourceRanges)"
    ann=$'  annotations:\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-status: "on"\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-type: white\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id: '"$acl"$'\n    service.beta.kubernetes.io/backend-type: eni\n'
    lbsr="  loadBalancerSourceRanges:"; local c; for c in "${cidrs[@]}"; do lbsr+=$'\n'"    - $c"; done; lbsr+=$'\n'
  fi
  cat <<YAML
# zeto S10: the node's Paladin gRPC transport endpoint (published in the registry as dns:///<this LB IP>:9000; paladin grpc_transport.go:337).
# Jakarta pods reach a Jakarta LB IP inside the cluster (kube-proxy), so only the other cluster's egress needs the ACL.
apiVersion: v1
kind: Service
metadata:
  name: paladin-transport
  namespace: ${ns}
  labels: {part-of: rd-zeto, party: ${p}}
${ann}spec:
  type: LoadBalancer
${lbsr}  externalTrafficPolicy: Cluster
  selector: {app: paladin, app.kubernetes.io/name: paladin-node${n}}
  ports:
    - {name: transport-grpc, port: 9000, targetPort: 9000, protocol: TCP}
---
# 9000 only: from the rd-zeto namespaces of this cluster (Jakarta peers arrive as pod IPs) and from the given CIDRs (the other cluster's egress).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: paladin-transport-ingress
  namespace: ${ns}
  labels: {part-of: rd-zeto, party: ${p}}
spec:
  podSelector:
    matchLabels: {app: paladin}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchExpressions:
              - {key: part-of, operator: In, values: [rd-zeto]}
YAML
  local c; for c in "${cidrs[@]:-}"; do [[ -z "$c" ]] || printf '        - ipBlock:\n            cidr: %s\n' "$c"; done
  printf '      ports:\n        - {protocol: TCP, port: 9000}\n'
  if [[ -n "$health" ]]; then printf '    - from:\n        - ipBlock:\n            cidr: %s\n      ports:\n        - {protocol: TCP, port: 9000}\n' "$health"; fi
}

probe_listener() {
  local p="$1"; local n; n="$(num "$p")"
  cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: s10-listener
  namespace: rd-zeto-${p}
  labels: {throwaway: zeto-s10-probe, app: paladin, app.kubernetes.io/name: paladin-node${n}, app.kubernetes.io/instance: node${n}, app.kubernetes.io/part-of: paladin}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534}
  containers:
    - name: listen
      image: busybox:1.36
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 5m, memory: 8Mi}, limits: {cpu: 50m, memory: 16Mi}}
      command: [sh, -c, "echo listener-up; while true; do nc -l -p 9000 </dev/null >/dev/null; done"]
      ports: [{containerPort: 9000}]
YAML
}

probe_client() {
  local p="$1" name="$2" ip="$3"
  [[ "$name" =~ ^[a-z0-9-]+$ ]] || die "probe-client: bad name"
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "probe-client: target must be an IPv4"
  cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: s10-client-${name}
  namespace: rd-zeto-${p}
  labels: {throwaway: zeto-s10-probe, app: s10-client}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 999, runAsGroup: 999}
  containers:
    - name: probe
      image: postgres:17.6
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 10m, memory: 32Mi}, limits: {cpu: 100m, memory: 64Mi}}
      command:
        - bash
        - -c
        - |
          r=BLOCKED
          for i in 1 2 3; do
            timeout 5 bash -c '</dev/tcp/${ip}/9000' 2>/dev/null; rc=\$?
            if [ \$rc = 0 ]; then r=OPEN; break; fi
            if [ \$rc != 124 ]; then r=REFUSED; fi
            sleep 2
          done
          echo "s10-client-${name} ${ip}:9000 \$r"
YAML
}

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  transport) shift; [[ $# -ge 1 ]] || die "usage: render.sh transport <party> [options]"; num "$1" >/dev/null; transport "$@"; exit 0 ;;
  probe-listener) [[ $# == 2 ]] || die "usage: render.sh probe-listener <party>"; num "$2" >/dev/null; probe_listener "$2"; exit 0 ;;
  probe-client) [[ $# == 4 ]] || die "usage: render.sh probe-client <party> <name> <IPv4>"; num "$2" >/dev/null; probe_client "$2" "$3" "$4"; exit 0 ;;
esac
[[ $# == 1 || ( $# == 3 && "$2" == --transport-host ) ]] || die "usage: render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all> [--transport-host HOST]"
sel="$1"; th="${3:-}"
if [[ -n "$th" ]]; then host_ok "$th" || die "bad --transport-host '$th'"; [[ "$sel" != all ]] || die "--transport-host is per party"; fi
[[ "$sel" == all ]] && sel="$parties" || num "$sel" >/dev/null
[[ -z "$out" ]] || mkdir -p "$out"
first=1
for p in $sel; do
  if [[ -n "$out" ]]; then subst "$p" "$th" > "$out/rd-zeto-$p-paladin.yaml"
  else [[ $first == 1 ]] || echo '---'; first=0; subst "$p" "$th"; fi
done
