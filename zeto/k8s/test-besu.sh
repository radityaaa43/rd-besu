#!/usr/bin/env bash
# Offline test of zeto/k8s/besu (S3/S4): `./test-besu.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/besu/test/check.py" "$here/besu"
