#!/usr/bin/env bash
# The ONE change to the old stack in PLAN S3: add an ingress rule for TCP 30303 from rd-zeto-* / rd-stealth-* to each old
# besu-node-validator-N-ingress NetworkPolicy (JSON-patch `add` at the end of /spec/ingress; nothing is removed or replaced).
# Default: PRINT the four commands. APPLY=1 runs them (cluster admin, own GO). Rollback: remove the last ingress element of each policy.
set -euo pipefail
rule='{"from":[{"namespaceSelector":{"matchExpressions":[{"key":"part-of","operator":"In","values":["rd-zeto","rd-stealth"]}]}}],"ports":[{"port":30303,"protocol":"TCP"}]}'
for n in 1 2 3 4; do
  cmd="kubectl -n besu patch networkpolicy besu-node-validator-$n-ingress --type=json -p '[{\"op\":\"add\",\"path\":\"/spec/ingress/-\",\"value\":$rule}]'"
  echo "$cmd"
  if [[ "${APPLY:-0}" == 1 ]]; then eval "$cmd"; fi
done
