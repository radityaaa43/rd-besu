#!/usr/bin/env python3
"""Offline check of the stealth narrow-egress renders (R17-stealth gate, SELECTOR FORM): stealth-address/k8s/egress/render.sh.
Usage: check.py <render.sh>. Exit 0 = all assertions hold; 1 = failures on stderr. Needs PyYAML; no cluster.
Form rule (orchestrator 2026-11-12, probe proof on this CNI: ipBlock <same-cluster LB/pod IP>/32 = CLOSED): same-cluster peers by exact namespaceSelector + podSelector,
ipBlock /32 ONLY for the other cluster, DNS by the kube-dns selector, NO wildcard namespaceSelector, NO podSelector {}."""
import base64, os, re, subprocess, sys, tempfile, yaml

render = os.path.abspath(sys.argv[1])
K8S = os.path.dirname(os.path.dirname(render))
IMG = "registry.example/rd-stealth-signer@sha256:" + "0" * 64
BUSY = "docker.io/library/busybox:1.36@sha256:" + "a" * 64
CERT_URL = "https://st-gw-1.rd-stealth-bi.svc.cluster.local:8550"
LB = "203.0.113.9"  # st-gw-1-ext (documentation address; the real one is quoted at apply time)
REG = "0x" + "6" * 40
fails, tmp = [], tempfile.mkdtemp()


def check(ok, msg):
    if not ok:
        fails.append(msg)


def run(exe, *a):
    try:
        return subprocess.run([exe, *a], capture_output=True, text=True)
    except FileNotFoundError as e:
        return subprocess.CompletedProcess(a, 127, "", str(e))


def docs(exe, *a):
    r = run(exe, *a)
    if r.returncode != 0:
        fails.append(f"{os.path.basename(os.path.dirname(exe))}/render.sh {' '.join(a)} exited {r.returncode}: {r.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]


chain = os.path.join(tmp, "chain.env")
open(chain, "w").write("".join(f"{k}={v}\n" for k, v in {"CHAIN_ID": "1337", "RD": "0x" + "1" * 40, "BOND": "0x" + "2" * 40, "ANNOUNCER": "0x" + "3" * 40, "VALIDATOR": "0x" + "4" * 40, "DVP_FACTORY": "0x" + "5" * 40, "FROM_BLOCK": "1"}.items()))
SIGNER, GATEWAY, PARTY = f"{K8S}/signer/render.sh", f"{K8S}/gateway/render.sh", f"{K8S}/render.sh"


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


def pod_labels(ds):
    out = []
    for d in ds:
        if d["kind"] == "Deployment":
            out.append(d["spec"]["template"]["metadata"]["labels"])
        if d["kind"] == "CronJob":
            out.append(d["spec"]["jobTemplate"]["spec"]["template"]["metadata"]["labels"])
        if d["kind"] == "Job":
            out.append(d["spec"]["template"]["metadata"]["labels"])
    return out


DNS = {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]}
RPC = {"to": [{"podSelector": {"matchLabels": {"app.kubernetes.io/name": "besu-rpc"}}}], "ports": [{"protocol": "TCP", "port": 8545}]}
TCP = lambda p: [{"protocol": "TCP", "port": p}]


