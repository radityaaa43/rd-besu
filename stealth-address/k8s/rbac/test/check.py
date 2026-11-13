#!/usr/bin/env python3
"""Offline check of the S11 rework RBAC render (stealth-address/k8s/rbac/render.sh viewcopies): the BI signer may get/patch/update ONE Secret, nothing else.
Usage: check.py <render.sh>. Exit 0 = all assertions hold; 1 = failures on stderr. Needs PyYAML; no cluster."""
import os, subprocess, sys, tempfile, yaml

render = os.path.abspath(sys.argv[1])
SIGNER = os.path.join(os.path.dirname(os.path.dirname(render)), "signer", "render.sh")
fails = []


def check(ok, msg):
    if not ok:
        fails.append(msg)


def run(exe, *a):
    try:
        return subprocess.run([exe, *a], capture_output=True, text=True)
    except FileNotFoundError as e:
        return subprocess.CompletedProcess(a, 127, "", str(e))


r = run(render, "viewcopies")
check(r.returncode == 0, f"render.sh viewcopies exited {r.returncode}: {r.stderr.strip()[:200]}")
ds = [d for d in yaml.safe_load_all(r.stdout) if d] if r.returncode == 0 else []
check([d["kind"] for d in ds] == ["ServiceAccount", "Role", "RoleBinding"], f"exactly ServiceAccount, Role, RoleBinding in this order (no ClusterRole/ClusterRoleBinding): {[d['kind'] for d in ds]}")
check(all(d["apiVersion"] in ("v1", "rbac.authorization.k8s.io/v1") and d["metadata"].get("namespace") == "rd-stealth-bi" for d in ds), "every object is namespaced in rd-stealth-bi")
check(all(d["metadata"].get("labels") == {"part-of": "rd-stealth", "party": "bi"} for d in ds), "labels part-of=rd-stealth, party=bi")
by = {d["kind"]: d for d in ds}
sa, role, rb = by.get("ServiceAccount"), by.get("Role"), by.get("RoleBinding")
check(sa is not None and sa["metadata"]["name"] == "stealth-bi-signer", "ServiceAccount stealth-bi-signer")
check(role is not None and role["metadata"]["name"] == "stealth-bi-viewcopies-writer", "Role stealth-bi-viewcopies-writer")
if role:
    check(role["rules"] == [{"apiGroups": [""], "resources": ["secrets"], "resourceNames": ["stealth-bi-viewcopies"], "verbs": ["get", "patch", "update"]}], f"Role: exactly ONE rule, secrets, resourceNames [stealth-bi-viewcopies], verbs [get, patch, update] (got {role['rules']})")
    for bad in ("list", "watch", "delete", "create", "deletecollection", "*"):
        check(bad not in str(role["rules"]), f"Role never grants {bad}")
if rb:
    check(rb["metadata"]["name"] == "stealth-bi-viewcopies-writer" and rb["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "stealth-bi-viewcopies-writer"}, "RoleBinding -> Role stealth-bi-viewcopies-writer (kind Role, not ClusterRole)")
    check(rb["subjects"] == [{"kind": "ServiceAccount", "name": "stealth-bi-signer", "namespace": "rd-stealth-bi"}], f"RoleBinding subject: only ServiceAccount stealth-bi-signer of rd-stealth-bi (got {rb.get('subjects')})")
# the name must match what the BI signer Deployment uses with --viewcopy-store
chain = os.path.join(tempfile.mkdtemp(), "chain.env")
open(chain, "w").write("".join(f"{k}={v}\n" for k, v in {"CHAIN_ID": "1337", "RD": "0x" + "1" * 40, "BOND": "0x" + "2" * 40, "ANNOUNCER": "0x" + "3" * 40, "VALIDATOR": "0x" + "4" * 40, "DVP_FACTORY": "0x" + "5" * 40, "FROM_BLOCK": "1"}.items()))
sg = run(SIGNER, "bi", "--image", "registry.example/x@sha256:" + "0" * 64, "--chain-env", chain, "--cert-url", "https://st-gw-1.rd-stealth-bi.svc.cluster.local:8550", "--viewcopy-store", "--registry", "0x" + "66" * 20)
dep = next((d for d in yaml.safe_load_all(sg.stdout) if d and d["kind"] == "Deployment"), None) if sg.returncode == 0 else None
check(dep is not None and dep["spec"]["template"]["spec"].get("serviceAccountName") == "stealth-bi-signer", "the signer render bi --viewcopy-store uses the ServiceAccount this render creates")
for a in ([], ["viewcopies", "bank-a"], ["viewcopies", "bi"], ["viewcopies", "--ns", "x"], ["nope"], ["Viewcopies"]):
    check(run(render, *a).returncode == 2, f"render.sh {' '.join(a)} must be refused with exit 2")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK stealth rbac: viewcopies = ServiceAccount + one-Secret Role + RoleBinding in rd-stealth-bi")
