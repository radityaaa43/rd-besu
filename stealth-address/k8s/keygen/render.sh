#!/usr/bin/env bash
# Render the stealth keygen Job (Option C, analyst ruling; same pattern as the iroha auditor key): the key is made IN a pod of the party's own namespace and written by that pod into a
# PRE-CREATED, EMPTY Secret; only PUBLIC values (derived address / meta-address) are printed. Never talks to a cluster; the live apply needs its own GO.
#   render.sh <cert|bi> --image REF@sha256:<64 hex> --kube-api-ip IPv4 [--kube-api-ip IPv4]... [--pull-secret NAME]
# cert -> rd-stealth-bi, Secret stealth-cert-key, key certKey (the custodian's cert-signing key; NEVER a copy of the deployer key).
# bi   -> rd-stealth-bi, Secret stealth-bi-keys, keys spendKey + viewKey (BI's own receive keys). issuerKey is NOT generated here: it is the on-chain issuer key and is moved by S12.
# Objects: ServiceAccount stealth-keygen-<w>, Role (get/update/patch on resourceNames [the Secret] ONLY: no create/list/watch/delete), RoleBinding, NetworkPolicy stealth-keygen-<w>-egress
# (kube API ENDPOINT IPs /32 :6443 ONLY; the ClusterIP and hostnames are closed on this CNI; no DNS: the Job reaches the API through the Service env address), Job stealth-keygen-<w>
# (signer image, command keygen.ts; the pod carries rd/egress-locked + rd/egress so the allow-all baseline never selects it; the only pod of the stealth namespaces with a token).
# The Role/RoleBinding/SA are R13 objects (operator, time-boxed); after the Job the party deletes them all ("RBAC left: []"). The EMPTY Secret is created by the party-admin: kubectl create secret generic <name>.
set -euo pipefail
die() { echo "render.sh: $*" >&2; exit 2; }
usage="usage: render.sh <cert|bi> --image REF@sha256:<64 hex> --kube-api-ip IPv4 [--kube-api-ip IPv4]... [--pull-secret NAME]"
[[ $# -ge 1 ]] || die "$usage"
w="$1"; shift
case "$w" in
  cert) secret=stealth-cert-key; kinds="certKey" ;;
  bi) secret=stealth-bi-keys; kinds="spendKey viewKey" ;;
  *) die "unknown workload '$w' (allowed: cert bi). issuerKey is copied by S12, never generated. $usage" ;;
esac
ns=rd-stealth-bi
image="" pull="" ips=()
ipv4() { local o; [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1; for o in ${1//./ }; do (( 10#$o <= 255 )) || return 1; done; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) image="${2:-}"; shift 2 ;;
    --kube-api-ip) ipv4 "${2:-}" || die "--kube-api-ip must be a plain IPv4 kube API ENDPOINT address (got '${2:-}')"; ips+=("$2"); shift 2 ;;
    --pull-secret) pull="${2:-}"; [[ "$pull" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "--pull-secret must be a DNS-1123 name"; shift 2 ;;
    *) die "unknown option '$1'. $usage" ;;
  esac
done
[[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || die "--image must be pinned by digest (REF@sha256:<64 hex>)"
[[ ${#ips[@]} -ge 1 ]] || die "at least one --kube-api-ip is required. $usage"
name="stealth-keygen-$w"
labels="{app.kubernetes.io/part-of: rd-stealth, party: bi}"
cat <<YAML
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $name
  namespace: $ns
  labels: $labels
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: $name
  namespace: $ns
  labels: $labels
rules:
- apiGroups: [""]
  resources: [secrets]
  resourceNames: [$secret]
  verbs: [get, patch, update]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $name
  namespace: $ns
  labels: $labels
subjects:
- {kind: ServiceAccount, name: $name, namespace: $ns}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: $name}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $name-egress
  namespace: $ns
  labels: $labels
spec:
  podSelector:
    matchLabels: {rd/egress: $name}
  policyTypes: [Egress]
  egress:
  - to:
YAML
for ip in "${ips[@]}"; do echo "    - ipBlock: {cidr: $ip/32}"; done
cat <<YAML
    ports: [{protocol: TCP, port: 6443}]
---
apiVersion: batch/v1
kind: Job
metadata:
  name: $name
  namespace: $ns
  labels: {app: stealth-keygen, role: keygen, rd/egress-locked: "true", rd/egress: $name}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 300
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels: {app: stealth-keygen, role: keygen, rd/egress-locked: "true", rd/egress: $name}
    spec:
      restartPolicy: Never
      serviceAccountName: $name
      automountServiceAccountToken: true
      enableServiceLinks: true
      securityContext: {runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001, seccompProfile: {type: RuntimeDefault}}
YAML
[[ -z "$pull" ]] || printf '      imagePullSecrets:\n      - {name: %s}\n' "$pull"
cat <<YAML
      containers:
      - name: keygen
        image: "$image"
        imagePullPolicy: IfNotPresent
        command: ["node","--experimental-transform-types","signer/src/keygen.ts","$secret",$(printf '"%s",' $kinds | sed 's/,$//')]
        resources:
          requests: {cpu: 50m, memory: 128Mi}
          limits: {memory: 256Mi}
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
YAML
