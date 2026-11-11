#!/usr/bin/env bash
# zeto S5a validator vote helper, see vote.py. Needs bash + python3 (stdlib). Never talks to a cluster; the caller port-forwards.
exec python3 -I "$(cd "$(dirname "$0")" && pwd)/vote.py" "$@"
