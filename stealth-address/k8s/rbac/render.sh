#!/usr/bin/env bash
# Render the S11 rework RBAC to stdout. Never talks to a cluster.
#   render.sh viewcopies   ServiceAccount stealth-bi-signer + Role stealth-bi-viewcopies-writer + RoleBinding, all in rd-stealth-bi.
# The BI signer stores the banks' pushed view-key copies in Secret stealth-bi-viewcopies through the kube API (signer/render.sh bi --viewcopy-store mounts this ServiceAccount's token;
# egress/render.sh signer bi --kube-api-ip opens :6443). The Role is namespaced and limited to that ONE Secret by name: get, patch, update. No list, watch, create or delete (the operator creates
# the Secret empty). party-admin cannot create roles or serviceaccounts: the cluster operator applies this (one named, logged cluster-admin write) and removes it on rollback.
# Needs bash only.
set -euo pipefail
die() { echo "render.sh: $*" >&2; exit 2; }
[[ $# -eq 1 && "$1" == viewcopies ]] || die "usage: render.sh viewcopies"
cat <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: stealth-bi-signer
  namespace: rd-stealth-bi
  labels: {part-of: rd-stealth, party: bi}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: stealth-bi-viewcopies-writer
  namespace: rd-stealth-bi
  labels: {part-of: rd-stealth, party: bi}
rules:
- apiGroups: [""]
  resources: [secrets]
  resourceNames: [stealth-bi-viewcopies]
  verbs: [get, patch, update]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: stealth-bi-viewcopies-writer
  namespace: rd-stealth-bi
  labels: {part-of: rd-stealth, party: bi}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: stealth-bi-viewcopies-writer}
subjects:
- {kind: ServiceAccount, name: stealth-bi-signer, namespace: rd-stealth-bi}
YAML
