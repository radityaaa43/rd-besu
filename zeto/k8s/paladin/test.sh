#!/usr/bin/env bash
# Offline test of zeto/k8s/paladin (S9): `./test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 -I "$here/test/check.py" "$here/render.sh"
exec python3 -I "$here/test/s21_test.py" "$here/s21/s21.py" "$here/test/fake-kubectl"
