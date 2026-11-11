#!/usr/bin/env bash
# Offline test of stealth-address/k8s/gateway (S17): `./test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl, no Envoy (CI runs `envoy --mode validate`).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/test/check.py" "$here/render.sh"
