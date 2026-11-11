#!/usr/bin/env bash
# S21 R1: render the one-shot Job that replaces a party's Paladin DB password inside the cluster (rotate.sh), with its own time-boxed RBAC and NetworkPolicy.
#   render.sh <bi|bank-a|bank-b|bank-c> --image postgres@sha256:<64 hex> --api-ips IP[,IP...]
# --image: the ALREADY PINNED paladin-pg postgres image BY DIGEST (no new tool image). --api-ips: the `kubernetes` Endpoints addresses of that cluster
# (kubectl get endpoints kubernetes); the policy allows TCP 443 and 6443 to exactly those /32s. Needs bash + sed only. Never talks to a cluster.
# Objects (all in rd-zeto-<party>): ConfigMap pg-pw-rotate-script, ServiceAccount + Role + RoleBinding pg-pw-rotate (secrets get+patch on
# paladin-pg-credentials ONLY, paladins get+patch on node<N> ONLY (option D: the Job writes the DSN into spec.config); apply before the Job, delete right after: logged in R13), NetworkPolicy pg-pw-rotate (egress only to paladin-pg:5432 and the API IPs; ingress none), Job pg-pw-rotate.
# `patch` instead of `update`: a merge-patch of one key needs no whole-object PUT (and no chunked-response parsing in shell).
# The Job pod carries app=paladin on purpose: allow-dns-egress (egress {}) selects `app NotIn [paladin]` and would otherwise cancel this NetworkPolicy,
# and paladin-pg-ingress admits app=paladin pods to 5432. It matches no Service (paladin-node<N> / paladin-transport need more labels).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "render.sh: $*" >&2; exit 2; }
party="${1:-}"; [[ "$party" =~ ^(bi|bank-a|bank-b|bank-c)$ ]] || die "usage: render.sh <bi|bank-a|bank-b|bank-c> --image REF@sha256:<64 hex> --api-ips IP[,IP...]"
shift; img=""; ips=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) img="${2:-}"; shift 2 ;;
    --api-ips) ips="${2:-}"; shift 2 ;;
    *) die "unknown argument '$1'" ;;
  esac
done
[[ "$img" =~ ^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$ ]] || die "--image must be digest-pinned (REF@sha256:<64 lowercase hex>)"
[[ -n "$ips" ]] || die "--api-ips is required"
IFS=, read -ra arr <<<"$ips"
to=""
for ip in "${arr[@]}"; do
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--api-ips: '$ip' is not an IPv4 address"
  to+="        - ipBlock: {cidr: ${ip}/32}"$'\n'
done
ns="rd-zeto-$party"
case "$party" in bi) num=1 ;; bank-a) num=2 ;; bank-b) num=3 ;; bank-c) num=4 ;; esac
lab="{part-of: rd-zeto, party: $party, job: pg-pw-rotate}"
cat <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: pg-pw-rotate-script
  namespace: $ns
  labels: $lab
data:
  rotate.sh: |
$(sed 's/^/    /' "$here/rotate.sh")
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pg-pw-rotate
  namespace: $ns
  labels: $lab
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pg-pw-rotate
  namespace: $ns
  labels: $lab
rules:
  - apiGroups: [""]
    resources: [secrets]
    resourceNames: [paladin-pg-credentials]
    verbs: [get, patch]
  - apiGroups: [core.paladin.io]
    resources: [paladins]
    resourceNames: [node$num]
    verbs: [get, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pg-pw-rotate
  namespace: $ns
  labels: $lab
subjects:
  - {kind: ServiceAccount, name: pg-pw-rotate, namespace: $ns}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: pg-pw-rotate}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: pg-pw-rotate
  namespace: $ns
  labels: $lab
spec:
  podSelector:
    matchLabels: {job: pg-pw-rotate}
  policyTypes: [Egress, Ingress]
  egress:
    - to:
        - podSelector:
            matchLabels: {app: paladin-pg}
      ports:
        - {protocol: TCP, port: 5432}
    - to:
$to      ports:
        - {protocol: TCP, port: 443}
        - {protocol: TCP, port: 6443}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: pg-pw-rotate
  namespace: $ns
  labels: $lab
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 180
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels: {app: paladin, part-of: rd-zeto, party: $party, job: pg-pw-rotate}
    spec:
      serviceAccountName: pg-pw-rotate
      automountServiceAccountToken: true
      restartPolicy: Never
      securityContext: {runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, seccompProfile: {type: RuntimeDefault}}
      containers:
        - name: rotate
          image: $img
          command: [bash, /scripts/rotate.sh]
          env:
            - {name: NS, valueFrom: {fieldRef: {fieldPath: metadata.namespace}}}
            - {name: PGUSER, valueFrom: {secretKeyRef: {name: paladin-pg-credentials, key: username}}}
            - {name: PGDATABASE, valueFrom: {secretKeyRef: {name: paladin-pg-credentials, key: database}}}
            - {name: PGPASSWORD, valueFrom: {secretKeyRef: {name: paladin-pg-credentials, key: password}}}
            - {name: NODE, value: node$num}
            - {name: TMPDIR, value: /tmp}
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
          resources: {requests: {cpu: 10m, memory: 32Mi}, limits: {memory: 128Mi}}
          volumeMounts:
            - {name: script, mountPath: /scripts, readOnly: true}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: script
          configMap: {name: pg-pw-rotate-script, defaultMode: 0555}
        - name: tmp
          emptyDir: {}
YAML
