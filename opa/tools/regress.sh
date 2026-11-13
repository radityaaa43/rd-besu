#!/usr/bin/env bash
# Run the publish regression template (test/regress/regression_test.rego) against CANDIDATE bundles before and after a publish.
#   regress.sh <bi.tar.gz> <bank-a.tar.gz> <bank-b.tar.gz> <bank-c.tar.gz> [--ref tools/live-docs-2026-11-13.json] [--pub-dir DIR]
# --pub-dir: DIR/<bi|bank-a|bank-b|bank-c>.pub (PUBLIC keys only) -> each bundle's signature is verified first.
# --ref: the Kebijakan documents of the candidate must equal the reference hashes (policy-docs.py diff; set POLICY_DOCS_AS per bundle).
# Needs opa, python3, openssl. Stops at the first error. The live checks (outsider C sealed, live 4/4 read) are in PUBLISH-REGRESSION.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; opa_dir="$here/.."
[[ $# -ge 4 ]] || { sed -n 2,7p "$0" >&2; exit 2; }
bi="$1"; ba="$2"; bb="$3"; bc="$4"; shift 4
ref=""; pub=""
while [[ $# -gt 0 ]]; do case "$1" in --ref) ref="$2"; shift 2 ;; --pub-dir) pub="$2"; shift 2 ;; *) echo "regress.sh: unknown argument $1" >&2; exit 2 ;; esac; done
if [[ -n "$pub" ]]; then
  for x in "bi:$bi" "bank-a:$ba" "bank-b:$bb" "bank-c:$bc"; do python3 -I "$here/policy-docs.py" verify "${x#*:}" --pub "$pub/${x%%:*}.pub"; done
fi
if [[ -n "$ref" ]]; then
  python3 -I "$here/policy-docs.py" diff "$bi" "$ref"
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
python3 -I - "$tmp/candidate.json" "$bi" "$ba" "$bb" "$bc" <<'PY'
import json, sys, tarfile
out, bi, *banks = sys.argv[1:]
rd = lambda p: json.loads(tarfile.open(p).extractfile("/data.json").read())
cand = {"bi": rd(bi)["bi"]["config"], "bank": {n: rd(p)["bank"]["config"] for n, p in zip(("bank-a", "bank-b", "bank-c"), banks)}}
json.dump({"candidate": cand}, open(out, "w"))
PY
cd "$opa_dir"
opa test bundles/bi bundles/bank test "$tmp/candidate.json" --run 'regress_test'
echo "regress.sh: candidate passes the publish regression template"
