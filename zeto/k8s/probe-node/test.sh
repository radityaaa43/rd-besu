#!/usr/bin/env bash
# Offline test of zeto/k8s/probe-node (the (iv) node-read probe pod): `./test.sh`. Needs bash, python3 + PyYAML. No cluster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/test/check.py" "$here/render.sh"
