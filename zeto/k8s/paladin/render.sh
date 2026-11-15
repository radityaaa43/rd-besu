#!/usr/bin/env bash
# Render the zeto S9/S10 manifests (final-design/zeto/PLAN.md S9: Paladin node per party; S10: cross-cluster transport endpoint) to stdout, or to DIR/<ns>-paladin.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all> [--transport-host HOST]
#        operator (SA, Role, RoleBinding, ConfigMap, Deployment) + paused sts stub + Paladin CR node<N>. --transport-host adds
#        externalHostname = HOST (the node's own LB IP: the endpoint other nodes dial) and transports[0].tls {certName, secretName} paladin-node<N>-mtls (the CRD requires certName; no issuer).
#   render.sh transport <party> [--external-cidr CIDR]... [--acl-id acl-X [--clb-health-cidr 100.64.0.0/10]]
#        Service paladin-transport (LoadBalancer TCP 9000) + NetworkPolicy paladin-transport-ingress. --acl-id needs a CIDR (loadBalancerSourceRanges).
#   render.sh probe-placement <party>              throwaway pod with the LimitRange defaultRequest (1 CPU / 3Gi): proves a Paladin pod can be scheduled in that ns
#   render.sh probe-listener <party>               throwaway pod carrying the node's selector labels, `nc -l 9000` only (no Paladin process)
#   render.sh probe-client <party> <name> <IPv4>   throwaway pod in the party's ns that connects to <IPv4>:9000 and prints OPEN|BLOCKED(timeout)|REFUSED (REFUSED = reached, nothing listening)
#   render.sh egress <party> --lb-ips bi=IP,bank-a=IP,bank-b=IP,bank-c=IP   R17: ONE NetworkPolicy paladin-egress (own ns, selects app=paladin ONLY, Egress): TCP 9000 to the OTHER 3 parties' Paladin transport (same-cluster peers: namespaceSelector + that peer's node pods; the other cluster's peer: its LB IP /32), besu-validator 8545+8546 in the own ns,
#                                                  paladin-pg 5432 in the own ns, kube-dns 53 UDP/TCP. NOTHING else. Apply per node, ONE at a time, with the proof (docs/R17 in the S21 text).
#   render.sh sts-placement <party> [--avoid-node NODE | --undo]   R22 (--undo = the inverse merge patch, affinity null; party-admin has no apps/controllerrevisions, so no `rollout undo`): ONE JSON merge patch line for the StatefulSet paladin-node<N> template (required anti-affinity on app=paladin, optional nodeAffinity NotIn NODE):
#                                                  render.sh sts-placement <p> | kubectl -n rd-zeto-<p> patch statefulset paladin-node<N> --type merge --patch-file /dev/stdin
#   render.sh pull-secret <party>                  ONE JSON patch line: add `ghcr-pull` to the party ns's default ServiceAccount imagePullSecrets, appended (`/imagePullSecrets/-`), so the two ACK acr-credential-* entries stay:
#                                                  render.sh pull-secret <p> | kubectl -n rd-zeto-<p> patch serviceaccount default --type json --patch-file /dev/stdin
#   render.sh pull-test <party> --image REF        throwaway Deployment pull-test-paladin (1 replica, container pull-test, REF digest-pinned, NO imagePullSecrets, NO serviceAccountName) = proof of the pull before the window.
#                                                  Apply it, wait for the container status to show an imageID (waiting reason ImagePullBackOff/ErrImagePull = FAIL), then `scale deploy/pull-test-paladin --replicas=0`;
#                                                  the container may crash afterwards (no config), only the pull matters.
#   Why: the Paladin node pods (StatefulSet paladin-node<N>, created by the operator) pull the PRIVATE ghcr fork image and ended in ImagePullBackOff because their imagePullSecrets held only the two ACK
#   acr-credential-* Secrets. The Paladin CRD spec has no imagePullSecrets field and the operator has no handling for it, so the pod runs as SA `default` of rd-zeto-<party> and uses that SA's
#   imagePullSecrets. The Secret ghcr-pull (kubernetes.io/dockerconfigjson) already exists in each party ns; the fix is the SA patch above, never the CR (the render of the CR has no imagePullSecrets).
# bi=node1 bank-a=node2 bank-b=node3 bank-c=node4 (the node number is the Zeto owner key name, bi@node1 ...). bank-c is cluster 2.
# Needs bash + sed only. Never talks to a cluster. CRDs are NOT rendered (cluster 2 already has them, owned by another project).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b bank-c"

