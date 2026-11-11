#!/usr/bin/env bash
# The (iv) node-read PROBE POD (analyst ruling 2026-11-12): the only party-credential way to read a Paladin node's RPC (party-admin has no pods/exec,
# pods/portforward or services/proxy). Created by that party's party-admin in its own ns; read the result with pods/log under the same credential; delete the pod after.
#   render.sh <bi|bank-a|bank-b|bank-c> --image REF@sha256:<64 hex> [--mode count|jq] [--method M] [--params JSON]
# Pod `node-probe`: label rd/egress-locked=true (allow-dns-egress excludes it, so its own NetworkPolicy is the only egress policy: R17-0 must be live first; quote the
# union of ALL selecting Egress policies before relying on it), image by digest, no ServiceAccount token, no Secret/env/volume, runAsNonRoot, RO rootfs, drop ALL,
# deadline 60 s. NetworkPolicy node-probe: egress only to paladin-node<N>:8548 of its own ns + kube-dns 53 (a Service name is used); ingress none.
# NetworkPolicy node-probe-to-paladin: the node's 8548 admits the probe pod too (paladin-ingress admits bank-gw only). NOT via the gateway/OPA door: the
# pending read is a node-admin RPC, not on the Lensa allow-list.
# --mode count (default, image with busybox wget, e.g. busybox): prints ONLY `0` (result is []), `NONZERO` or `ERROR`, never the body.
# --mode jq (image with curl + jq): prints ONLY `jq '.result | length'`. --method/--params default: ptx_queryPendingTransactions [{"limit":20},false].
# Parameterised for the Paladin pending [] gate now; Iroha / stealth RPC reads reuse the pattern with their own Service and port (a new render).
set -euo pipefail
die() { echo "render.sh: $*" >&2; exit 2; }
party="${1:-}"; case "$party" in bi) n=1 ;; bank-a) n=2 ;; bank-b) n=3 ;; bank-c) n=4 ;; *) die "usage: render.sh <bi|bank-a|bank-b|bank-c> --image REF@sha256:<64 hex> [--mode count|jq] [--method M] [--params JSON]" ;; esac
shift; img=""; mode=count; method=ptx_queryPendingTransactions; params='[{"limit":20},false]'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) img="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --method) method="${2:-}"; shift 2 ;;
    --params) params="${2:-}"; shift 2 ;;
    *) die "unknown argument '$1'" ;;
  esac
done
[[ "$img" =~ ^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$ ]] || die "--image must be digest-pinned (REF@sha256:<64 lowercase hex>)"
[[ "$mode" == count || "$mode" == jq ]] || die "--mode must be count or jq"
[[ "$method" =~ ^[a-z]+_[A-Za-z]+$ ]] || die "--method must look like ptx_queryPendingTransactions"
[[ "$params" =~ ^[][{}\",:\ 0-9A-Za-z._-]+$ ]] || die "--params may only contain JSON-safe characters (no quotes ' ; \$ \` etc.)"
ns="rd-zeto-$party"; url="http://paladin-node$n:8548"
body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
if [[ "$mode" == jq ]]; then
  script="curl -sS -m 10 -H 'content-type: application/json' -d '$body' $url | jq -r '.result | length'"
else
  script="R=\$(wget -q -T 10 -O - --header 'content-type: application/json' --post-data '$body' $url) || { echo ERROR; exit 1; }; case \"\$R\" in *'\"result\":[]'*) echo 0 ;; *) echo NONZERO ;; esac"
fi
sel='{rd/egress-locked: "true", app: node-probe}'
node="{app: paladin, app.kubernetes.io/name: paladin-node$n}"
cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: node-probe
  namespace: $ns
  labels: {"rd/egress-locked": "true", app: node-probe, part-of: rd-zeto, party: $party}
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 60
  automountServiceAccountToken: false
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: $img
      command: [sh, -c, "$(printf '%s' "$script" | sed 's/\\/\\\\/g; s/"/\\"/g')"]
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 10m, memory: 16Mi}, limits: {memory: 64Mi}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: node-probe
  namespace: $ns
  labels: {part-of: rd-zeto, party: $party}
spec:
  podSelector:
    matchLabels: {"rd/egress-locked": "true", app: node-probe}
  policyTypes: [Egress, Ingress]
  egress:
    - to:
        - podSelector:
            matchLabels: $node
      ports:
        - {protocol: TCP, port: 8548}
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: node-probe-to-paladin
  namespace: $ns
  labels: {part-of: rd-zeto, party: $party}
spec:
  podSelector:
    matchLabels: $node
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: {"rd/egress-locked": "true", app: node-probe}
      ports:
        - {protocol: TCP, port: 8548}
YAML
