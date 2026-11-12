#!/usr/bin/env python3
"""Offline check of the zeto narrow-egress renders (R17-zeto-other, SELECTOR FORM): zeto/k8s/egress/render.sh.
Usage: check.py <render.sh>. Exit 0 = all assertions hold; 1 = failures on stderr ([T2] = workload policies/probes/refusals, [T3] = baseline edit + union). Needs PyYAML; no cluster.
Form rule (orchestrator 2026-11-12, probe proof on this CNI: ipBlock <same-cluster address>/32 = CLOSED): same-cluster peers by exact namespaceSelector + podSelector,
ipBlock /32 ONLY for the other cluster (and the kube API endpoints), DNS by the kube-dns selector, NO wildcard namespaceSelector, NO podSelector {}."""
import json, os, re, subprocess, sys, tempfile, yaml

render = os.path.abspath(sys.argv[1])
K8S = os.path.dirname(os.path.dirname(render))
IMG = "registry.example/img@sha256:" + "0" * 64
BUSY = "docker.io/library/busybox:1.36@sha256:" + "a" * 64
KUBE = ["198.51.100.11", "198.51.100.12"]          # kube API endpoint IPs (documentation addresses; the real ones are quoted at apply time)
LB_C = ["203.0.113.30"]                             # bank-c besu-p2p LB (what a cluster-1 validator dials)
LB_1 = ["203.0.113.31", "203.0.113.32", "203.0.113.33"]  # the three cluster-1 besu-p2p LBs (what bank-c dials)
fails, tmp = [], tempfile.mkdtemp()
PARTIES = ["bi", "bank-a", "bank-b", "bank-c"]
N = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}
C1 = ["bi", "bank-a", "bank-b"]


def check(ok, msg, tag="T2"):
    if not ok:
        fails.append(f"[{tag}] {msg}")


def run(exe, *a):
    try:
        return subprocess.run([exe, *a], capture_output=True, text=True)
    except FileNotFoundError as e:
        return subprocess.CompletedProcess(a, 127, "", str(e))


def docs(exe, *a):
    r = run(exe, *a)
    if r.returncode != 0:
        fails.append(f"[T2] {os.path.relpath(exe, K8S)} {' '.join(a)[:100]} exited {r.returncode}: {r.stderr.strip()[:160]}")
        return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]


sn = os.path.join(tmp, "sn.json")
json.dump(["enode://" + "a" * 128 + "@203.0.113.1:30303?discport=0"], open(sn, "w"))


def sel(s, lab):
    if s is None:
        return True
    if any(lab.get(k) != v for k, v in s.get("matchLabels", {}).items()):
        return False
    for e in s.get("matchExpressions", []):
        k, op, vals = e["key"], e["operator"], e.get("values", [])
        has = k in lab
        if (op == "In" and not (has and lab[k] in vals)) or (op == "NotIn" and has and lab[k] in vals) or (op == "Exists" and not has) or (op == "DoesNotExist" and has):
            return False
    return True


def union(pols, lab):
    return [p["metadata"]["name"] for p in pols if "Egress" in p["spec"].get("policyTypes", []) and sel(p["spec"].get("podSelector"), lab)]


def tpl(d):
    return d["spec"]["template"]


# ---- the workloads: real pod templates / controller selectors from the existing renders
def party_args(p, *a):
    return ["--cluster", "2", *a] if p == "bank-c" else list(a)


def workload_docs(w, p):
    if w == "bank-gw":
        return docs(f"{K8S}/gateway/render.sh", p)
    if w == "bundle-server":
        return docs(f"{K8S}/bundle-server/render.sh", p, "--sink-image", IMG, *(["--storage-class", "sc"] if p == "bank-c" else []))
    if w == "besu-validator":
        return docs(f"{K8S}/besu/render.sh", "node", p, "--p2p-host", "203.0.113.1", "--static-nodes", sn)
    if w == "paladin-pg":
        return docs(f"{K8S}/postgres/render.sh", *(["--cluster", "2", "bank-c"] if p == "bank-c" else [p]))
    return docs(f"{K8S}/paladin/render.sh", p)


WORKLOADS = ["bank-gw", "bundle-server", "besu-validator", "paladin-pg", "paladin-operator"]
POD = {"bank-gw": lambda d: d["kind"] == "Deployment" and d["metadata"]["name"].startswith("bank-gw-"), "bundle-server": lambda d: d["kind"] == "Deployment",
       "besu-validator": lambda d: d["kind"] == "StatefulSet", "paladin-pg": lambda d: d["kind"] == "StatefulSet", "paladin-operator": lambda d: d["kind"] == "Deployment" and d["metadata"]["name"] == "paladin-operator"}
