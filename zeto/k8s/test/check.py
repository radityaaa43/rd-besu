#!/usr/bin/env python3
"""Offline check of the rendered zeto S1 manifests (final-design/zeto/PLAN.md S1).
Usage: check.py <render.sh>   Exit 0 = all assertions hold; 1 = list of failures on stderr.
Needs PyYAML only; no cluster."""
import subprocess, sys, yaml

render = sys.argv[1]
PARTIES = {"bi": "rd-zeto-bi", "bank-a": "rd-zeto-bank-a", "bank-b": "rd-zeto-bank-b"}
NETPOLS = {"default-deny-ingress", "allow-dns-egress", "allow-same-namespace", "rehearsal-no-9000-egress"}
SAS = {"party-admin", "lensa-publisher"}
fails = []

def check(ok, msg):
    if not ok:
        fails.append(msg)

def docs(*args):
    out = subprocess.run([render, *args], capture_output=True, text=True)
    if out.returncode != 0:
        fails.append(f"render.sh {' '.join(args)} exited {out.returncode}: {out.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(out.stdout) if d]

def of(ds, kind):
    return [d for d in ds if d["kind"] == kind]

def tcp_ranges(rule):
    return [(p.get("port"), p.get("endPort", p.get("port"))) for p in rule.get("ports", []) if p.get("protocol", "TCP") == "TCP"]

for party, ns in PARTIES.items():
    ds = docs(party)
    check(bool(ds), f"{party}: no objects rendered")
    if not ds:
        continue
    nss = of(ds, "Namespace")
    check([n["metadata"]["name"] for n in nss] == [ns], f"{party}: Namespace must be exactly {ns}")
    if nss:
        lab = nss[0]["metadata"].get("labels", {})
        check(lab.get("part-of") == "rd-zeto" and lab.get("party") == party, f"{party}: labels part-of=rd-zeto, party={party} missing: {lab}")
    check(not of(ds, "ClusterRole") and not of(ds, "ClusterRoleBinding"), f"{party}: no ClusterRole/ClusterRoleBinding allowed")
    for d in ds:
        if d["kind"] != "Namespace":
            check(d["metadata"].get("namespace") == ns, f"{party}: {d['kind']}/{d['metadata']['name']} not in {ns}")
    got_np = {d["metadata"]["name"] for d in of(ds, "NetworkPolicy")}
    check(got_np == NETPOLS, f"{party}: NetworkPolicy names {sorted(got_np)} != {sorted(NETPOLS)}")
    got_sa = {d["metadata"]["name"] for d in of(ds, "ServiceAccount")}
    want_sa = SAS if party == "bi" else {"party-admin"}
    check(got_sa == want_sa, f"{party}: ServiceAccounts {sorted(got_sa)} != {sorted(want_sa)}")
    np = {d["metadata"]["name"]: d for d in of(ds, "NetworkPolicy")}
    if NETPOLS <= set(np):
        dd = np["default-deny-ingress"]["spec"]
        check(dd.get("podSelector") == {} and dd.get("policyTypes") == ["Ingress"] and "ingress" not in dd, f"{party}: default-deny-ingress must select all pods, Ingress only, no rules")
        sn = np["allow-same-namespace"]["spec"]
        check(sn.get("policyTypes") == ["Ingress"] and sn["ingress"] == [{"from": [{"podSelector": {}}]}], f"{party}: allow-same-namespace must allow only podSelector {{}} of the same ns")
        ex = sn["podSelector"].get("matchExpressions", [])
        check(ex == [{"key": "app", "operator": "NotIn", "values": ["paladin-pg", "paladin"]}], f"{party}: allow-same-namespace must exclude app=paladin-pg and app=paladin (their own policies are the only ingress; S16 gateway/): {ex}")
        dns = np["allow-dns-egress"]["spec"]
        check(dns["policyTypes"] == ["Egress"], f"{party}: allow-dns-egress must be Egress")
        sel = dns["podSelector"].get("matchExpressions", [])
        check(any(e["key"] == "app" and e["operator"] == "NotIn" and "paladin" in e["values"] for e in sel), f"{party}: allow-dns-egress must exclude app=paladin (else it widens the rehearsal policy)")
        check({"key": "rd/egress-locked", "operator": "DoesNotExist"} in sel, f"{party}: allow-dns-egress must exclude pods labelled rd/egress-locked (a one-off Job with its own narrow policy; policies are additive, an allow-all that selects the Job cancels it)")
        rh = np["rehearsal-no-9000-egress"]["spec"]
        check(rh["podSelector"] == {"matchLabels": {"app": "paladin"}} and rh["policyTypes"] == ["Egress"], f"{party}: rehearsal policy must select app=paladin, Egress")
        tcp = [r for rule in rh["egress"] for r in tcp_ranges(rule)]
        check(sorted(tcp) == [(1, 8999), (9001, 65535)], f"{party}: rehearsal TCP ranges {tcp} != [(1,8999),(9001,65535)]")
        check(any(p.get("protocol") == "UDP" for rule in rh["egress"] for p in rule.get("ports", [])), f"{party}: rehearsal policy must allow UDP")
        check(all("to" not in rule for rule in rh["egress"]), f"{party}: rehearsal rules must not restrict destination")
    roles = {d["metadata"]["name"]: d for d in of(ds, "Role")}
    check(set(roles) == ({"party-admin", "lensa-publisher"} if party == "bi" else {"party-admin"}), f"{party}: Roles {sorted(roles)}")
    if "party-admin" in roles:
        rules = roles["party-admin"]["rules"]
        check(all("*" not in r["resources"] and "*" not in r["verbs"] and "*" not in r["apiGroups"] for r in rules), f"{party}: party-admin must not use wildcards")
        sec = [r for r in rules if "secrets" in r["resources"]]
        check(len(sec) == 1 and sorted(sec[0]["verbs"]) == ["create", "patch", "update"], f"{party}: secrets verbs must be exactly create,update,patch: {sec}")
        res = {x for r in rules for x in r["resources"]}
        for need in ["statefulsets", "deployments", "services", "configmaps", "persistentvolumeclaims", "networkpolicies", "pods", "pods/log", "secrets", "jobs"]:
            check(need in res, f"{party}: party-admin lacks resource {need}")
        for forbidden in ["roles", "rolebindings", "serviceaccounts", "namespaces", "pods/exec", "pods/portforward"]:
            check(forbidden not in res, f"{party}: party-admin must not grant {forbidden}")
    if party == "bi" and "lensa-publisher" in roles:
        rules = roles["lensa-publisher"]["rules"]
        check(len(rules) == 1 and rules[0]["resources"] == ["services/proxy"] and rules[0]["verbs"] == ["get"] and "bundle-server" in rules[0].get("resourceNames", []) and rules[0]["apiGroups"] == [""],
              f"bi: lensa-publisher must be exactly get services/proxy on bundle-server: {rules}")
    rbs = of(ds, "RoleBinding")
    want_rb = {("party-admin", "party-admin")} | ({("lensa-publisher", "lensa-publisher")} if party == "bi" else set())
    got_rb = {(r["roleRef"]["name"], r["subjects"][0]["name"]) for r in rbs if r["roleRef"]["kind"] == "Role" and r["subjects"][0]["kind"] == "ServiceAccount" and r["subjects"][0].get("namespace") == ns}
    check(got_rb == want_rb and len(rbs) == len(want_rb), f"{party}: RoleBindings {sorted(got_rb)} != {sorted(want_rb)}")

# `all` renders every party once, in order
allds = docs("all")
check([d["metadata"]["name"] for d in of(allds, "Namespace")] == list(PARTIES.values()), "all: Namespaces must be the 3 parties in order bi, bank-a, bank-b")

# unknown party must be refused
bad = subprocess.run([render, "bank-c"], capture_output=True, text=True)
check(bad.returncode != 0, "render.sh bank-c must fail (cluster 2 is out of scope)")

# probe manifest (throwaway, never applied by render.sh party/all)
pr = docs("probe", "bank-a", "bank-b")
pods = {d["metadata"]["name"]: d for d in of(pr, "Pod")}
check(any(p["metadata"].get("labels", {}).get("app") == "paladin" and p["metadata"]["namespace"] == "rd-zeto-bank-a" for p in pods.values()), "probe: a pod app=paladin in rd-zeto-bank-a is required")
check(any(p["metadata"].get("labels", {}).get("app") == "probe-control" and p["metadata"]["namespace"] == "rd-zeto-bank-a" for p in pods.values()), "probe: a control pod app=probe-control in rd-zeto-bank-a is required")
lst = [d for d in pr if d["kind"] in ("Pod", "Deployment") and d["metadata"]["namespace"] in ("rd-zeto-bank-b", "rd-zeto-bank-a") and d["metadata"].get("labels", {}).get("role") == "probe-listener"]
ports = sorted((d["metadata"]["namespace"], str(d["metadata"]["labels"].get("listen"))) for d in lst)
check(ports == [("rd-zeto-bank-a", "8549"), ("rd-zeto-bank-b", "9000")], f"probe: listeners must be 9000 in the other ns and 8549 in the own ns: {ports}")
check(any(d["kind"] == "NetworkPolicy" and d["metadata"]["namespace"] == "rd-zeto-bank-b" for d in pr), "probe: needs a throwaway ingress-allow for 9000 in the other ns")
check(all(d["metadata"].get("labels", {}).get("throwaway") == "zeto-s1-probe" for d in pr), "probe: every object must carry label throwaway=zeto-s1-probe (delete by label)")

# probe split: listeners first (so they can be waited on), then the probe pods
pl = docs("probe-listeners", "bank-a", "bank-b")
pp = docs("probe-pods", "bank-a", "bank-b")
check(sorted(d["metadata"]["name"] for d in of(pl, "Pod")) == ["probe-listener-8549", "probe-listener-9000"] and not any(d["metadata"]["name"].startswith("probe-p") or d["metadata"]["name"] == "probe-control" for d in of(pl, "Pod")), "probe-listeners: must emit only the two listener pods")
check(sorted(d["metadata"]["name"] for d in of(pp, "Pod")) == ["probe-control", "probe-paladin"] and len(pp) == 2, "probe-pods: must emit only probe-paladin and probe-control")
# result words: a refused connection is not a policy block; retry so a late listener cannot fake a proof
for d in of(pp, "Pod"):
    script = d["spec"]["containers"][0]["command"][-1]
    check("except ConnectionRefusedError" in script and '"REFUSED"' in script, f"{d['metadata']['name']}: ConnectionRefusedError must print REFUSED")
    check("except socket.timeout" in script and '"BLOCKED"' in script, f"{d['metadata']['name']}: only socket.timeout may print BLOCKED")
    check("range(3)" in script and "time.sleep(2)" in script, f"{d['metadata']['name']}: needs 3 attempts with a 2 s gap")
    check(script.index("except ConnectionRefusedError") < script.index("except OSError as e"), f"{d['metadata']['name']}: ConnectionRefusedError must be caught before the generic OSError")

# ---- cluster 2 (L0-SG): bank-c only, behind --cluster 2 ----
def run(*args):
    return subprocess.run([render, *args], capture_output=True, text=True)

c2 = docs("--cluster", "2", "bank-c")
check(bool(c2), "cluster 2: no objects rendered")
# P6 parity (2026-11-12): the live rd-zeto-bank-c Role lacked batch/jobs while the three cluster-1 Roles had it. The cluster-2 render must carry the SAME party-admin rules as a cluster-1 party.
_role = lambda ds: [d for d in ds if d["kind"] == "Role" and d["metadata"]["name"] == "party-admin"]
_rules = lambda ds: sorted((tuple(r["apiGroups"]), tuple(r["resources"]), tuple(r["verbs"])) for r in _role(ds)[0]["rules"]) if _role(ds) else None
check(_rules(c2) is not None and _rules(c2) == _rules(docs("bi")), "bank-c (cluster 2) party-admin Role rules must equal a cluster-1 party's (incl. batch jobs)")
if c2:
    check([n["metadata"]["name"] for n in of(c2, "Namespace")] == ["rd-zeto-bank-c"], "cluster 2: Namespace must be exactly rd-zeto-bank-c")
    lab = (of(c2, "Namespace") or [{"metadata": {}}])[0]["metadata"].get("labels", {})
    check(lab.get("part-of") == "rd-zeto" and lab.get("party") == "bank-c" and lab.get("cluster") == "2", f"cluster 2: ns labels part-of=rd-zeto, party=bank-c, cluster=2: {lab}")
    for d in c2:
        check(d["metadata"].get("labels", {}).get("cluster") == "2", f"cluster 2: {d['kind']}/{d['metadata']['name']} must carry label cluster=2")
        if d["kind"] != "Namespace":
            check(d["metadata"].get("namespace") == "rd-zeto-bank-c", f"cluster 2: {d['kind']}/{d['metadata']['name']} not in rd-zeto-bank-c")
    check({d["metadata"]["name"] for d in of(c2, "NetworkPolicy")} == NETPOLS, "cluster 2: the same 4 NetworkPolicies")
    check({d["metadata"]["name"] for d in of(c2, "ServiceAccount")} == {"party-admin"}, "cluster 2: only ServiceAccount party-admin (no lensa-publisher)")
    check({d["metadata"]["name"] for d in of(c2, "Role")} == {"party-admin"} and len(of(c2, "RoleBinding")) == 1, "cluster 2: only Role/RoleBinding party-admin")
    check(not of(c2, "ClusterRole") and not of(c2, "ClusterRoleBinding"), "cluster 2: no cluster-scoped RBAC")
    ref = {d["metadata"]["name"]: d for d in of(docs("bank-a"), "Role")}["party-admin"]["rules"]
    got = {d["metadata"]["name"]: d for d in of(c2, "Role")}.get("party-admin", {}).get("rules")
    check(got == ref, "cluster 2: party-admin rules must equal the cluster-1 party-admin rules")
    np2 = {d["metadata"]["name"]: d for d in of(c2, "NetworkPolicy")}
    ref_np = {d["metadata"]["name"]: d for d in of(docs("bank-a"), "NetworkPolicy")}
    check(all(np2.get(n, {}).get("spec") == ref_np[n]["spec"] for n in NETPOLS), "cluster 2: policy specs equal the cluster-1 specs")
for args in (["bank-c"], ["--cluster", "2", "bi"], ["--cluster", "2", "bank-a"], ["--cluster", "2", "all"], ["--cluster", "1", "bank-c"], ["--cluster", "3", "bank-c"], ["--cluster", "2"]):
    check(run(*args).returncode != 0, f"render.sh {' '.join(args)} must be refused")
check("bank-c" not in subprocess.run([render, "all"], capture_output=True, text=True).stdout, "cluster 1 `all` must not contain bank-c")
# probe variant for bank-c: one namespace only, listeners + control in the same namespace, no cross-namespace object, no kube-system
pc = docs("--cluster", "2", "probe", "bank-c")
txt = subprocess.run([render, "--cluster", "2", "probe", "bank-c"], capture_output=True, text=True).stdout
check(bool(pc) and {d["metadata"].get("namespace") for d in pc} == {"rd-zeto-bank-c"}, "cluster 2 probe: every object in rd-zeto-bank-c only")
check("kube-system" not in txt and "rd-zeto-bank-a" not in txt and "rd-zeto-bank-b" not in txt, "cluster 2 probe: no kube-system and no other namespace")
check(not of(pc, "NetworkPolicy"), "cluster 2 probe: no extra NetworkPolicy (allow-same-namespace already admits the listeners)")
check(sorted(d["metadata"]["name"] for d in of(pc, "Pod")) == ["probe-control", "probe-listener-8549", "probe-listener-9000", "probe-paladin"], "cluster 2 probe: 4 pods")
check(all(d["metadata"].get("labels", {}).get("throwaway") == "zeto-s1-probe" for d in pc), "cluster 2 probe: all objects labelled throwaway=zeto-s1-probe")
check(any(p["metadata"]["name"] == "probe-paladin" and p["metadata"]["labels"].get("app") == "paladin" for p in of(pc, "Pod")), "cluster 2 probe: probe-paladin has app=paladin")
for args in (["--cluster", "2", "probe", "bank-a"], ["--cluster", "2", "probe", "bank-c", "bank-a"], ["--cluster", "2", "probe-listeners", "bank-a"]):
    check(run(*args).returncode != 0, f"render.sh {' '.join(args)} must be refused")

nso = docs("--cluster", "2", "--ns-only", "bank-c")
check([d["kind"] for d in nso] == ["Namespace"] and nso[0]["metadata"]["name"] == "rd-zeto-bank-c" and nso[0]["metadata"]["labels"].get("cluster") == "2", f"cluster 2 --ns-only: exactly the Namespace doc with cluster=2: {[d['kind'] for d in nso]}")
# SIGPIPE guard (CI flake, rc 141): the renderer must not close a pipe early; 6 of 300 runs died before the fix, so loop 150 times.
check(all(run("--cluster", "2", "--ns-only", "bank-c").returncode == 0 for _ in range(150)), "cluster 2 --ns-only must succeed on every run (an early-closing reader under pipefail gives rc 141)")
for args in (["--ns-only", "bi"], ["--cluster", "2", "--ns-only", "probe", "bank-c"], ["--cluster", "2", "--ns-only"]):
    check(run(*args).returncode != 0, f"render.sh {' '.join(args)} must be refused (--ns-only is cluster 2 and namespace only)")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK all S1 assertions hold")
