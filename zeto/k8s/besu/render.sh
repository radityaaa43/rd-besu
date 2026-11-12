#!/usr/bin/env bash
# Render the zeto S3/S4 Besu node manifests (final-design/zeto/PLAN.md S3 cluster 1, S4 bank C) to stdout. Never talks to a cluster.
# Stages, in apply order (each is its own CLUSTER-OP sub-step):
#   0. ./genesis.sh <party> | kubectl apply -f -          ConfigMap besu-genesis, copied byte-identical from ns besu (admin)
#      ./nodekey.sh <party>                                Secret besu-nodekey, generated inside the namespace
#   1. render.sh net <party> [--external-cidr CIDR]... [--acl-id acl-X (needs a CIDR) [--clb-health-cidr 100.64.0.0/10, only after the ACL is verified]]   Services (LoadBalancer besu-p2p TCP 30303, headless, ClusterIP rpc) + NetworkPolicy
#   2. render.sh nodeinfo <party>                          Job that prints the node public key and address (public data) from the Secret
#   3. ./static-nodes.sh ... > static-nodes.json           IP-only enodes (old validators by pod IP, other new nodes by LB IP)
#      render.sh node <party> --p2p-host <LB IP> --static-nodes static-nodes.json [--storage-class C]
#                                                         ConfigMaps besu-config + besu-static-nodes, StatefulSet besu-validator (non-validator at start)
#   4. ./old-netpol-patch.sh                               the one added rule in the old ns besu (prints; APPLY=1 runs)
# Parties: bi, bank-a, bank-b (cluster 1, S3), bank-c (cluster 2, S4: smaller requests, no node exclusion). Needs bash + sed only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "render.sh: $*" >&2; exit 2; }

stage="${1:-}"; party="${2:-}"
[[ -n "$stage" && -n "$party" ]] || die "usage: render.sh net|nodeinfo|node <bi|bank-a|bank-b|bank-c> [options]"
shift 2
case "$party" in
  bi|bank-a|bank-b) ns="rd-zeto-$party"; lbl="part-of: rd-zeto, party: $party"; cpu_req=500m; mem_req=2500M; cpu_lim='"3"'; mem_lim=5G ;;
  bank-c) ns="rd-zeto-bank-c"; lbl="part-of: rd-zeto, party: bank-c, cluster: \"2\""; cpu_req=250m; mem_req=1500M; cpu_lim='"2"'; mem_lim=3G ;;
  *) die "unknown party '$party' (allowed: bi bank-a bank-b bank-c)" ;;
esac
image="hyperledger/besu:26.8.1@sha256:6f3f21ce533383fcc8db3bce02252b59d5a9e776b72b5a1c8ecd2db011600042"
sel='{app.kubernetes.io/name: besu-validator}'

net() {
  local cidrs=() acl="" health="" ; while [[ $# -gt 0 ]]; do case "$1" in
    --external-cidr) cidrs+=("${2:?--external-cidr needs a CIDR}"); shift 2 ;;
    --acl-id) acl="${2:?--acl-id needs an ACL id}"; shift 2 ;;
    --clb-health-cidr) health="${2:?--clb-health-cidr needs a CIDR}"; shift 2 ;;
    *) die "net: unknown option $1" ;; esac; done
  # live state (2026-11-11): the public CLB only admits the ACL (pre-created cloud resource, whitelist) and reaches pods by ENI;
  # the CLB health check comes from 100.64.0.0/10, add it (--clb-health-cidr) only after the ACL is verified on the listener.
  local ann="" lbsr=""
  if [[ -n "$acl" ]]; then
    [[ "$acl" =~ ^acl-[a-z0-9]+$ ]] || die "net: --acl-id must match acl-[a-z0-9]+"
    [[ -n "${cidrs[*]:-}" ]] || die "net: --acl-id needs at least one --external-cidr (loadBalancerSourceRanges)"
    ann=$'  annotations:\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-status: "on"\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-type: white\n    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id: '"$acl"$'\n    service.beta.kubernetes.io/backend-type: eni\n'
    lbsr="  loadBalancerSourceRanges:"; local c; for c in "${cidrs[@]}"; do lbsr+=$'\n'"    - $c"; done; lbsr+=$'\n'
  fi
  cat <<YAML
# zeto S3/S4: network objects of the Besu node of ${party} in ${ns}. Apply first: the LoadBalancer IP is what --p2p-host needs in stage 3.
apiVersion: v1
kind: Service
metadata:
  name: besu-p2p
  namespace: ${ns}
  labels: {${lbl}}
${ann}spec:
  type: LoadBalancer
${lbsr}  selector: ${sel}
  ports:
    - {name: rlpx, port: 30303, targetPort: rlpx, protocol: TCP}
---
apiVersion: v1
kind: Service
metadata:
  name: besu-validator
  namespace: ${ns}
  labels: {${lbl}}