def expected(workload, party):
    """(policy name, profile label, rules) written out by hand, independent of the renderer."""
    if workload in ("signer", "viewpush"):
        if party == "bi":
            cert = {"to": [{"podSelector": {"matchLabels": {"app": "st-gw", "node": "node1"}}}], "ports": TCP(8550)}
        elif party == "bank-c":
            cert = {"to": [{"ipBlock": {"cidr": f"{LB}/32"}}], "ports": TCP(8550)}
        else:
            cert = {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "rd-stealth-bi"}}, "podSelector": {"matchLabels": {"app": "st-gw", "node": "node1"}}}], "ports": TCP(8550)}
        if workload == "viewpush":  # S11 rework: the push Job reaches ONLY its own bank signer, the BI door and DNS (no besu-rpc, no kube API)
            own = {"to": [{"podSelector": {"matchLabels": {"app": "stealth-signer", "role": "bank"}}}], "ports": TCP(8080)}
            return "stealth-viewpush-egress", "stealth-viewpush", [own, cert, DNS]
        return "stealth-signer-egress", "stealth-signer", [RPC, cert, DNS]
    if workload == "custodian":
        return "stealth-custodian-egress", "stealth-custodian", [RPC, DNS]
    if workload == "compare":
        return "stealth-viewkey-egress", "stealth-viewkey", [RPC, DNS]
    rules = [{"to": [{"podSelector": {"matchLabels": {"app": "stealth-signer"}, "matchExpressions": [{"key": "role", "operator": "In", "values": ["bank", "bi"]}]}}], "ports": TCP(8080)}]
    if party == "bi":
        rules.append({"to": [{"podSelector": {"matchLabels": {"app": "stealth-signer", "role": "custodian"}}}], "ports": TCP(9443)})
    rules.append({"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"rd-zeto-{party}"}}, "podSelector": {"matchLabels": {"app": "bundle-server"}}}], "ports": TCP(8080)})
    return "st-gw-egress", "st-gw", rules + [DNS]


CASES = [("signer", "bi", []), ("signer", "bank-a", []), ("signer", "bank-b", []), ("signer", "bank-c", ["--cert-lb-ip", LB]), ("custodian", "bi", []), ("compare", "bi", []),
         ("gateway", "bi", []), ("gateway", "bank-a", []), ("gateway", "bank-b", []), ("gateway", "bank-c", []),
         ("viewpush", "bank-a", []), ("viewpush", "bank-b", []), ("viewpush", "bank-c", ["--cert-lb-ip", LB])]


def workload_pods(workload, party):
    """The pod label sets the real workload renders produce (the policy must select exactly these)."""
    if workload == "gateway":
        return pod_labels(docs(GATEWAY, party))
    if workload == "compare":
        return pod_labels(docs(SIGNER, "compare", "--image", IMG, "--chain-env", chain, "--registry", REG))
    if workload == "custodian":
        return pod_labels(docs(SIGNER, "custodian", "--image", IMG, "--chain-env", chain, "--bank-signers", "CN=a"))
    if workload == "viewpush":
        return pod_labels(docs(SIGNER, "viewpush", party, "--image", IMG, "--door-url", CERT_URL))
    return pod_labels(docs(SIGNER, party, "--image", IMG, "--chain-env", chain, "--cert-url", CERT_URL))


for workload, party, extra in CASES:
    tag = f"{workload}/{party}"
    ns = f"rd-stealth-{party}"
    ds = docs(render, workload, party, *extra)
    check(len(ds) == 1 and ds[0]["kind"] == "NetworkPolicy", f"{tag}: exactly ONE NetworkPolicy")
    if len(ds) != 1:
        continue
    pol = ds[0]
    name, profile, rules = expected(workload, party)
    check(pol["metadata"]["name"] == name and pol["metadata"]["namespace"] == ns, f"{tag}: name {name} in {ns}")
    lab = pol["metadata"].get("labels", {})
    check(lab.get("part-of") == "rd-stealth" and lab.get("party") == party and (lab.get("cluster") == "2") == (party == "bank-c"), f"{tag}: labels part-of=rd-stealth, party={party}, cluster=2 only for bank-c: {lab}")
    sp = pol["spec"]
    check(sp["podSelector"] == {"matchLabels": {"rd/egress": profile}} and sp["policyTypes"] == ["Egress"] and "ingress" not in sp, f"{tag}: selects rd/egress={profile} only, Egress only: {sp['podSelector']}")
    check(sp["egress"] == rules, f"{tag}: egress rules are exactly the expected list\n   got  {sp['egress']}\n   want {rules}")
    # the form rule, asserted on every destination of every rule
    for r in sp["egress"]:
        check(bool(r.get("ports")) and bool(r.get("to")), f"{tag}: every rule has a destination and ports (no allow-all)")
        for t in r["to"]:
            if "ipBlock" in t:
                check(set(t) == {"ipBlock"} and re.fullmatch(r"[0-9.]+/32", t["ipBlock"]["cidr"]) is not None and "except" not in t["ipBlock"], f"{tag}: ipBlock only as a bare /32: {t}")
                check(workload in ("signer", "viewpush") and party == "bank-c", f"{tag}: ipBlock ONLY for the other cluster (bank-c signer/viewpush -> BI cert door LB), never same-cluster: {t}")
            else:
                ps, nss = t.get("podSelector"), t.get("namespaceSelector")
                check(ps is not None and ps != {} and bool(ps.get("matchLabels")), f"{tag}: no podSelector {{}} / unnamed pods: {t}")
                check(nss is None or (set(nss) == {"matchLabels"} and list(nss["matchLabels"]) == ["kubernetes.io/metadata.name"]), f"{tag}: namespaceSelector only by exact name, never wildcard/expressions: {t}")
    # union proof (the R17-stealth gate, offline): allow-dns-egress of this ns + the new policy => the workload pods are selected by the new policy ONLY; besu-rpc stays on allow-dns-egress
    base = [d for d in docs(PARTY, "--cluster", "2", party) if d["kind"] == "NetworkPolicy"] if party == "bank-c" else [d for d in docs(PARTY, party) if d["kind"] == "NetworkPolicy"]
    pods = workload_pods(workload, party)
    check(len(pods) == 1, f"{tag}: the workload render has exactly one pod template")
    for pl in pods:
        check(union(base + [pol], pl) == [name], f"{tag}: union of ALL Egress policies selecting the pod = {[name]} (got {union(base + [pol], pl)})")
        check(pl.get("rd/egress-locked") == "true" and pl.get("rd/egress") == profile, f"{tag}: pod template carries rd/egress-locked=true, rd/egress={profile}: {pl}")
    check(union(base + [pol], {"app.kubernetes.io/name": "besu-rpc"}) == ["allow-dns-egress"], f"{tag}: the besu-rpc pod is NOT touched (stays on allow-dns-egress)")
    check(union(base + [pol], {"app.kubernetes.io/name": "vault"}) == ["allow-dns-egress"], f"{tag}: the vault pod is NOT touched")

# ---- the negative probe: a pod labelled like the workload (selected by the same policy), never Ready, never a Service endpoint
services = []
for p in ("bi", "bank-a"):
    services += [d for d in docs(GATEWAY, p) if d["kind"] == "Service"]
    services += [d for d in docs(SIGNER, p, "--image", IMG, "--chain-env", chain, "--cert-url", CERT_URL) if d["kind"] == "Service"]
services += [d for d in docs(f"{K8S}/rpc/render.sh", "net", "bi") if d["kind"] == "Service"]
for workload, party, extra in CASES:
    tag = f"probe {workload}/{party}"
    name, profile, _ = expected(workload, party)
    ds = docs(render, "probe", workload, party, "--image", BUSY, "--target", "1.1.1.1:443", "--target", "172.24.20.185:8545", "--control", "besu-rpc:8545")
    check(len(ds) == 1 and ds[0]["kind"] == "Pod", f"{tag}: ONE Pod (the policy under test is {name}, not ours)")
    if len(ds) != 1:
        continue
    p = ds[0]; sp = p["spec"]; c = sp["containers"][0]; lab = p["metadata"]["labels"]
    check(p["metadata"]["name"] == "egress-negative-probe" and p["metadata"]["namespace"] == f"rd-stealth-{party}", f"{tag}: name/namespace")
    want_lab = {"rd/egress-locked": "true", "rd/egress": profile, "app": "egress-negative-probe", "probe": "egress-negative", "part-of": "rd-stealth", "party": party}
    if party == "bank-c":
        want_lab["cluster"] = "2"
    check(lab == want_lab, f"{tag}: labels exactly {want_lab} (selected by the policy; NOT app=stealth-signer/st-gw): {lab}")
    check(not any(all(lab.get(k) == v for k, v in s["spec"]["selector"].items()) for s in services), f"{tag}: no Service of the real workloads selects the probe's labels")
    check(c.get("readinessProbe", {}).get("exec", {}).get("command") == ["false"], f"{tag}: readinessProbe exec false (never Ready => never an endpoint)")
    check(sp.get("automountServiceAccountToken") is False and "volumes" not in sp and "env" not in c and "envFrom" not in c and "serviceAccountName" not in sp, f"{tag}: no token, no Secret, no env, no volume")
    check(c["image"] == BUSY and sp["securityContext"].get("runAsNonRoot") is True and c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{tag}: digest image, hardened")
    check(sp["restartPolicy"] == "Never" and sp.get("activeDeadlineSeconds", 999) <= 60, f"{tag}: Never + deadline <= 60 s")
    cmd = c["command"][2]
    check(cmd.count("nc -w 3") == 3 and "1.1.1.1 443" in cmd and "172.24.20.185 8545" in cmd and "besu-rpc 8545" in cmd, f"{tag}: nc to the 2 targets and the control only: {cmd}")
    for ncbody, out in (('[ "$3" = besu-rpc ] && exit 0; exit 1', ["T1", "BLOCKED", "T2", "BLOCKED", "CONTROL", "OPEN"]), ("exit 0", ["T1", "OPEN", "T2", "OPEN", "CONTROL", "OPEN"]), ("exit 1", ["T1", "BLOCKED", "T2", "BLOCKED", "CONTROL", "BLOCKED"])):
        d = tempfile.mkdtemp(); ncp = os.path.join(d, "nc"); open(ncp, "w").write(f"#!/bin/sh\n{ncbody}\n"); os.chmod(ncp, 0o755)
        r = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
        check(r.stdout.split() == out, f"{tag}: behaviour {ncbody!r} -> {out}: {r.stdout!r}")

# ---- refusals (exit 2)
BAD = [[], ["signer"], ["signer", "bank-c"], ["signer", "bank-c", "--cert-lb-ip", "300.1.1.1"], ["signer", "bank-c", "--cert-lb-ip", "10.0.0.0/24"], ["signer", "bank-a", "--cert-lb-ip", LB], ["signer", "bi", "--cert-lb-ip", LB],
       ["signer", "bank-d"], ["custodian", "bank-a"], ["compare", "bank-a"], ["gateway", "bank-d"], ["gateway", "bank-a", "--cert-lb-ip", LB], ["scanner", "bi"],
       ["viewpush", "bi"], ["viewpush", "bank-c"], ["viewpush", "bank-a", "--cert-lb-ip", LB], ["viewpush", "bank-d"], ["viewpush", "bank-c", "--cert-lb-ip", "300.1.1.1"], ["probe", "viewpush", "bi", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "stealth-signer:8080"],
       ["probe", "viewpush", "bank-c", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "stealth-signer:8080", "--cert-lb-ip", LB], ["vault", "bi"], ["signer", "bank-a", "--extra"],
       ["probe", "signer", "bank-a", "--target", "1.1.1.1:443", "--control", "besu-rpc:8545"], ["probe", "signer", "bank-a", "--image", "busybox:1.36", "--target", "1.1.1.1:443", "--control", "besu-rpc:8545"],
       ["probe", "signer", "bank-a", "--image", BUSY, "--control", "besu-rpc:8545"], ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1:443"], ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1", "--control", "besu-rpc:8545"],
       ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1:443;id", "--control", "besu-rpc:8545"], ["probe", "signer", "bank-a", "--image", BUSY, "--target", "host:443", "--control", "besu-rpc:8545"],
       ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "besu-rpc:8545;id"]]
for a in BAD:
    check(run(render, *a).returncode == 2, f"render.sh {' '.join(a)} must be refused with exit 2")

# ---- S11 rework D3: signer bi --kube-api-ip (repeatable) = the kube API ENDPOINT IPs :6443 for the BI signer ONLY (it patches Secret stealth-bi-viewcopies); everything else byte-unchanged
KIP = ["203.0.113.10", "203.0.113.11"]
plain = docs(render, "signer", "bi")
withk = docs(render, "signer", "bi", "--kube-api-ip", KIP[0], "--kube-api-ip", KIP[1])
check(len(plain) == 1 and len(withk) == 1, "signer bi --kube-api-ip: exactly ONE NetworkPolicy")
if plain and withk:
    kube = {"to": [{"ipBlock": {"cidr": f"{ip}/32"}} for ip in KIP], "ports": TCP(6443)}
    check(withk[0]["spec"]["egress"] == plain[0]["spec"]["egress"][:-1] + [kube] + plain[0]["spec"]["egress"][-1:], f"signer bi --kube-api-ip: the plain rules + ONE rule ipBlock <ip>/32 per IP on TCP 6443, DNS last (got {withk[0]['spec']['egress']})")
    check({k: v for k, v in withk[0].items() if k != "spec"} == {k: v for k, v in plain[0].items() if k != "spec"} and withk[0]["spec"]["podSelector"] == plain[0]["spec"]["podSelector"] and withk[0]["spec"]["policyTypes"] == ["Egress"], "signer bi --kube-api-ip: same name, labels, selector, Egress only")
    check(all(set(t) == {"ipBlock"} and "except" not in t["ipBlock"] for t in kube["to"]) and [r for r in withk[0]["spec"]["egress"] if any("ipBlock" in t for t in r["to"])] == [kube], "signer bi --kube-api-ip: ipBlock appears only in the kube rule, as bare /32s")
    one = docs(render, "signer", "bi", "--kube-api-ip", KIP[0])
    check(one and one[0]["spec"]["egress"][-2] == {"to": [{"ipBlock": {"cidr": f"{KIP[0]}/32"}}], "ports": TCP(6443)}, "signer bi --kube-api-ip: a single IP works")
    sg = {"bi": docs(SIGNER, "bi", "--image", IMG, "--chain-env", chain, "--cert-url", CERT_URL, "--viewcopy-store")}
    base_bi = [d for d in docs(PARTY, "bi") if d["kind"] == "NetworkPolicy"]
    for pl in pod_labels(sg["bi"]):
        check(union(base_bi + withk, pl) == ["stealth-signer-egress"], f"signer bi --kube-api-ip: the BI signer pod (with --viewcopy-store) is selected by this policy ONLY: {union(base_bi + withk, pl)}")
    for other in ("stealth-custodian", "stealth-viewkey", "st-gw", "stealth-viewpush"):
        check(union(withk, {"rd/egress-locked": "true", "rd/egress": other}) == [], f"signer bi --kube-api-ip: profile {other} does NOT get :6443 from it")
for a in (["signer", "bank-a"], ["signer", "bank-b"], ["signer", "bank-c", "--cert-lb-ip", LB], ["custodian", "bi"], ["compare", "bi"], ["gateway", "bi"], ["viewpush", "bank-a"]):
    check(run(render, *a, "--kube-api-ip", KIP[0]).returncode == 2, f"render.sh {' '.join(a)} --kube-api-ip must be refused with exit 2 (the BI signer only)")
for bad in ("300.1.1.1", "10.0.0.0/24", "api.example", "", "1.2.3"):
    check(run(render, "signer", "bi", "--kube-api-ip", bad).returncode == 2, f"render.sh signer bi --kube-api-ip {bad!r} must be refused with exit 2")
check(run(render, "signer", "bi", "--kube-api-ip").returncode == 2, "render.sh signer bi --kube-api-ip (no value) must be refused with exit 2")
check(run(render, "signer", "bi", "--kube-api-ip", KIP[0], "--cert-lb-ip", LB).returncode == 2, "render.sh signer bi --kube-api-ip + --cert-lb-ip must be refused (cert-lb-ip is bank-c only)")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"OK stealth egress: {len(CASES)} policies + {len(CASES)} probes + {len(BAD)} refusals checked")
