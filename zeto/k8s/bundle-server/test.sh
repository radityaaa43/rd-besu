#!/usr/bin/env bash
# Offline test of zeto/k8s/bundle-server (S17 part): `./test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/test/check.py" "$here/render.sh"
