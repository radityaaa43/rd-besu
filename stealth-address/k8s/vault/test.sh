#!/usr/bin/env bash
# Offline test of stealth-address/k8s/vault (S7): `./test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
# Optional: VAULT_CHART_DIR=<dir of the unpacked hashicorp/vault chart 0.34.1> + helm also checks the real chart render (else SKIP, printed).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/test/check.py" "$here/render.sh" "$here/../render.sh" "$here/policies/stealth-signer.hcl"
