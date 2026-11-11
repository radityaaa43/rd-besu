#!/usr/bin/env bash
# Offline test of zeto/k8s/besu/vote.sh (S5a): `./test-vote.sh`. Needs bash + python3 (stdlib). No cluster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/besu/test/vote_test.py" "$here/besu/vote.sh"
