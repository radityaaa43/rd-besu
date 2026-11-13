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
SN = os.path.join(tmp, "sn.json")
open(SN, "w").write('["enode://' + "a" * 128 + '@203.0.113.1:30303?discport=0"]')
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
        if d["kind"] in ("Deployment", "StatefulSet"):
            out.append(d["spec"]["template"]["metadata"]["labels"])
        if d["kind"] == "CronJob":
            out.append(d["spec"]["jobTemplate"]["spec"]["template"]["metadata"]["labels"])
        if d["kind"] == "Job":
            out.append(d["spec"]["template"]["metadata"]["labels"])
    return out


DNS = {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]}
RPC = {"to": [{"podSelector": {"matchLabels": {"app.kubernetes.io/name": "besu-rpc"}}}], "ports": [{"protocol": "TCP", "port": 8545}]}
TCP = lambda p: [{"protocol": "TCP", "port": p}]
# S17 2026-11-12 topology: signer and custodian reach the validator only through their party's own bank-gw door (Besu :8545, mTLS + OPA)
GWRPC = lambda party: {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"rd-zeto-{party}"}}, "podSelector": {"matchLabels": {"app": "bank-gw"}}}], "ports": TCP(8545)}


ZP = ["bi", "bank-a", "bank-b"]  # the cluster-1 zeto parties
LB_C, LB_1 = ["203.0.113.30"], ["203.0.113.31", "203.0.113.32", "203.0.113.33"]  # besu-p2p LB of bank-c / of the three cluster-1 validators (documentation addresses)
VAL = {"app.kubernetes.io/name": "besu-validator"}
ZETO = lambda k: {"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"rd-zeto-{k}"}}, "podSelector": {"matchLabels": VAL}}
RPC_SEL = {"matchLabels": {"app.kubernetes.io/name": "besu-rpc"}}
VAULT_SEL = {"matchLabels": {"app.kubernetes.io/name": "vault"}}  # matchLabels ONLY: the chart pod keeps its labels (no restart); instance/component are not in the policy
KIPV = ["203.0.113.20", "203.0.113.21"]  # kube API endpoint IPs for the vault policy (documentation addresses; the real ones are quoted at apply time)
VAULT_FIX = os.path.join(K8S, "vault", "test", "chart-0.34.1-statefulset.fixture.yaml")  # mirrors chart 0.34.1; the real render is used by zeto/k8s/egress/test/gate.py when VAULT_CHART_DIR is set


def vault_docs(party):
    return [d for d in yaml.safe_load_all(open(VAULT_FIX).read().replace("${NS}", f"rd-stealth-{party}").replace("${PARTY}", party)) if d]


def rpc_rules(party, multi):
    """besu-rpc p2p 30303: default = the OWN party's zeto validator only (README decision); --multi-peer = every zeto validator (catch-up phase): same cluster by selector, the other cluster by LB /32."""
    if not multi:
        return [{"to": [ZETO(party)], "ports": TCP(30303)}, DNS]
    same = ZP if party in ZP else ["bank-c"]
    return [{"to": [ZETO(k) for k in same], "ports": TCP(30303)}, {"to": [{"ipBlock": {"cidr": f"{ip}/32"}} for ip in (LB_1 if party == "bank-c" else LB_C)], "ports": TCP(30303)}, DNS]


def expected(workload, party):
    """(policy name, profile label, rules) written out by hand, independent of the renderer. besu-rpc has no profile label: its pod keeps its labels (no restart), the policy selects app.kubernetes.io/name=besu-rpc."""
    if workload == "besu-rpc":
        return "besu-rpc-egress", None, rpc_rules(party, False)
    if workload == "vault":  # R17-zeto-other: holds the keys at rest and a ServiceAccount token (kube auth -> TokenReview): kube API endpoint IPs :6443 + DNS, nothing else
        return "vault-egress", None, [{"to": [{"ipBlock": {"cidr": f"{ip}/32"}} for ip in KIPV], "ports": TCP(6443)}, DNS]
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
        return "stealth-signer-egress", "stealth-signer", [GWRPC(party), cert, DNS]
    if workload == "custodian":
        return "stealth-custodian-egress", "stealth-custodian", [GWRPC(party), DNS]
    if workload == "compare":
        return "stealth-viewkey-egress", "stealth-viewkey", [RPC, DNS]
    rules = [{"to": [{"podSelector": {"matchLabels": {"app": "stealth-signer"}, "matchExpressions": [{"key": "role", "operator": "In", "values": ["bank", "bi"]}]}}], "ports": TCP(8080)}]
    if party == "bi":
        rules.append({"to": [{"podSelector": {"matchLabels": {"app": "stealth-signer", "role": "custodian"}}}], "ports": TCP(9443)})
    rules.append({"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"rd-zeto-{party}"}}, "podSelector": {"matchLabels": {"app": "bundle-server"}}}], "ports": TCP(8080)})
    return "st-gw-egress", "st-gw", rules + [DNS]


CASES = [("besu-rpc", "bi", []), ("besu-rpc", "bank-a", []), ("besu-rpc", "bank-b", []), ("besu-rpc", "bank-c", []), ("signer", "bi", []), ("signer", "bank-a", []), ("signer", "bank-b", []), ("signer", "bank-c", ["--cert-lb-ip", LB]), ("custodian", "bi", []), ("compare", "bi", []),
         ("gateway", "bi", []), ("gateway", "bank-a", []), ("gateway", "bank-b", []), ("gateway", "bank-c", []),
         ("viewpush", "bank-a", []), ("viewpush", "bank-b", []), ("viewpush", "bank-c", ["--cert-lb-ip", LB])]
CASES += [("vault", p, [a for ip in KIPV for a in ("--kube-api-ip", ip)]) for p in ("bi", "bank-a", "bank-b", "bank-c")]


def workload_pods(workload, party):
    """The pod label sets the real workload renders produce (the policy must select exactly these)."""
    if workload == "besu-rpc":
        return pod_labels(docs(f"{K8S}/rpc/render.sh", *(["--cluster", "2"] if party == "bank-c" else []), "node", party, "--static-nodes", SN))
    if workload == "vault":
        return pod_labels(vault_docs(party))
    if workload == "gateway":
        return pod_labels(docs(GATEWAY, party))
    if workload == "compare":
        return pod_labels(docs(SIGNER, "compare", "--image", IMG, "--chain-env", chain, "--registry", REG))
    if workload == "custodian":
        return pod_labels(docs(SIGNER, "custodian", "--image", IMG, "--chain-env", chain, "--bank-signers", "CN=a", "--bi-signer", "CN=b"))
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
    want_sel = {"besu-rpc": RPC_SEL, "vault": VAULT_SEL}.get(workload, {"matchLabels": {"rd/egress": profile}})
    check(sp["podSelector"] == want_sel and sp["policyTypes"] == ["Egress"] and "ingress" not in sp, f"{tag}: selects {want_sel} only, Egress only: {sp['podSelector']}")
    check(sp["egress"] == rules, f"{tag}: egress rules are exactly the expected list\n   got  {sp['egress']}\n   want {rules}")
    # the form rule, asserted on every destination of every rule
    for r in sp["egress"]:
        check(bool(r.get("ports")) and bool(r.get("to")), f"{tag}: every rule has a destination and ports (no allow-all)")
        for t in r["to"]:
            if "ipBlock" in t:
                check(set(t) == {"ipBlock"} and re.fullmatch(r"[0-9.]+/32", t["ipBlock"]["cidr"]) is not None and "except" not in t["ipBlock"], f"{tag}: ipBlock only as a bare /32: {t}")
                check((workload in ("signer", "viewpush") and party == "bank-c") or (workload == "vault" and r["ports"] == TCP(6443)), f"{tag}: ipBlock ONLY for the other cluster (bank-c signer/viewpush -> BI cert door LB) or the vault kube API endpoint :6443, never same-cluster: {t}")
            else:
                ps, nss = t.get("podSelector"), t.get("namespaceSelector")
                check(ps is not None and ps != {} and bool(ps.get("matchLabels")), f"{tag}: no podSelector {{}} / unnamed pods: {t}")
                check(nss is None or (set(nss) == {"matchLabels"} and list(nss["matchLabels"]) == ["kubernetes.io/metadata.name"]), f"{tag}: namespaceSelector only by exact name, never wildcard/expressions: {t}")
    # union proof (the R17-stealth gate, offline): allow-dns-egress of this ns + the new policy => the workload pods are selected by the new policy ONLY; besu-rpc stays on allow-dns-egress
    base = [d for d in docs(PARTY, "--cluster", "2", party) if d["kind"] == "NetworkPolicy"] if party == "bank-c" else [d for d in docs(PARTY, party) if d["kind"] == "NetworkPolicy"]
    old_base = [{"kind": "NetworkPolicy", "metadata": {"name": "allow-dns-egress"}, "spec": {"podSelector": {"matchExpressions": [{"key": "rd/egress-locked", "operator": "DoesNotExist"}]}, "policyTypes": ["Egress"], "egress": [{}]}}]
    pods = workload_pods(workload, party)
    check(len(pods) == 1, f"{tag}: the workload render has exactly one pod template")
    for pl in pods:
        check(union(base + [pol], pl) == [name], f"{tag}: union of ALL Egress policies selecting the pod = {[name]} (got {union(base + [pol], pl)})")
        if workload in ("besu-rpc", "vault"):  # R17-zeto-other: no label change, no restart; the edited baseline stops selecting it, so its own policy (besu-rpc-egress | vault-egress) is its ONLY egress policy
            check(union(old_base + [pol], pl) == ["allow-dns-egress", name], f"{tag}: inert stage (OLD baseline + {name}) selects the pod with both: {union(old_base + [pol], pl)}")
            check("rd/egress-locked" not in pl and "rd/egress" not in pl, f"{tag}: the live pod labels are unchanged (no restart): {pl}")
        else:
            check(pl.get("rd/egress-locked") == "true" and pl.get("rd/egress") == profile, f"{tag}: pod template carries rd/egress-locked=true, rd/egress={profile}: {pl}")
    if workload != "besu-rpc":
        check(union(base + [pol], {"app.kubernetes.io/name": "besu-rpc"}) == [], f"{tag}: the besu-rpc pod is NOT touched by this policy, and the edited baseline no longer selects it (its own policy besu-rpc-egress does)")
    if workload != "vault":
        check(union(base + [pol], {"app.kubernetes.io/name": "vault"}) == [], f"{tag}: the vault pod is NOT touched by this policy, and the edited baseline no longer selects it (its own policy vault-egress does)")

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
    if workload in ("besu-rpc", "vault"):  # selected by app.kubernetes.io/name (the live pod has no rd/egress label); rd/egress-locked keeps allow-dns-egress (old and new) off the probe
        del want_lab["rd/egress"]
        want_lab["app.kubernetes.io/name"] = workload
    if party == "bank-c":
        want_lab["cluster"] = "2"
    check(lab == want_lab, f"{tag}: labels exactly {want_lab} (selected by the policy; NOT app=stealth-signer/st-gw): {lab}")
    hit = sorted(s["metadata"]["name"] for s in services if all(lab.get(k) == v for k, v in s["spec"]["selector"].items()))
    # besu-rpc: the policy selects the pod's identity label, which its Services select too; harmless while the probe is never Ready (below). A StatefulSet claims only pods named besu-rpc-<ordinal>.
    check(hit == (["besu-rpc", "besu-rpc-hs"] if workload == "besu-rpc" else []), f"{tag}: Services selecting the probe's labels = {['besu-rpc', 'besu-rpc-hs'] if workload == 'besu-rpc' else []}: {hit}")
    check(not (workload == "besu-rpc" and re.fullmatch(r"besu-rpc-[0-9]+", p["metadata"]["name"])), f"{tag}: the probe is not named like a besu-rpc StatefulSet pod")
    if workload == "vault":  # the probe carries ONLY the identity label the policy selects: the chart StatefulSet (name+instance+component) must not adopt it, nor the chart Services select it
        vd = vault_docs(party)
        vsts = [d for d in vd if d["kind"] == "StatefulSet"]
        check(len(vsts) == 1 and not sel(vsts[0]["spec"]["selector"], lab), f"{tag}: the chart StatefulSet selector must NOT match the probe labels (else it adopts the probe): {lab}")
        check(not any(all(lab.get(k) == v for k, v in d["spec"]["selector"].items()) for d in vd if d["kind"] == "Service"), f"{tag}: no chart Service selects the probe labels")
        check(not re.fullmatch(r"vault-[0-9]+", p["metadata"]["name"]), f"{tag}: the probe is not named like the vault StatefulSet pod")
    if workload == "besu-rpc":
        sts = [d for d in docs(f"{K8S}/rpc/render.sh", *(["--cluster", "2"] if party == "bank-c" else []), "node", party, "--static-nodes", SN) if d["kind"] == "StatefulSet"]
        check(len(sts) == 1 and sts[0]["metadata"]["name"] == "besu-rpc", f"{tag}: the besu-rpc StatefulSet is listed from the render")
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
MULTI_BAD = [["besu-rpc", "bi", "--other-cluster-lb", LB_C[0]], ["besu-rpc", "bi", "--multi-peer"], ["besu-rpc", "bi", "--multi-peer", "--other-cluster-lb", LB_1[0], "--other-cluster-lb", LB_1[1]], ["besu-rpc", "bank-c", "--multi-peer", "--other-cluster-lb", LB_1[0]],
             ["besu-rpc", "bank-c", "--multi-peer", *[a for ip in LB_1[:2] for a in ("--other-cluster-lb", ip)]], ["besu-rpc", "bi", "--multi-peer", "--other-cluster-lb", "300.1.1.1"],
             ["besu-rpc", "bi", "--multi-peer", "--other-cluster-lb", LB_C[0], "--other-cluster-lb", LB_C[0]], ["besu-rpc", "bi", "--cert-lb-ip", LB_C[0]], ["besu-rpc", "bank-d"], ["besu-rpc"],
             ["signer", "bi", "--multi-peer"], ["gateway", "bi", "--multi-peer"], ["baseline"], ["baseline", "bank-d"], ["baseline", "bi", "bank-a"], ["baseline", "bi", "--extra"]]
BAD = MULTI_BAD + [[], ["signer"], ["signer", "bank-c"], ["signer", "bank-c", "--cert-lb-ip", "300.1.1.1"], ["signer", "bank-c", "--cert-lb-ip", "10.0.0.0/24"], ["signer", "bank-a", "--cert-lb-ip", LB], ["signer", "bi", "--cert-lb-ip", LB],
       ["signer", "bank-d"], ["custodian", "bank-a"], ["compare", "bank-a"], ["gateway", "bank-d"], ["gateway", "bank-a", "--cert-lb-ip", LB], ["scanner", "bi"], ["vault", "bi"], ["signer", "bank-a", "--extra"],
       ["viewpush", "bi"], ["viewpush", "bank-c"], ["viewpush", "bank-a", "--cert-lb-ip", LB], ["viewpush", "bank-d"], ["viewpush", "bank-c", "--cert-lb-ip", "300.1.1.1"], ["probe", "viewpush", "bi", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "stealth-signer:8080"],
       ["probe", "viewpush", "bank-c", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "stealth-signer:8080", "--cert-lb-ip", LB],
       ["probe", "signer", "bank-a", "--target", "1.1.1.1:443", "--control", "besu-rpc:8545"], ["probe", "signer", "bank-a", "--image", "busybox:1.36", "--target", "1.1.1.1:443", "--control", "besu-rpc:8545"],
       ["probe", "signer", "bank-a", "--image", BUSY, "--control", "besu-rpc:8545"], ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1:443"], ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1", "--control", "besu-rpc:8545"],
       ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1:443;id", "--control", "besu-rpc:8545"], ["probe", "signer", "bank-a", "--image", BUSY, "--target", "host:443", "--control", "besu-rpc:8545"],
       ["probe", "signer", "bank-a", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "besu-rpc:8545;id"],
       # vault: the kube API endpoint IPs are required (1 to 8, bare IPv4, no duplicate) and exist for 'vault' and 'signer bi' only
       ["vault", "bank-d", "--kube-api-ip", KIPV[0]], ["vault", "bi", "--kube-api-ip"], ["vault", "bi", "--kube-api-ip", "300.1.1.1"], ["vault", "bi", "--kube-api-ip", "10.0.0.0/24"], ["vault", "bi", "--kube-api-ip", "api.example"],
       ["vault", "bi", "--kube-api-ip", ""], ["vault", "bi", "--kube-api-ip", "1.2.3"], ["vault", "bi", "--kube-api-ip", KIPV[0], "--kube-api-ip", KIPV[0]],
       ["vault", "bi", *[a for i in range(9) for a in ("--kube-api-ip", f"203.0.113.{40 + i}")]],
       ["vault", "bi", "--kube-api-ip", KIPV[0], "--cert-lb-ip", LB], ["vault", "bank-c", "--kube-api-ip", KIPV[0], "--cert-lb-ip", LB], ["vault", "bi", "--kube-api-ip", KIPV[0], "--multi-peer"],
       ["vault", "bi", "--kube-api-ip", KIPV[0], "--other-cluster-lb", LB], ["vault", "bi", "--kube-api-ip", KIPV[0], "--extra"],
       ["probe", "vault", "bank-d", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "dns:53"], ["probe", "vault", "bi", "--image", BUSY, "--target", "1.1.1.1:443", "--control", "dns:53", "--kube-api-ip", KIPV[0]],
       ["probe", "vault", "bi", "--image", "vault:1", "--target", "1.1.1.1:443", "--control", "dns:53"], ["probe", "vault", "bi", "--image", BUSY, "--control", "dns:53"]]
# ---- besu-rpc --multi-peer (the catch-up phase: README "Initial sync"): every zeto validator, same cluster by selector, the other cluster by LB /32
for party in ("bi", "bank-a", "bank-b", "bank-c"):
    lbs = LB_1 if party == "bank-c" else LB_C
    ds = docs(render, "besu-rpc", party, "--multi-peer", *[a for ip in lbs for a in ("--other-cluster-lb", ip)])
    check(len(ds) == 1 and ds[0]["spec"]["egress"] == rpc_rules(party, True) and ds[0]["spec"]["podSelector"] == RPC_SEL, f"besu-rpc --multi-peer/{party}: rules exactly {rpc_rules(party, True)}: {ds[0]['spec'] if ds else ds}")
    if ds:
        ips = [t["ipBlock"]["cidr"] for r in ds[0]["spec"]["egress"] for t in r["to"] if "ipBlock" in t]
        check(ips == [f"{ip}/32" for ip in lbs], f"besu-rpc --multi-peer/{party}: ipBlock only for the OTHER cluster's LBs: {ips}")
# ---- baseline: the edited allow-dns-egress of the stealth namespace, byte-for-byte what stealth-address/k8s/render.sh renders
for party in ("bi", "bank-a", "bank-b", "bank-c"):
    full = [d for d in docs(PARTY, *(["--cluster", "2"] if party == "bank-c" else []), party) if d["kind"] == "NetworkPolicy" and d["metadata"]["name"] == "allow-dns-egress"]
    check(docs(render, "baseline", party) == full and len(full) == 1, f"baseline/{party}: prints exactly the allow-dns-egress of the party render")

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

# ---- vault-egress: one kube API rule (ipBlock <ip>/32 TCP 6443, in the order given, 1 to 8 IPs) + kube-dns, nothing else; --kube-api-ip is refused for every workload except vault and 'signer bi'
for n in (1, 8):
    ips = [f"203.0.113.{50 + i}" for i in range(n)]
    ds = docs(render, "vault", "bank-a", *[a for ip in ips for a in ("--kube-api-ip", ip)])
    check(len(ds) == 1 and ds[0]["spec"]["egress"] == [{"to": [{"ipBlock": {"cidr": f"{ip}/32"}} for ip in ips], "ports": TCP(6443)}, DNS], f"vault bank-a with {n} --kube-api-ip: kube rule in the order given, then DNS: {ds[0]['spec']['egress'] if ds else ds}")
for a in (["besu-rpc", "bi"], ["gateway", "bi"], ["signer", "bank-a"], ["custodian", "bi"], ["compare", "bi"], ["viewpush", "bank-a"], ["besu-rpc", "bi", "--multi-peer"]):
    check(run(render, *a, "--kube-api-ip", KIPV[0]).returncode == 2, f"render.sh {' '.join(a)} --kube-api-ip must be refused with exit 2")
for party in ("bi", "bank-a", "bank-b", "bank-c"):  # vault pod = key holder with a ServiceAccount token: the OLD baseline plus vault-egress selects it twice; the edited baseline must not
    pol = docs(render, "vault", party, "--kube-api-ip", KIPV[0])
    base = [d for d in docs(PARTY, *(["--cluster", "2"] if party == "bank-c" else []), party) if d["kind"] == "NetworkPolicy"]
    pl = pod_labels(vault_docs(party))[0]
    check(pol and union(base + pol, pl) == ["vault-egress"], f"vault/{party}: edited baseline + vault-egress select the chart pod {pl} by vault-egress ONLY: {union(base + pol, pl) if pol else pol}")
    check(pol and union(base + pol, {"app.kubernetes.io/name": "vault", "app.kubernetes.io/instance": "vault", "component": "server"}) == ["vault-egress"], f"vault/{party}: the bare chart labels are covered the same way")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"OK stealth egress: {len(CASES)} policies + {len(CASES)} probes + 4 multi-peer + 4 baselines + {len(BAD)} refusals checked")
