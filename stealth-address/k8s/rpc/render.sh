#!/usr/bin/env bash
# Render the stealth S4/S5 Besu JWT RPC node manifests (final-design/stealth/PLAN.md S4 cluster 1, S5 bank C) to stdout. Never talks to a cluster.
#   render.sh [--cluster 2] net <party>                                   Services besu-rpc (ClusterIP 8545), besu-rpc-hs (headless), NetworkPolicy besu-rpc-ingress
#   render.sh [--cluster 2] node <party> --static-nodes FILE [--storage-class C]   ConfigMaps besu-rpc-config + besu-static-nodes, StatefulSet besu-rpc
# Before `node`: ./genesis.sh <p> | kubectl apply -f - (admin), ./nodekey.sh <p> and ./jwt.sh <p> (party kubeconfig). Parties bi, bank-a, bank-b;
# bank-c only with --cluster 2 (smaller requests, no node exclusion, label cluster="2"). The node dials the zeto validators; it exposes TCP 8545 only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "render.sh: $*" >&2; exit 2; }

cluster=1
if [[ "${1:-}" == --cluster ]]; then [[ "${2:-}" == 2 ]] || die "--cluster supports only 2"; cluster=2; shift 2; fi
stage="${1:-}"; party="${2:-}"
[[ -n "$stage" && -n "$party" ]] || die "usage: render.sh [--cluster 2] net|node <party> [options]"
shift 2
if [[ "$party" == bank-c ]]; then
  [[ $cluster == 2 ]] || die "bank-c is on cluster 2: use --cluster 2"
  lbl="part-of: rd-stealth, party: bank-c, cluster: \"2\""; cpu_req=250m; mem_req=1G; cpu_lim='"1"'; mem_lim=2G
else
  [[ $cluster == 1 ]] || die "--cluster 2 renders bank-c only"
  case "$party" in bi|bank-a|bank-b) ;; *) die "unknown party '$party' (allowed: bi bank-a bank-b, bank-c with --cluster 2)" ;; esac
  lbl="part-of: rd-stealth, party: $party"; cpu_req=500m; mem_req=1500M; cpu_lim='"2"'; mem_lim=3G
fi
ns="rd-stealth-$party"
image="hyperledger/besu:26.8.1"

net() {
  [[ $# == 0 ]] || die "net takes no options"
  cat <<YAML
# stealth S4/S5: network objects of the JWT RPC node of ${party} in ${ns}.
apiVersion: v1
kind: Service
metadata:
  name: besu-rpc
  namespace: ${ns}
  labels: {${lbl}}
spec:
  type: ClusterIP
  selector: {app.kubernetes.io/name: besu-rpc}
  ports:
    - {name: json-rpc, port: 8545, targetPort: json-rpc, protocol: TCP}
---
apiVersion: v1
kind: Service
metadata:
  name: besu-rpc-hs
  namespace: ${ns}
  labels: {${lbl}}
spec:
  clusterIP: None
  selector: {app.kubernetes.io/name: besu-rpc}
  ports:
    - {name: json-rpc, port: 8545, targetPort: json-rpc, protocol: TCP}
---
# 8545 only from the gateway (app=st-gw) and the signer (app=stealth-signer) of this namespace. S1's allow-same-namespace excludes the
# besu-rpc pod, so this is its only ingress. The node dials the zeto validators (outbound only; the zeto policy admits rd-stealth-*).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: besu-rpc-ingress
  namespace: ${ns}
  labels: {${lbl}}
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: besu-rpc}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchExpressions:
              - {key: app, operator: In, values: [st-gw, stealth-signer]}
      ports:
        - {protocol: TCP, port: 8545}
YAML
}

indent() { sed 's/^/    /' "$1"; echo; }  # echo: a file without trailing newline must not swallow the next "---"

node() {
  local snf="" sc="alicloud-essd-wffc"
  while [[ $# -gt 0 ]]; do case "$1" in
    --static-nodes) snf="${2:?}"; shift 2 ;;
    --storage-class) sc="${2:?}"; shift 2 ;;
    *) die "node: unknown option $1" ;; esac; done
  [[ -n "$snf" ]] || die "node needs --static-nodes <file> (static-nodes.sh output)"
  [[ -s "$snf" ]] || die "static-nodes file '$snf' missing or empty"
  # the RPC node peers ONLY with its own party's zeto node (user decision): exactly one enode, so sync-min-peers=1 holds
  [[ "$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$snf")" == 1 ]] || die "static-nodes must hold exactly ONE enode (the own party's zeto node)"
  local affinity=""
  if [[ $cluster == 1 ]]; then
    affinity="      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - {key: kubernetes.io/hostname, operator: NotIn, values: [member-16033-node, member-16034-node]}"
  fi
  cat <<YAML
# stealth S4/S5: the JWT RPC node of ${party} in ${ns}: non-validator, ETH/NET/WEB3 only, JWT on every request, no WebSocket, no CORS.
# Config = the live validator config.toml with the S4 changes (templates/config.toml).
apiVersion: v1
kind: ConfigMap
metadata:
  name: besu-rpc-config
  namespace: ${ns}
  labels: {${lbl}}
data:
  config.toml: |
YAML
  sed "s/\${NS}/${ns}/g" "$here/templates/config.toml" | sed 's/^/    /'
  echo
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
  name: besu-rpc
  namespace: ${ns}
  labels: {${lbl}, app.kubernetes.io/name: besu-rpc}
spec:
  serviceName: besu-rpc-hs
  replicas: 1
  podManagementPolicy: OrderedReady
  persistentVolumeClaimRetentionPolicy: {whenDeleted: Retain, whenScaled: Retain}
  selector:
    matchLabels: {app.kubernetes.io/name: besu-rpc}
  template:
    metadata:
      labels: {${lbl}, app.kubernetes.io/name: besu-rpc}
    spec:
${affinity}
      terminationGracePeriodSeconds: 60
      automountServiceAccountToken: false
      initContainers:
        - name: volume-permission-besu
          image: busybox:1.36
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
          # tcpSocket on purpose: with JWT on, an httpGet on /liveness may answer 401 (whether Besu exempts it is [unverified]) and the kubelet would restart the pod in a loop.
          livenessProbe:
            tcpSocket: {port: 8545}
            initialDelaySeconds: 180
            periodSeconds: 60
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            requests: {cpu: ${cpu_req}, memory: ${mem_req}}
            limits: {cpu: ${cpu_lim}, memory: ${mem_lim}}
          volumeMounts:
            - {name: besu-keys, mountPath: /keys, readOnly: true}
            - {name: genesis, mountPath: /etc/genesis, readOnly: true}
            - {name: static-nodes, mountPath: /config/static}
            - {name: besu-config, mountPath: /etc/besu, readOnly: true}
            - {name: jwt, mountPath: /jwt, readOnly: true}
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
          configMap: {name: besu-rpc-config}
        - name: besu-keys
          secret: {secretName: besu-rpc-nodekey}
        - name: jwt
          secret:
            secretName: stealth-rpc-jwt
            items: [{key: public.pem, path: public.pem}]
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
  node) node "$@" ;;
  *) die "unknown stage '$stage' (net, node)" ;;
esac
