#!/usr/bin/env python3
"""Offline check of the rendered stealth L0 manifests (final-design/stealth/PLAN.md S1).
Usage: check.py <render.sh>. Needs PyYAML only; no cluster. Exit 0 = all assertions hold."""
import os, subprocess, sys, tempfile, yaml

render = sys.argv[1]
PARTIES = {"bi": "rd-stealth-bi", "bank-a": "rd-stealth-bank-a", "bank-b": "rd-stealth-bank-b"}
NETPOLS = {"default-deny-ingress", "allow-dns-egress", "allow-same-namespace"}
fails = []

def check(ok, msg):
    if not ok:
        fails.append(msg)

def run(*args):
    try:
        return subprocess.run([render, *args], capture_output=True, text=True)
    except FileNotFoundError as e:
        fails.append(f"render.sh missing: {e}")
        return subprocess.CompletedProcess(args, 127, "", str(e))

def docs(*args):
    out = run(*args)
    if out.returncode != 0:
        fails.append(f"render.sh {' '.join(args)} exited {out.returncode}: {out.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(out.stdout) if d]

def of(ds, kind):
    return [d for d in ds if d["kind"] == kind]

for party, ns in PARTIES.items():
    ds = docs(party)
    check(bool(ds), f"{party}: no objects rendered")
    if not ds:
        continue
    check([n["metadata"]["name"] for n in of(ds, "Namespace")] == [ns], f"{party}: Namespace must be exactly {ns}")
    lab = (of(ds, "Namespace") or [{"metadata": {}}])[0]["metadata"].get("labels", {})
    check(lab.get("part-of") == "rd-stealth" and lab.get("party") == party, f"{party}: labels part-of=rd-stealth, party={party}: {lab}")
    check(not of(ds, "ClusterRole") and not of(ds, "ClusterRoleBinding"), f"{party}: no cluster-scoped RBAC")
    for d in ds:
        if d["kind"] != "Namespace":
            check(d["metadata"].get("namespace") == ns, f"{party}: {d['kind']}/{d['metadata']['name']} not in {ns}")
            check(d["metadata"].get("labels", {}).get("part-of") == "rd-stealth", f"{party}: {d['kind']}/{d['metadata']['name']} label part-of must be rd-stealth")
    got = {d["metadata"]["name"] for d in of(ds, "NetworkPolicy")}
    check(got == NETPOLS, f"{party}: NetworkPolicy names {sorted(got)} != {sorted(NETPOLS)} (no rehearsal policy: no Paladin node)")
    check({d["metadata"]["name"] for d in of(ds, "ServiceAccount")} == {"party-admin"}, f"{party}: only ServiceAccount party-admin")
    check({d["metadata"]["name"] for d in of(ds, "Role")} == {"party-admin"}, f"{party}: only Role party-admin")
    rb = of(ds, "RoleBinding")
    check(len(rb) == 1 and rb[0]["subjects"][0]["namespace"] == ns and rb[0]["roleRef"]["name"] == "party-admin", f"{party}: one RoleBinding party-admin -> SA in {ns}")
    np = {d["metadata"]["name"]: d for d in of(ds, "NetworkPolicy")}
    if NETPOLS <= set(np):
        check(np["default-deny-ingress"]["spec"] == {"podSelector": {}, "policyTypes": ["Ingress"]}, f"{party}: default-deny-ingress shape")
        check(np["allow-same-namespace"]["spec"]["ingress"] == [{"from": [{"podSelector": {}}]}], f"{party}: allow-same-namespace shape")
        check({"key": "app", "operator": "NotIn", "values": ["stealth-signer"]} in np["allow-same-namespace"]["spec"]["podSelector"]["matchExpressions"], f"{party}: allow-same-namespace excludes pods labelled app=stealth-signer (S17)")
        e = np["allow-dns-egress"]["spec"]
        check(e["policyTypes"] == ["Egress"] and e["podSelector"] == {"matchExpressions": [{"key": "app.kubernetes.io/name", "operator": "NotIn", "values": ["besu-rpc", "vault"]}, {"key": "rd/egress-locked", "operator": "DoesNotExist"}]} and e["egress"] == [{}], f"{party}: egress stays open for every pod EXCEPT besu-rpc and vault (own narrow policies, stealth egress/render.sh besu-rpc|vault, R17-zeto-other) and those labelled rd/egress-locked (R17-stealth gate: a signer/scanner/Job with its own narrow policy): {e}")
    rules = (of(ds, "Role") or [{"rules": []}])[0]["rules"]
    sec = [r for r in rules if "secrets" in r["resources"]]
    check(len(sec) == 1 and sorted(sec[0]["verbs"]) == ["create", "patch", "update"], f"{party}: secrets verbs exactly create,update,patch")
    check(all("*" not in r["resources"] and "*" not in r["verbs"] and "*" not in r["apiGroups"] for r in rules), f"{party}: no wildcards")
    res = {x for r in rules for x in r["resources"]}
    for need in ["statefulsets", "deployments", "jobs", "cronjobs", "services", "configmaps", "persistentvolumeclaims", "networkpolicies", "pods", "pods/log", "secrets"]:
        check(need in res, f"{party}: party-admin lacks resource {need}")
    for forbidden in ["roles", "rolebindings", "serviceaccounts", "namespaces", "pods/portforward"]:
        check(forbidden not in res, f"{party}: party-admin must not grant {forbidden}")
    # S7: no session ever execs into a key holder: party-admin (SA, 1 h automation tokens) has no exec/attach/portforward at all; exec belongs to the operator's own User/Group (vault/render.sh operator-exec)
    check(not res & {"pods/exec", "pods/attach", "pods/portforward", "pods/*", "*"}, f"{party}: party-admin must have NO pods/exec, pods/attach, pods/portforward (or wildcard): {sorted(res)}")

check([d["metadata"]["name"] for d in of(docs("all"), "Namespace")] == list(PARTIES.values()), "all: 3 namespaces in order bi, bank-a, bank-b")
for args in (["bank-c"], ["probe", "bank-a", "bank-b"], []):
    check(run(*args).returncode != 0, f"render.sh {' '.join(args)} must be refused (bank-c is cluster 2, no probe here, no argument)")

with tempfile.TemporaryDirectory() as td:
    d = os.path.join(td, "out")
    run("-o", d, "all")
    want = ["rd-stealth-bank-a.yaml", "rd-stealth-bank-b.yaml", "rd-stealth-bi.yaml"]
    check(os.path.isdir(d) and sorted(os.listdir(d)) == want, f"-o must write {want}")

# ---- cluster 2 (L0-SG): bank-c only, behind --cluster 2 ----
c2 = docs("--cluster", "2", "bank-c")
check(bool(c2), "cluster 2: no objects rendered")
if c2:
    check([n["metadata"]["name"] for n in of(c2, "Namespace")] == ["rd-stealth-bank-c"], "cluster 2: Namespace must be exactly rd-stealth-bank-c")
    lab = (of(c2, "Namespace") or [{"metadata": {}}])[0]["metadata"].get("labels", {})
    check(lab.get("part-of") == "rd-stealth" and lab.get("party") == "bank-c" and lab.get("cluster") == "2", f"cluster 2: ns labels part-of=rd-stealth, party=bank-c, cluster=2: {lab}")
    for d in c2:
        check(d["metadata"].get("labels", {}).get("cluster") == "2", f"cluster 2: {d['kind']}/{d['metadata']['name']} must carry label cluster=2")
        if d["kind"] != "Namespace":
            check(d["metadata"].get("namespace") == "rd-stealth-bank-c", f"cluster 2: {d['kind']}/{d['metadata']['name']} not in rd-stealth-bank-c")
    check({d["metadata"]["name"] for d in of(c2, "NetworkPolicy")} == NETPOLS, "cluster 2: the same 3 NetworkPolicies")
    check({d["metadata"]["name"] for d in of(c2, "ServiceAccount")} == {"party-admin"} and {d["metadata"]["name"] for d in of(c2, "Role")} == {"party-admin"} and len(of(c2, "RoleBinding")) == 1, "cluster 2: only party-admin SA/Role/RoleBinding")
    check(not of(c2, "ClusterRole") and not of(c2, "ClusterRoleBinding"), "cluster 2: no cluster-scoped RBAC")
    ref = {d["metadata"]["name"]: d for d in of(docs("bank-a"), "Role")}["party-admin"]["rules"]
    check({d["metadata"]["name"]: d for d in of(c2, "Role")}.get("party-admin", {}).get("rules") == ref, "cluster 2: party-admin rules equal the cluster-1 rules")
    ref_np = {d["metadata"]["name"]: d for d in of(docs("bank-a"), "NetworkPolicy")}
    np2 = {d["metadata"]["name"]: d for d in of(c2, "NetworkPolicy")}
    check(all(np2.get(n, {}).get("spec") == ref_np[n]["spec"] for n in NETPOLS), "cluster 2: policy specs equal the cluster-1 specs")
nso = docs("--cluster", "2", "--ns-only", "bank-c")
check([d["kind"] for d in nso] == ["Namespace"] and nso[0]["metadata"]["name"] == "rd-stealth-bank-c" and nso[0]["metadata"]["labels"].get("cluster") == "2", f"cluster 2 --ns-only: exactly the Namespace doc with cluster=2: {[d['kind'] for d in nso]}")
for args in (["bank-c"], ["--cluster", "2", "bi"], ["--cluster", "2", "bank-a"], ["--cluster", "2", "all"], ["--cluster", "1", "bank-c"], ["--cluster", "3", "bank-c"], ["--cluster", "2"], ["--ns-only", "bi"], ["--cluster", "2", "probe", "bank-c"]):
    check(run(*args).returncode != 0, f"render.sh {' '.join(args)} must be refused (bank-c needs --cluster 2 and only bank-c is allowed with it; no probe: no Paladin node)")
check("bank-c" not in run("all").stdout, "cluster 1 `all` must not contain bank-c")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK all stealth S1 assertions hold")
