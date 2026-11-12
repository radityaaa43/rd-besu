#!/usr/bin/env bash
# Offline test of zeto/k8s/egress (R17-zeto-other: narrow egress per workload + the baseline edit, selector form): `./test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 -I "$here/test/gate.py"
python3 -I "$here/test/rbac_exec.py"
exec python3 -I "$here/test/check.py" "$here/render.sh"