# R22: the ONE definition of the anti-affinity: the operator config (create path, paladin_controller.go:463) and the sts-placement patch (update path) both use it. app=paladin is set by the operator on every reconcile.
ANTI='{"requiredDuringSchedulingIgnoredDuringExecution":[{"labelSelector":{"matchLabels":{"app":"paladin"}},"namespaceSelector":{"matchLabels":{"part-of":"rd-zeto"}},"topologyKey":"kubernetes.io/hostname"}]}'

die() { echo "render.sh: $*" >&2; exit 2; }
num() { case "$1" in bi) echo 1 ;; bank-a) echo 2 ;; bank-b) echo 3 ;; bank-c) echo 4 ;; *) die "unknown party '$1' (allowed: $parties)" ;; esac; }
cluster_of() { case "$1" in bank-c) echo 2 ;; *) echo 1 ;; esac; }
host_ok() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$1" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]]; }
subst() {
  local th="${2:-}"
  sed -e "s/\${PARTY}/$1/g" -e "s/\${NS}/rd-zeto-$1/g" -e "s/\${N}/$(num "$1")/g" -e "s|__ANTI__|$ANTI|" "$here/templates/paladin.yaml" |
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

probe_placement() {
  cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: s9-placement
  namespace: rd-zeto-${1}
  labels: {throwaway: zeto-s9-placement, app: s9-placement}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534}
  containers:
    - name: hold
      image: busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: "1", memory: 3Gi}, limits: {cpu: "1", memory: 3Gi}}
      command: [sh, -c, "sleep 300"]
YAML
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
      image: busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
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
      image: postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929
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

pull_secret() { printf '%s\n' '[{"op":"add","path":"/imagePullSecrets/-","value":{"name":"ghcr-pull"}}]'; }