spec:
  clusterIP: None
  selector: ${sel}
  ports:
    - {name: json-rpc, port: 8545, targetPort: json-rpc, protocol: TCP}
    - {name: ws, port: 8546, targetPort: ws, protocol: TCP}
    - {name: metrics, port: 9545, targetPort: metrics, protocol: TCP}
    - {name: rlpx, port: 30303, targetPort: rlpx, protocol: TCP}
---
apiVersion: v1
kind: Service
metadata:
  name: besu-rpc
  namespace: ${ns}
  labels: {${lbl}}
spec:
  type: ClusterIP
  selector: ${sel}
  ports:
    - {name: json-rpc, port: 8545, targetPort: json-rpc, protocol: TCP}
    - {name: ws, port: 8546, targetPort: ws, protocol: TCP}
---
# This policy is the validator's ONLY ingress (allow-same-namespace excludes it). 30303 TCP: from the other new validators (ns part-of=rd-zeto)
# and, across clusters, from the CIDRs given with --external-cidr. 8545/8546: only from this namespace's bank-gw (Lensa and the stealth signer
# reach the validator through it, OPA method allowlist) and Paladin. The old ns besu and the stealth RPC nodes were deleted (user, 2026-11-12).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: besu-validator-ingress
  namespace: ${ns}
  labels: {${lbl}}
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: besu-validator}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchExpressions:
              - {key: part-of, operator: In, values: [rd-zeto]}
YAML
  local c; for c in "${cidrs[@]:-}"; do [[ -z "$c" ]] || printf '        - ipBlock:\n            cidr: %s\n' "$c"; done
  cat <<YAML
      ports:
        - {protocol: TCP, port: 30303}
    - from:
        - podSelector:
            matchExpressions:
              - {key: app, operator: In, values: [bank-gw, paladin]}
      ports:
        - {protocol: TCP, port: 8545}
        - {protocol: TCP, port: 8546}
YAML
  if [[ -n "$health" ]]; then
    printf '    - from:\n        - ipBlock:\n            cidr: %s\n      ports:\n        - {protocol: TCP, port: 30303}\n' "$health"
  fi
}

nodeinfo() {
  cat <<YAML
# zeto S3/S4: prints the node public key (enode id) and address of Secret besu-nodekey. Public data only; the key itself is never printed.
apiVersion: batch/v1
kind: Job
metadata:
  name: besu-nodeinfo
  namespace: ${ns}
  labels: {${lbl}}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels: {${lbl}, app.kubernetes.io/name: besu-nodeinfo}
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      enableServiceLinks: false   # Service besu-p2p would inject BESU_P2P_PORT=tcp://..., read by Besu as --p2p-port
      containers:
        - name: nodeinfo
          image: ${image}
          command: [/bin/sh, -c]
          args:
            - |
              echo "public key (enode id = this value without the leading 0x; enode://<id>@<LB IP>:30303?discport=0):"
              /opt/besu/bin/besu public-key export --node-private-key-file=/keys/nodekey
              echo "address (for qbft_proposeValidatorVote):"
              /opt/besu/bin/besu public-key export-address --node-private-key-file=/keys/nodekey
          resources:
            requests: {cpu: 100m, memory: 256Mi}
            limits: {memory: 512Mi}
          securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
          volumeMounts:
            - {name: besu-keys, mountPath: /keys, readOnly: true}
      volumes:
        - name: besu-keys
          secret: {secretName: besu-nodekey}
YAML
}

indent() { sed 's/^/    /' "$1"; echo; }  # echo: files without a trailing newline must not swallow the next "---"