SELECTOR = {"bank-gw": {"app": "bank-gw"}, "bundle-server": {"app": "bundle-server"}, "besu-validator": {"app.kubernetes.io/name": "besu-validator"},
            "paladin-pg": {"app": "paladin-pg"}, "paladin-operator": {"app.kubernetes.io/name": "paladin-operator"}}

DNS = {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]}
TCP = lambda *p: [{"protocol": "TCP", "port": x} for x in p]


def peer(ns, labels):
    return {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": ns}}, "podSelector": {"matchLabels": labels}}


OLD_VALIDATORS = {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "besu"}},
                  "podSelector": {"matchExpressions": [{"key": "statefulset.kubernetes.io/pod-name", "operator": "In", "values": [f"besu-node-validator-{i}-0" for i in (1, 2, 3, 4)]}]}}


def p2p_rules(p, lbs):
    """Besu p2p 30303 to the OTHER new validators: same cluster by selector, the other cluster by LB /32."""
    r = []
    others = [k for k in C1 if k != p] if p in C1 else []
    if others:
        r.append({"to": [peer(f"rd-zeto-{k}", {"app.kubernetes.io/name": "besu-validator"}) for k in others], "ports": TCP(30303)})
    return r, [{"to": [{"ipBlock": {"cidr": f"{ip}/32"}} for ip in lbs], "ports": TCP(30303)}]


