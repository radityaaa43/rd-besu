#!/usr/bin/env bash
# Offline test of stealth-address/k8s/rpc (S4/S5): `./test-rpc.sh`. Needs bash, python3 + PyYAML, openssl. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/rpc/test/check.py" "$here/rpc"
