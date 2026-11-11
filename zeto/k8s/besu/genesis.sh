#!/usr/bin/env bash
# Emit ConfigMap besu-genesis for a party namespace, byte-identical `data` to the live one in ns `besu` (final-design/zeto/PLAN.md S3).
# Needs a credential that can read ConfigMaps in ns besu (the cluster admin). Prints JSON (valid YAML) to stdout; apply it with kubectl.
#   ./genesis.sh <bi|bank-a|bank-b|bank-c> | kubectl apply -f -
set -euo pipefail
party="${1:?usage: genesis.sh <bi|bank-a|bank-b|bank-c>}"
case "$party" in bi|bank-a|bank-b|bank-c) ;; *) echo "genesis.sh: unknown party '$party'" >&2; exit 2 ;; esac
kubectl -n besu get configmap besu-genesis -o json | python3 -I -c '
import json, sys
party = sys.argv[1]
d = json.load(sys.stdin)["data"]
labels = {"part-of": "rd-zeto", "party": party}
if party == "bank-c": labels["cluster"] = "2"
print(json.dumps({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "besu-genesis", "namespace": "rd-zeto-" + party, "labels": labels}, "data": d}, indent=2))
' "$party"
