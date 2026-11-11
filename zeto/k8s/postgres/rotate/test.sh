#!/usr/bin/env bash
# Offline test of the R1 password-rotation Job (render + rotate.sh against a local TLS server and a fake psql): `./test.sh`.
# Needs bash, openssl, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/test/check.py" "$here/render.sh" "$here/rotate.sh" "$here/test/fake-psql" "$here/../../paladin/render.sh"