node() {
  local host="" snf="" sc="alicloud-essd-wffc"
  while [[ $# -gt 0 ]]; do case "$1" in
    --p2p-host) host="${2:?}"; shift 2 ;;
    --static-nodes) snf="${2:?}"; shift 2 ;;
    --storage-class) sc="${2:?}"; shift 2 ;;
    *) die "node: unknown option $1" ;; esac; done
  [[ -n "$host" ]] || die "node needs --p2p-host <LoadBalancer IP> (apply stage net first)"
  [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--p2p-host must be an IPv4 address, not a name (enode carries one IP)"
  [[ -n "$snf" ]] || die "node needs --static-nodes <file> (static-nodes.sh output)"
  [[ -s "$snf" ]] || die "static-nodes file '$snf' missing or empty"
  local cfg="$here/templates/config.toml"
  local affinity
  if [[ "$party" == bank-c ]]; then
    affinity="      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:   # preferred only: with class alicloud-essd (Immediate) the PV zone fixes the pod zone, a hard selector could deadlock
            - weight: 100
              preference:
                matchExpressions:
                  - {key: topology.kubernetes.io/zone, operator: In, values: [ap-southeast-1a]}
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector: {matchLabels: {rd/role: besu-validator}}
              namespaceSelector: {matchLabels: {part-of: rd-zeto}}
              topologyKey: kubernetes.io/hostname"
  else
    affinity="      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - {key: kubernetes.io/hostname, operator: NotIn, values: [member-16033-node, member-16034-node]}
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector: {matchLabels: {rd/role: besu-validator}}
              namespaceSelector: {matchLabels: {part-of: rd-zeto}}
              topologyKey: kubernetes.io/hostname"
  fi
  cat <<YAML
# zeto S3/S4: the Besu node of ${party} in ${ns}. Starts as a NON-validator (the genesis validators are the 4 old ones; S5a votes it in).
# Config = the live validator config.toml with two changes: discovery-enabled=false, p2p-host=<LoadBalancer IP> (templates/config.toml).
apiVersion: v1
kind: ConfigMap
metadata:
  name: besu-config
  namespace: ${ns}
  labels: {${lbl}}
data:
  config.toml: |
YAML
  sed "s/\${P2P_HOST}/$host/" "$cfg" | sed 's/^/    /'
  echo
  echo   # the live config has no trailing newline; without this the next "---" would join its last comment line
  cat <<YAML
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: besu-static-nodes
  namespace: ${ns}
  labels: {${lbl}}
data:
  static-nodes.json: |
YAML
  indent "$snf"
  cat <<YAML
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: besu-validator
  namespace: ${ns}
  labels: {${lbl}, app.kubernetes.io/name: besu-validator}
spec:
  serviceName: besu-validator
  replicas: 1
  podManagementPolicy: OrderedReady
  persistentVolumeClaimRetentionPolicy: {whenDeleted: Retain, whenScaled: Retain}
  selector:
    matchLabels: {app.kubernetes.io/name: besu-validator}
  template:
    metadata:
      labels: {${lbl}, app.kubernetes.io/name: besu-validator, rd/role: besu-validator}
      annotations: {prometheus.io/scrape: "true", prometheus.io/port: "9545", prometheus.io/path: /metrics}
    spec:
      enableServiceLinks: false   # Service besu-p2p would inject BESU_P2P_PORT=tcp://..., read by Besu as --p2p-port
${affinity}
      terminationGracePeriodSeconds: 60
      initContainers:
        - name: volume-permission-besu
          image: busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
          command: [sh, -c, "chown -R 1000:1000 /data"]
          securityContext: {runAsUser: 0}
          volumeMounts:
            - {name: data, mountPath: /data}
      containers:
        - name: besu
          image: ${image}
          imagePullPolicy: IfNotPresent
          command: [/bin/sh, -c]
          args:
            - "exec /opt/besu/bin/besu --config-file=/etc/besu/config.toml --min-gas-price=0 --nat-method=NONE"
          env:
            - {name: BESU_OPTS, value: "-XX:MaxRAMPercentage=70 -XX:+UseG1GC -XX:MaxGCPauseMillis=100"}
          ports:
            - {name: json-rpc, containerPort: 8545, protocol: TCP}
            - {name: ws, containerPort: 8546, protocol: TCP}
            - {name: rlpx, containerPort: 30303, protocol: TCP}
            - {name: metrics, containerPort: 9545, protocol: TCP}
          livenessProbe:
            httpGet: {path: /liveness, port: 8545, scheme: HTTP}
            initialDelaySeconds: 180
            periodSeconds: 60
            timeoutSeconds: 1
            failureThreshold: 3
            successThreshold: 1
          resources:
            requests: {cpu: ${cpu_req}, memory: ${mem_req}}
            limits: {cpu: ${cpu_lim}, memory: ${mem_lim}}
          volumeMounts:
            - {name: besu-keys, mountPath: /keys, readOnly: true}
            - {name: genesis, mountPath: /etc/genesis, readOnly: true}
            - {name: static-nodes, mountPath: /config/static}
            - {name: besu-config, mountPath: /etc/besu, readOnly: true}
            - {name: data, mountPath: /data/besu}
      volumes:
        - name: genesis
          configMap:
            name: besu-genesis
            items: [{key: genesis.json, path: genesis.json}]
        - name: static-nodes
          configMap:
            name: besu-static-nodes
            items: [{key: static-nodes.json, path: static-nodes.json}]
        - name: besu-config
          configMap: {name: besu-config}
        - name: besu-keys
          secret: {secretName: besu-nodekey}
  volumeClaimTemplates:
    - metadata:
        name: data
        labels: {${lbl}}
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: ${sc}
        resources:
          requests: {storage: 40Gi}
YAML
}

case "$stage" in
  net) net "$@" ;;
  nodeinfo) nodeinfo ;;
  node) node "$@" ;;
  *) die "unknown stage '$stage' (net, nodeinfo, node)" ;;
esac
