#!/usr/bin/env bash
# Offline test of zeto/k8s/postgres (S8): `./test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 -I "$here/test/check.py" "$here/render.sh" "$here/compare-counts.py" "$here/../render.sh"
exec "$here/rotate/test.sh"