# R22: ONE merge patch for the StatefulSet paladin-node<N> pod template (operator v1.0.0 syncs only containers/volumes/annotations/labels into an existing sts, paladin_controller.go:295-300):
# the required anti-affinity on app=paladin (NO label: the operator overwrites template labels, :300); --avoid-node adds nodeAffinity NotIn <node> (the first mover, while no other pod carries the label yet).
sts_placement() {
  local node="${1:-}" na=""
  if [[ -n "$node" ]]; then [[ "$node" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || die "sts-placement: --avoid-node must be a node name"; na=",\"nodeAffinity\":{\"requiredDuringSchedulingIgnoredDuringExecution\":{\"nodeSelectorTerms\":[{\"matchExpressions\":[{\"key\":\"kubernetes.io/hostname\",\"operator\":\"NotIn\",\"values\":[\"$node\"]}]}]}}"; fi
  printf '%s\n' "{\"spec\":{\"template\":{\"spec\":{\"affinity\":{\"podAntiAffinity\":$ANTI$na}}}}}"
}

pull_test() {
  local p="$1" img="$2"
  [[ "$img" =~ ^[A-Za-z0-9._/:@-]+$ && "$img" =~ @sha256:[0-9a-f]{64}$ ]] || die "pull-test: --image must be digest-pinned (REF@sha256:<64 lowercase hex>, chars A-Za-z0-9._/:@-)"
  cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pull-test-paladin
  namespace: rd-zeto-${p}
  labels: {app: pull-test-paladin, throwaway: zeto-s21-pull-test, part-of: rd-zeto, party: ${p}}
spec:
  replicas: 1
  selector:
    matchLabels: {app: pull-test-paladin}
  template:
    metadata:
      labels: {app: pull-test-paladin, throwaway: zeto-s21-pull-test, part-of: rd-zeto, party: ${p}}
    spec:
      automountServiceAccountToken: false
      containers:
        - name: pull-test
          image: ${img}
          securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
          resources: {requests: {cpu: 10m, memory: 64Mi}, limits: {memory: 512Mi}}
YAML
}

egress() {
  local p="$1" lb="$2" me k v ips="" ns="rd-zeto-$1"
  num "$p" >/dev/null
  declare -A ip=()
  IFS=, read -ra pairs <<<"$lb"
  for kv in "${pairs[@]}"; do
    k="${kv%%=*}"; v="${kv#*=}"
    [[ " $parties " == *" $k "* && "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "egress: bad --lb-ips entry '$kv' (party=IPv4, parties: $parties)"
    [[ -z "${ip[$k]:-}" ]] || die "egress: duplicate party '$k'"
    local o; for o in ${v//./ }; do (( o <= 255 )) || die "egress: bad IPv4 '$v'"; done
    ip[$k]="$v"
  done
  for k in $parties; do [[ -n "${ip[$k]:-}" ]] || die "egress: --lb-ips must name all 4 parties (missing $k)"; done
  [[ ${#ip[@]} == 4 ]] || die "egress: --lb-ips must name exactly the 4 parties"
  # Probe proof 2026-11-12 (bank-a -> bank-b, rd-zeto-bank-a): ipBlock <same-cluster LB>/32 = BLOCKED (the CNI matches after DNAT), namespaceSelector+podSelector = OPEN.
  # So same-cluster peers (bi, bank-a, bank-b = cluster 1) go by namespace + that peer's node pods; ipBlock /32 ONLY for the other cluster's LB IP (bank-c = cluster 2).
  for k in $parties; do
    [[ "$k" == "$p" ]] && continue
    if [[ "$(cluster_of "$k")" == "$(cluster_of "$p")" ]]; then
      ips+="        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: rd-zeto-$k}
          podSelector:
            matchLabels: {app: paladin, app.kubernetes.io/name: paladin-node$(num "$k")}"$'\n'
    else ips+="        - ipBlock: {cidr: ${ip[$k]}/32}"$'\n'; fi
  done
  cat <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: paladin-egress
  namespace: $ns
  labels: {part-of: rd-zeto, party: $p}
spec:
  podSelector:
    matchLabels: {app: paladin}
  policyTypes: [Egress]
  egress:
    - to:
${ips}      ports:
        - {protocol: TCP, port: 9000}
    - to:
        - podSelector:
            matchLabels: {app.kubernetes.io/name: besu-validator}
      ports:
        - {protocol: TCP, port: 8545}
        - {protocol: TCP, port: 8546}
    - to:
        - podSelector:
            matchLabels: {app: paladin-pg}
      ports:
        - {protocol: TCP, port: 5432}
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
YAML
}

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  transport) shift; [[ $# -ge 1 ]] || die "usage: render.sh transport <party> [options]"; num "$1" >/dev/null; transport "$@"; exit 0 ;;
  probe-placement) [[ $# == 2 ]] || die "usage: render.sh probe-placement <party>"; num "$2" >/dev/null; probe_placement "$2"; exit 0 ;;
  probe-listener) [[ $# == 2 ]] || die "usage: render.sh probe-listener <party>"; num "$2" >/dev/null; probe_listener "$2"; exit 0 ;;
  egress) [[ $# == 4 && "$3" == --lb-ips ]] || die "usage: render.sh egress <party> --lb-ips bi=IP,bank-a=IP,bank-b=IP,bank-c=IP"; egress "$2" "$4"; exit 0 ;;
  sts-placement) [[ $# == 2 || ( $# == 3 && "$3" == --undo ) || ( $# == 4 && "$3" == --avoid-node ) ]] || die "usage: render.sh sts-placement <party> [--avoid-node NODE | --undo]"; num "$2" >/dev/null
    if [[ "${3:-}" == --undo ]]; then printf '%s\n' '{"spec":{"template":{"spec":{"affinity":null}}}}'; else sts_placement "${4:-}"; fi; exit 0 ;;
  pull-secret) [[ $# == 2 ]] || die "usage: render.sh pull-secret <party>"; num "$2" >/dev/null; pull_secret; exit 0 ;;
  pull-test) [[ $# == 4 && "$3" == --image ]] || die "usage: render.sh pull-test <party> --image REF"; num "$2" >/dev/null; pull_test "$2" "$4"; exit 0 ;;
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
