#!/usr/bin/env bash
# Offline test of stealth-address/k8s/egress (R17-stealth: narrow egress per workload, selector form): `./test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/test/check.py" "$here/render.sh"