def expected(w, p, kube, lbs):
    ns = f"rd-zeto-{p}"
    if w == "bank-gw":
        return [{"to": [peer(ns, {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{N[p]}"})], "ports": TCP(8548)},
                {"to": [peer(ns, {"app.kubernetes.io/name": "besu-validator"})], "ports": TCP(8545)},
                {"to": [peer(ns, {"app": "bundle-server"})], "ports": TCP(8080, 8081)}, DNS]
    if w == "bundle-server" or w == "paladin-pg":
        return [DNS]
    if w == "paladin-operator":
        return [{"to": [{"ipBlock": {"cidr": f"{ip}/32"}} for ip in kube], "ports": TCP(6443)}, DNS]
    same, other = p2p_rules(p, lbs)
    return same + ([{"to": [OLD_VALIDATORS], "ports": TCP(30303)}] if p in C1 else []) + other + [DNS]


def extra(w, p):
    """(args, kube, lbs) the render needs for this workload/party."""
    if w == "paladin-operator":
        return [a for ip in KUBE for a in ("--kube-api-ip", ip)], KUBE, []
    if w == "besu-validator":
        lbs = LB_1 if p == "bank-c" else LB_C
        return [a for ip in lbs for a in ("--other-cluster-lb", ip)], [], lbs
    return [], [], []


CASES = [(w, p) for w in WORKLOADS for p in PARTIES]
PODS = {(w, p): [d for d in workload_docs(w, p) if POD[w](d)] for w, p in CASES}
NAME = lambda w: f"{w}-egress"
NEW = {p: docs(render, "baseline", p) for p in PARTIES}
FULL = {p: [d for d in docs(f"{K8S}/render.sh", *party_args(p, p)) if d["kind"] == "NetworkPolicy"] for p in PARTIES}
OLD_SEL = {"matchExpressions": [{"key": "app", "operator": "NotIn", "values": ["paladin"]}, {"key": "rd/egress-locked", "operator": "DoesNotExist"}]}
OLD = {p: {"kind": "NetworkPolicy", "metadata": {"name": "allow-dns-egress", "namespace": f"rd-zeto-{p}"}, "spec": {"podSelector": OLD_SEL, "policyTypes": ["Egress"], "egress": [{}]}} for p in PARTIES}

# ---- T2: one narrow policy per workload
POLS = {}
for w, p in CASES:
    tag, ns = f"{w}/{p}", f"rd-zeto-{p}"
    args, kube, lbs = extra(w, p)
    ds = docs(render, "workload", w, p, *args)
    check(len(ds) == 1 and ds[0]["kind"] == "NetworkPolicy", f"{tag}: exactly ONE NetworkPolicy")
    if len(ds) != 1:
        continue
    pol = POLS[(w, p)] = ds[0]
    check(pol["metadata"]["name"] == NAME(w) and pol["metadata"]["namespace"] == ns, f"{tag}: name {NAME(w)} in {ns}")
    lab = pol["metadata"].get("labels", {})
    check(lab.get("part-of") == "rd-zeto" and lab.get("party") == p and (lab.get("cluster") == "2") == (p == "bank-c"), f"{tag}: labels part-of=rd-zeto, party={p}, cluster=2 only for bank-c: {lab}")
    sp = pol["spec"]
    check(sp["podSelector"] == {"matchLabels": SELECTOR[w]} and sp["policyTypes"] == ["Egress"] and "ingress" not in sp, f"{tag}: selects {SELECTOR[w]} by matchLabels only, Egress only: {sp['podSelector']}")
    want = expected(w, p, kube, lbs)
    check(sp["egress"] == want, f"{tag}: egress rules are exactly the expected list\n   got  {sp['egress']}\n   want {want}")
    for r in sp["egress"]:
        check(bool(r.get("ports")) and bool(r.get("to")), f"{tag}: every rule has a destination and ports (no allow-all)")
        for t in r["to"]:
            if "ipBlock" in t:
                check(set(t) == {"ipBlock"} and re.fullmatch(r"[0-9.]+/32", t["ipBlock"]["cidr"]) is not None and "except" not in t["ipBlock"], f"{tag}: ipBlock only as a bare /32: {t}")
                check(w in ("paladin-operator", "besu-validator") and r["ports"] in (TCP(6443), TCP(30303)), f"{tag}: ipBlock only for the kube API endpoints / the OTHER cluster's besu-p2p LB: {t}")
            else:
                ps, nss = t.get("podSelector"), t.get("namespaceSelector")
                check(ps is not None and ps != {} and bool(ps.get("matchLabels") or ps.get("matchExpressions")), f"{tag}: no podSelector {{}} / unnamed pods: {t}")
                check(nss is not None and set(nss) == {"matchLabels"} and list(nss["matchLabels"]) == ["kubernetes.io/metadata.name"], f"{tag}: every pod peer carries an exact namespaceSelector (never wildcard/expressions): {t}")
                if nss and nss["matchLabels"].get("kubernetes.io/metadata.name") not in ("kube-system", "besu"):
                    check(nss["matchLabels"]["kubernetes.io/metadata.name"] in {ns} | {f"rd-zeto-{k}" for k in C1}, f"{tag}: peer namespace is the own or a cluster-1 zeto namespace: {t}")
    # same-cluster peers never by ipBlock (this CNI closes same-cluster /32)
    if w == "besu-validator" and p in C1:
        check(sum("ipBlock" in t for r in sp["egress"] for t in r["to"]) == 1, f"{tag}: exactly ONE ipBlock (bank-c's LB), same-cluster peers by selector")
    if w == "bank-gw":
        check(not any("ipBlock" in t for r in sp["egress"] for t in r["to"]), f"{tag}: bank-gw talks to its own namespace only: no ipBlock")

# ---- T2: the policy selects the real pod labels (and only identity-level pods)
for w, p in CASES:
    tag = f"{w}/{p}"
    pods = PODS[(w, p)]
    check(len(pods) == 1, f"{tag}: the workload render has exactly one pod controller (got {len(pods)})")
    if (w, p) not in POLS or len(pods) != 1:
        continue
    lab = tpl(pods[0])["metadata"]["labels"]
    check(sel(POLS[(w, p)]["spec"]["podSelector"], lab), f"{tag}: the policy selects the live pod labels {lab}")
    others = [x for x in WORKLOADS if x != w]
    for o in others:
        olab = tpl(PODS[(o, p)][0])["metadata"]["labels"] if len(PODS[(o, p)]) == 1 else {}
        check(not sel(POLS[(w, p)]["spec"]["podSelector"], olab), f"{tag}: the policy must NOT select the {o} pod ({olab})")
    check(not sel(POLS[(w, p)]["spec"]["podSelector"], {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{N[p]}"}), f"{tag}: the policy must NOT select a Paladin node pod")

# ---- T3: the baseline edit and the union (policies are additive)
for p in PARTIES:
    ns = f"rd-zeto-{p}"
    b = NEW[p]
    check(len(b) == 1 and b[0]["metadata"]["name"] == "allow-dns-egress" and b[0]["metadata"]["namespace"] == ns, f"{p}: baseline prints exactly allow-dns-egress of {ns}", "T3")
    if len(b) != 1:
        continue
    sp = b[0]["spec"]
    want = [{"key": "app", "operator": "NotIn", "values": ["paladin", "bank-gw", "bundle-server", "paladin-pg"]},
            {"key": "app.kubernetes.io/name", "operator": "NotIn", "values": ["besu-validator", "paladin-operator"]}, {"key": "rd/egress-locked", "operator": "DoesNotExist"}]
    check(sp["podSelector"] == {"matchExpressions": want} and sp["policyTypes"] == ["Egress"] and sp["egress"] == [{}], f"{p}: baseline = {want}, egress stays [{{}}]: {sp}", "T3")
    inparty = [d for d in FULL[p] if d["metadata"]["name"] == "allow-dns-egress"]
    check(inparty == b, f"{p}: `baseline` prints byte-for-byte the object zeto/k8s/render.sh renders", "T3")
    narrow = [POLS[(w, p)] for w in WORKLOADS if (w, p) in POLS]
    for w in WORKLOADS:
        if (w, p) not in POLS or len(PODS[(w, p)]) != 1:
            continue
        lab = tpl(PODS[(w, p)][0])["metadata"]["labels"]
        check(union([OLD[p]] + narrow, lab) == ["allow-dns-egress", NAME(w)], f"{w}/{p}: union BEFORE the baseline edit (inert stage) = [allow-dns-egress, {NAME(w)}]: {union([OLD[p]] + narrow, lab)}", "T3")
        check(union(b + narrow, lab) == [NAME(w)], f"{w}/{p}: union AFTER the baseline edit = [{NAME(w)}] only: {union(b + narrow, lab)}", "T3")
    # Paladin node pods: never touched by the new policies, still under paladin-egress / the rehearsal policy, never under allow-dns-egress
    pal = {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{N[p]}"}
    pe = {"kind": "NetworkPolicy", "metadata": {"name": "paladin-egress"}, "spec": {"podSelector": {"matchLabels": {"app": "paladin"}}, "policyTypes": ["Egress"], "egress": [{"ports": [{"port": 9000}]}]}}
    keep = [d for d in FULL[p] if d["metadata"]["name"] != "allow-dns-egress"]
    check(union(b + narrow + keep + [pe], pal) == union([OLD[p]] + narrow + keep + [pe], pal) and "allow-dns-egress" not in union(b + narrow + keep + [pe], pal) and "paladin-egress" in union(b + narrow + keep + [pe], pal),
          f"{p}: Paladin node pods stay on paladin-egress (+ the rehearsal policy while it exists), unchanged by the edit and by the new policies: {union(b + narrow + keep + [pe], pal)}", "T3")
    check(not any(x in union(b + narrow, pal) for x in map(NAME, WORKLOADS)), f"{p}: no narrow policy selects a Paladin node pod", "T3")
    # other kinds of pods are unaffected by the edit and by the narrow policies
    for lab in ({"app": "probe-control", "throwaway": "zeto-s1-probe"}, {"app": "s9-placement", "throwaway": "zeto-s9-placement"}, {"part-of": "rd-zeto", "party": p, "app.kubernetes.io/name": "besu-nodeinfo"},
                {"rd/egress-locked": "true", "app": "node-probe"}, {"rd/egress-locked": "true", "job": "pg-pw-rotate"}, {"app": "pull-test-paladin"}, {"app": "lensa-publisher"}):
        check(union(b + narrow, lab) == union([OLD[p]] + narrow, lab) == ([] if "rd/egress-locked" in lab else ["allow-dns-egress"]), f"{p}: pod {lab} keeps exactly its old egress ({union(b + narrow, lab)})", "T3")

# ---- T2: the negative probe
# Controllers that could adopt the probe, listed from the renders: a Deployment never claims pods itself, its ReplicaSets select <selector> + pod-template-hash (a label only the
# controller sets); a StatefulSet only claims pods named <sts>-<ordinal>; a Service selecting the probe is harmless only while the probe is never Ready (readinessProbe exec false).
def controllers(p):
    out = []
    for w in WORKLOADS + ["besu-net"]:
        for d in (docs(f"{K8S}/besu/render.sh", "net", p) if w == "besu-net" else workload_docs(w, p)):
            if d["kind"] in ("Deployment", "StatefulSet"):
                out.append((d["kind"], d["metadata"]["name"], d["spec"]["selector"]["matchLabels"]))
            if d["kind"] == "Service":
                out.append(("Service", d["metadata"]["name"], d["spec"].get("selector", {})))
    return out


def adopters(lab, name, ctl):
    hit = []
    for kind, cname, s in ctl:
        if not s or any(lab.get(k) != v for k, v in s.items()):
            continue
        if kind == "Deployment":
            if lab.get("pod-template-hash") is not None:
                hit.append(f"ReplicaSet of {cname}")
        elif kind == "StatefulSet":
            if re.fullmatch(re.escape(cname) + r"-[0-9]+", name):
                hit.append(f"StatefulSet {cname}")
        else:
            hit.append(f"Service {cname}")
    return hit


for w, p in CASES:
    tag, ns = f"probe {w}/{p}", f"rd-zeto-{p}"
    ds = docs(render, "probe", w, p, "--image", BUSY, "--target", "1.1.1.1:443", "--target", "198.51.100.77:6443", "--control", "kube-dns.kube-system.svc.cluster.local:53")
    check(len(ds) == 1 and ds[0]["kind"] == "Pod", f"{tag}: ONE Pod (the policy under test is {NAME(w)}, not ours)")
    if len(ds) != 1:
        continue
    pod = ds[0]; sp = pod["spec"]; c = sp["containers"][0]; lab = pod["metadata"]["labels"]
    check(pod["metadata"]["name"] == "egress-negative-probe" and pod["metadata"]["namespace"] == ns, f"{tag}: name/namespace")
    want_lab = {**SELECTOR[w], "rd/egress-locked": "true", "probe": "egress-negative", "part-of": "rd-zeto", "party": p}
    if w == "bank-gw":
        want_lab["node"] = "egress-probe"  # the live Service/ReplicaSet selector is app+node=nodeN: the probe must not match it
    if p == "bank-c":
        want_lab["cluster"] = "2"
    check(lab == want_lab, f"{tag}: labels exactly {want_lab}: {lab}")
    if (w, p) in POLS:
        check(sel(POLS[(w, p)]["spec"]["podSelector"], lab), f"{tag}: the policy under test selects the probe")
        check(union([OLD[p], *[POLS[(x, p)] for x in WORKLOADS if (x, p) in POLS]], lab) == [NAME(w)], f"{tag}: the probe is selected by {NAME(w)} ONLY even while the OLD baseline exists (rd/egress-locked keeps allow-dns-egress off it)", "T3")
        check(union(NEW[p] + [POLS[(x, p)] for x in WORKLOADS if (x, p) in POLS], lab) == [NAME(w)], f"{tag}: the probe is selected by {NAME(w)} ONLY after the baseline edit", "T3")
    hit = adopters(lab, "egress-negative-probe", controllers(p))
    allowed = {"bank-gw": [], "bundle-server": ["Service bundle-server"], "besu-validator": ["Service besu-p2p", "Service besu-validator", "Service besu-rpc"], "paladin-pg": ["Service paladin-pg"], "paladin-operator": []}[w]
    check(sorted(hit) == sorted(allowed), f"{tag}: no StatefulSet/ReplicaSet claims the probe; Services matching it = {sorted(allowed)} (harmless: never Ready), got {sorted(hit)}")
    check(c.get("readinessProbe", {}).get("exec", {}).get("command") == ["false"], f"{tag}: readinessProbe exec false (never Ready => never an endpoint)")
    check(sp.get("automountServiceAccountToken") is False and "volumes" not in sp and "env" not in c and "envFrom" not in c and "serviceAccountName" not in sp, f"{tag}: no token, no Secret, no env, no volume")
    check(c["image"] == BUSY and sp["securityContext"].get("runAsNonRoot") is True and c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{tag}: digest image, hardened")
    check(sp["restartPolicy"] == "Never" and sp.get("activeDeadlineSeconds", 999) <= 60, f"{tag}: Never + deadline <= 60 s")
    cmd = c["command"][2]
    check(cmd.count("nc -w 3") == 3 and "1.1.1.1 443" in cmd and "198.51.100.77 6443" in cmd and "kube-dns.kube-system.svc.cluster.local 53" in cmd, f"{tag}: nc to the 2 targets and the control only: {cmd}")
    for ncbody, out in (('[ "$3" = kube-dns.kube-system.svc.cluster.local ] && exit 0; exit 1', ["T1", "BLOCKED", "T2", "BLOCKED", "CONTROL", "OPEN"]), ("exit 0", ["T1", "OPEN", "T2", "OPEN", "CONTROL", "OPEN"]), ("exit 1", ["T1", "BLOCKED", "T2", "BLOCKED", "CONTROL", "BLOCKED"])):
        d = tempfile.mkdtemp(); ncp = os.path.join(d, "nc"); open(ncp, "w").write(f"#!/bin/sh\n{ncbody}\n"); os.chmod(ncp, 0o755)
        r = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
        check(r.stdout.split() == out, f"{tag}: behaviour {ncbody!r} -> {out}: {r.stdout!r}")
# the adoption model must be able to fail: a probe carrying the full selector of a ReplicaSet, or named like a StatefulSet pod, IS claimed
ctl = controllers("bi")
check(adopters({**SELECTOR["bundle-server"], "pod-template-hash": "x"}, "egress-negative-probe", ctl) == ["ReplicaSet of bundle-server", "Service bundle-server"], "adoption model: a pod-template-hash probe would be claimed by the ReplicaSet")
check("StatefulSet besu-validator" in adopters(SELECTOR["besu-validator"], "besu-validator-1", ctl), "adoption model: a pod named besu-validator-1 would be claimed by the StatefulSet")

# ---- T2: refusals (exit 2)
OK_IMG = ["--image", BUSY, "--target", "1.1.1.1:443", "--control", "kube-dns.kube-system.svc.cluster.local:53"]
K = ["--kube-api-ip", KUBE[0], "--kube-api-ip", KUBE[1]]
BAD = [[], ["workload"], ["workload", "bank-gw"], ["workload", "bank-gw", "bank-d"], ["workload", "scanner", "bi"], ["workload", "vault", "bi"], ["workload", "paladin", "bi"], ["workload", "bank-gw", "bi", "--extra"],
       ["workload", "bank-gw", "bi", "--kube-api-ip", KUBE[0]], ["workload", "bank-gw", "bi", "--other-cluster-lb", LB_C[0]], ["workload", "bundle-server", "bi", "--kube-api-ip", KUBE[0]], ["workload", "paladin-pg", "bi", "--other-cluster-lb", LB_C[0]],
       ["workload", "paladin-operator", "bi"], ["workload", "paladin-operator", "bi", "--kube-api-ip", "300.1.1.1"], ["workload", "paladin-operator", "bi", "--kube-api-ip", "10.0.0.0/24"], ["workload", "paladin-operator", "bi", "--kube-api-ip", KUBE[0], "--kube-api-ip", KUBE[0]],
       ["workload", "paladin-operator", "bi", *K, "--other-cluster-lb", LB_C[0]],
       ["workload", "besu-validator", "bi"], ["workload", "besu-validator", "bi", "--other-cluster-lb", "300.1.1.1"], ["workload", "besu-validator", "bi", "--other-cluster-lb", LB_C[0], "--other-cluster-lb", LB_C[0]],
       ["workload", "besu-validator", "bi", "--other-cluster-lb", LB_1[0], "--other-cluster-lb", LB_1[1], "--other-cluster-lb", LB_1[2]], ["workload", "besu-validator", "bank-c", "--other-cluster-lb", LB_C[0]],
       ["workload", "besu-validator", "bank-c", *[a for ip in LB_1[:2] for a in ("--other-cluster-lb", ip)]], ["workload", "besu-validator", "bi", *K],
       ["probe", "bank-gw", "bi", "--target", "1.1.1.1:443", "--control", "kube-dns.kube-system.svc.cluster.local:53"], ["probe", "bank-gw", "bi", "--image", "busybox:1.36", "--target", "1.1.1.1:443", "--control", "x:53"],
       ["probe", "bank-gw", "bi", "--image", BUSY, "--control", "x:53"], ["probe", "bank-gw", "bi", "--image", BUSY, "--target", "1.1.1.1:443"], ["probe", "bank-gw", "bi", "--image", BUSY, "--target", "1.1.1.1", "--control", "x:53"],
       ["probe", "bank-gw", "bi", "--image", BUSY, "--target", "1.1.1.1:443;id", "--control", "x:53"], ["probe", "bank-gw", "bi", "--image", BUSY, "--target", "host:443", "--control", "x:53"],
       ["probe", "bank-gw", "bi", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "x:53;id"], ["probe", "scanner", "bi", *OK_IMG], ["probe", "bank-gw", "bank-d", *OK_IMG], ["probe", "bank-gw", "bi", *OK_IMG, "--extra"],
       ["baseline"], ["baseline", "bank-d"], ["baseline", "bi", "bank-a"], ["baseline", "bi", "--extra"]]
for a in BAD:
    check(run(render, *a).returncode == 2, f"render.sh {' '.join(a)} must be refused with exit 2")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"OK zeto egress: {len(POLS)} policies + {len(CASES)} probes + {len(PARTIES)} baselines + {len(BAD)} refusals checked")
