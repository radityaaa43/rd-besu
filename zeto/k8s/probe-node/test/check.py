#!/usr/bin/env python3
"""Offline check of the (iv) node-read probe pod (zeto/k8s/probe-node/render.sh). Usage: check.py <render.sh>. Needs PyYAML only; no cluster."""
import re, subprocess, sys, yaml
render = sys.argv[1]
IMG = "docker.io/library/busybox:1.36@sha256:" + "a" * 64
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
def run(*a): return subprocess.run([render, *a], capture_output=True, text=True)
def docs(*a):
    r = run(*a)
    if r.returncode: fails.append(f"render.sh {' '.join(a)} exited {r.returncode}: {r.stderr.strip()[:150]}"); return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]
NUM = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}
for party, n in NUM.items():
    ns = f"rd-zeto-{party}"
    ds = docs(party, "--image", IMG)
    check([d["kind"] for d in ds] == ["Pod", "NetworkPolicy", "NetworkPolicy"], f"{party}: kinds Pod + 2 NetworkPolicy: {[d['kind'] for d in ds]}")
    if len(ds) != 3: continue
    pod, egress, ingress = ds
    check(all(d["metadata"]["namespace"] == ns for d in ds), f"{party}: every object in {ns}")
    lab = pod["metadata"]["labels"]
    check(lab.get("rd/egress-locked") == "true" and lab.get("app") == "node-probe" and lab.get("app") != "paladin", f"{party}: labelled rd/egress-locked=true, app=node-probe, never app=paladin: {lab}")
    sp = pod["spec"]; c = sp["containers"][0]
    check(len(sp["containers"]) == 1 and c["image"] == IMG, f"{party}: one container, the digest image")
    check(sp.get("automountServiceAccountToken") is False and "serviceAccountName" not in sp, f"{party}: no service account token")
    check("volumes" not in sp and "volumeMounts" not in c and "env" not in c and "envFrom" not in c, f"{party}: no volume, no env, no Secret")
    check(sp["restartPolicy"] == "Never" and sp.get("activeDeadlineSeconds", 999) <= 120, f"{party}: Never + a short deadline")
    check(sp["securityContext"].get("runAsNonRoot") is True and c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{party}: hardened")
    cmd = " ".join(c["command"]) + " " + " ".join(c.get("args", []))
    check(f"http://paladin-node{n}:8548" in cmd and cmd.count("http://") == 1, f"{party}: calls only http://paladin-node{n}:8548 (own ns Service)")
    check("ptx_queryPendingTransactions" in cmd, f"{party}: default method = the pending read")
    check(('echo 0' in cmd and 'NONZERO' in cmd) and "cat " not in cmd and "echo $R" not in cmd and 'echo "$R"' not in cmd and "set -x" not in cmd, f"{party}: prints ONLY 0 / NONZERO / ERROR, never the response body")
    es = egress["spec"]
    check(es["podSelector"]["matchLabels"] == {"rd/egress-locked": "true", "app": "node-probe"} and es["policyTypes"] == ["Egress", "Ingress"] and "ingress" not in es, f"{party}: probe policy selects the probe, Egress+Ingress (ingress none)")
    rules = es["egress"]
    check(len(rules) == 2 and rules[0]["to"] == [{"podSelector": {"matchLabels": {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"}}}] and rules[0]["ports"] == [{"protocol": "TCP", "port": 8548}], f"{party}: egress rule 1 = paladin-node{n}:8548 in the own ns only")
    check(rules[1]["to"] == [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}] and rules[1]["ports"] == [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}], f"{party}: egress rule 2 = kube-dns 53 (a name is used)")
    ing = ingress["spec"]
    check(ing["podSelector"]["matchLabels"] == {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"} and ing["policyTypes"] == ["Ingress"] and ing["ingress"] == [{"from": [{"podSelector": {"matchLabels": {"rd/egress-locked": "true", "app": "node-probe"}}}], "ports": [{"protocol": "TCP", "port": 8548}]}], f"{party}: extra ingress to the node's 8548 from the probe pod ONLY (paladin-ingress admits bank-gw only)")
    # jq mode + parameters
    j = docs(party, "--image", IMG, "--mode", "jq", "--method", "ptx_queryTransactions", "--params", '[{"limit":5}]')
    if j:
        jc = " ".join(j[0]["spec"]["containers"][0]["command"])
        check("jq" in jc and "length" in jc and "ptx_queryTransactions" in jc and '{"limit":5}' in jc, f"{party}: jq mode prints jq length of the chosen method/params")
# Behaviour: run the container command with a fake wget: [] -> 0, a non-empty result -> NONZERO, a failing call -> ERROR; the response body is never printed.
import os, stat, tempfile
d = tempfile.mkdtemp()
def fake_wget(body, rc=0):
    p = os.path.join(d, "wget"); open(p, "w").write(f"#!/bin/sh\n[ {rc} = 0 ] || exit 1\nprintf '%s' '{body}'\n"); os.chmod(p, 0o755)
cmd = docs("bank-a", "--image", IMG)[0]["spec"]["containers"][0]["command"]
def out(body, rc=0):
    fake_wget(body, rc)
    r = subprocess.run(cmd[:2] + [cmd[2]], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
    return r.stdout.strip(), r.stderr.strip()
check(out('{"jsonrpc":"2.0","id":1,"result":[]}') == ("0", ""), "behaviour: an empty result prints 0")
o = out('{"jsonrpc":"2.0","id":1,"result":[{"id":"SECRET-TX-1"}]}'); check(o == ("NONZERO", ""), f"behaviour: a non-empty result prints NONZERO and never the body: {o}")
o = out("", rc=1); check(o == ("ERROR", ""), f"behaviour: a failing call prints ERROR: {o}")

# ---- negative egress probe: a throwaway pod labelled app=paladin (so paladin-egress selects it) that must NOT reach the targets; a positive control proves the probe works.
for party in NUM:
    ns = f"rd-zeto-{party}"
    ds = docs(party, "negative", "--image", IMG, "--target", "1.1.1.1:443", "--target", "172.24.18.52:8548")
    check(len(ds) == 1 and ds[0]["kind"] == "Pod", f"{party}: negative = ONE Pod (the policy under test is paladin-egress, not ours)")
    if len(ds) != 1: continue
    p = ds[0]; sp = p["spec"]; c = sp["containers"][0]; lab = p["metadata"]["labels"]
    check(p["metadata"]["name"] == "egress-negative-probe" and p["metadata"]["namespace"] == ns, f"{party}: name/namespace")
    check(lab.get("app") == "paladin" and "rd/egress-locked" not in lab and lab.get("probe") == "egress-negative", f"{party}: labelled app=paladin (selected by paladin-egress), NOT rd/egress-locked: {lab}")
    check(sp.get("automountServiceAccountToken") is False and "volumes" not in sp and "env" not in c and "envFrom" not in c and "serviceAccountName" not in sp, f"{party}: no token, no Secret, no env, no volume")
    check(c["image"] == IMG and c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}} and sp["securityContext"].get("runAsNonRoot") is True, f"{party}: digest image, hardened")
    cmd = c["command"][2]
    check(cmd.count("nc -w 3") == 3 and "1.1.1.1 443" in cmd and "172.24.18.52 8548" in cmd and "paladin-pg 5432" in cmd, f"{party}: nc to the 2 targets and the paladin-pg control only: {cmd}")
    check(sp["restartPolicy"] == "Never" and sp.get("activeDeadlineSeconds", 999) <= 60, f"{party}: Never + deadline <= 60 s")
    # lead's risk (2026-11-12): the probe must NEVER become a Service endpoint (live traffic would hit it). 1) a readiness probe that never passes, 2) no known Service selector is a subset of the probe's labels.
    check(c.get("readinessProbe", {}).get("exec", {}).get("command") == ["false"], f"{party}: readinessProbe exec false (never Ready, so never an endpoint): {c.get('readinessProbe')}")
    n = NUM[party]
    paladin_sel = [{"app": "paladin", "app.kubernetes.io/instance": f"node{n}", "app.kubernetes.io/name": f"paladin-node{n}", "app.kubernetes.io/part-of": "paladin"},   # operator Service paladin-node<N> (read live 2026-11-12)
                   {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"},                                                                                           # paladin-transport (render.sh transport)
                   {"app": "bank-gw", "node": f"node{n}"}, {"app": "paladin-pg"}, {"app": "bundle-server"}, {"app.kubernetes.io/name": "besu-validator"}]
    check(not any(all(lab.get(k) == v for k, v in sel.items()) for sel in paladin_sel), f"{party}: no known Service selector selects the probe's label set {lab}")
    # behaviour: fake nc: refuses everything except paladin-pg -> BLOCKED BLOCKED CONTROL OPEN
    ncp = os.path.join(d, "nc"); open(ncp, "w").write("#!/bin/sh\n[ \"$3\" = paladin-pg ] && exit 0\nexit 1\n"); os.chmod(ncp, 0o755)
    r = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
    check(r.stdout.split() == ["T1", "BLOCKED", "T2", "BLOCKED", "CONTROL", "OPEN"], f"{party}: behaviour: prints only T1/T2 BLOCKED and CONTROL OPEN: {r.stdout!r}")
    ncp2 = os.path.join(d, "nc"); open(ncp2, "w").write("#!/bin/sh\nexit 0\n"); os.chmod(ncp2, 0o755)
    r = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
    check(r.stdout.split() == ["T1", "OPEN", "T2", "OPEN", "CONTROL", "OPEN"], f"{party}: behaviour: reachable targets print OPEN: {r.stdout!r}")
for bad in (["bi", "negative", "--image", IMG], ["bi", "negative", "--image", IMG, "--target", "1.1.1.1"], ["bi", "negative", "--image", IMG, "--target", "1.1.1.1:443;id"], ["bi", "negative", "--image", IMG, "--target", "host:443"], ["bi", "negative", "--image", "busybox:1.36", "--target", "1.1.1.1:443"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")

for bad in (["bi"], ["bi", "--image", "busybox:1.36"], ["bi", "--image", IMG, "--mode", "xx"], ["bi", "--image", IMG, "--method", "x; rm"], ["bi", "--image", IMG, "--params", "[\"'; id\"]"],
            ["bank-d", "--image", IMG], ["bi", "--image", IMG, "--extra"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print("OK node probe pod: 4 parties checked")
