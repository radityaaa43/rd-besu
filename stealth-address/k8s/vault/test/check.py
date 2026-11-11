#!/usr/bin/env python3
"""Offline check of the stealth S7 per-party key store (final-design/stealth/PLAN.md S7, README decision 28: Vault).
Usage: check.py <vault/render.sh> <stealth k8s render.sh> <policy.hcl>   Exit 0 = all hold; 1 = failures on stderr.
Needs PyYAML only; no cluster. VAULT_CHART_DIR (+ helm) adds a render of the pinned upstream chart."""
import os, re, shutil, subprocess, sys, yaml

render, s1render, policy = sys.argv[1:4]
PARTIES = {"bi": "rd-stealth-bi", "bank-a": "rd-stealth-bank-a", "bank-b": "rd-stealth-bank-b"}
CHART, IMAGE = "0.34.1", "hashicorp/vault:2.0.4"
fails = []

def check(ok, msg):
    if not ok:
        fails.append(msg)

def run(cmd, *args):
    try:
        return subprocess.run([cmd, *args], capture_output=True, text=True)
    except OSError as e:
        return subprocess.CompletedProcess([cmd], 127, "", str(e))

def docs(cmd, *args):
    out = run(cmd, *args)
    if out.returncode != 0:
        fails.append(f"{os.path.basename(cmd)} {' '.join(args)} exited {out.returncode}: {out.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(out.stdout) if d]

def of(ds, kind):
    return [d for d in ds if d["kind"] == kind]

for party, ns in PARTIES.items():
    ds = docs(render, party)
    check(sorted(d["kind"] for d in ds) == ["NetworkPolicy", "ServiceAccount"], f"{party}: kinds must be exactly ServiceAccount + NetworkPolicy (no Secret, no key material): {[d['kind'] for d in ds]}")
    for d in ds:
        check(d["metadata"].get("namespace") == ns and d["metadata"].get("labels", {}).get("part-of") == "rd-stealth" and d["metadata"]["labels"].get("party") == party, f"{party}: {d['kind']}/{d['metadata']['name']} needs namespace {ns} and labels part-of=rd-stealth, party={party}")
    sa = of(ds, "ServiceAccount")
    check(len(sa) == 1 and sa[0]["metadata"]["name"] == "stealth-signer" and sa[0].get("automountServiceAccountToken") is True, f"{party}: ServiceAccount stealth-signer with a token (Vault kubernetes auth needs it)")
    np = of(ds, "NetworkPolicy")
    if len(np) == 1:
        sp = np[0]["spec"]
        check(np[0]["metadata"]["name"] == "vault-ingress" and sp["podSelector"] == {"matchLabels": {"app.kubernetes.io/name": "vault", "component": "server"}} and sp["policyTypes"] == ["Ingress"], f"{party}: vault-ingress must select the chart's server pod, Ingress")
        check(len(sp["ingress"]) == 1 and sp["ingress"][0]["from"] == [{"podSelector": {"matchLabels": {"app": "stealth-signer"}}}] and sp["ingress"][0]["ports"] == [{"protocol": "TCP", "port": 8200}], f"{party}: only pods app=stealth-signer of the same namespace, TCP 8200")
    else:
        check(False, f"{party}: exactly one NetworkPolicy required")

    # values for the pinned upstream chart
    v = docs(render, "values", party)
    if len(v) == 1:
        v = v[0]; srv = v["server"]
        check(v["global"].get("tlsDisable") is True and v["global"].get("enabled") is True, f"{party}: values global.enabled true, tlsDisable true (in-cluster plain HTTP, recorded gap in README)")
        check(v.get("fullnameOverride") == "vault", f"{party}: fullnameOverride vault (probe and signer address vault.<ns>.svc)")
        check(v["injector"]["enabled"] is False and v["csi"]["enabled"] is False and v["ui"]["enabled"] is False, f"{party}: injector, csi, ui disabled")
        check(srv["standalone"]["enabled"] is True and srv["ha"]["enabled"] is False, f"{party}: standalone, not HA")
        check(srv["authDelegator"]["enabled"] is False, f"{party}: chart auth-delegator off (its ClusterRoleBinding name would collide across namespaces); ours is cluster/ and unique")
        check(srv["networkPolicy"]["enabled"] is False, f"{party}: chart NetworkPolicy off (ours is vault-ingress)")
        check(srv["image"] == {"repository": "hashicorp/vault", "tag": "2.0.4"}, f"{party}: image pinned hashicorp/vault:2.0.4: {srv.get('image')}")
        ds_ = srv["dataStorage"]
        check(ds_["enabled"] is True and ds_["size"] == "20Gi" and ds_["storageClass"] == "alicloud-essd" and ds_["accessMode"] == "ReadWriteOnce", f"{party}: dataStorage 20Gi alicloud-essd RWO")
        check(set(srv["resources"].get("requests", {})) >= {"cpu", "memory"} and set(srv["resources"].get("limits", {})) >= {"cpu", "memory"}, f"{party}: requests and limits set")
        check(srv["extraLabels"] == {"part-of": "rd-stealth", "party": party}, f"{party}: extraLabels part-of, party")
        check('storage "file"' in srv["standalone"]["config"] and "tls_disable = 1" in srv["standalone"]["config"], f"{party}: standalone config uses file storage on the PVC")
    else:
        check(False, f"{party}: render.sh values {party} must emit one document")

    # the one cluster-scoped object: TokenReview delegation for Vault's kubernetes auth
    cl = docs(render, "cluster", party)
    check(len(cl) == 1 and cl[0]["kind"] == "ClusterRoleBinding" and cl[0]["metadata"]["name"] == f"vault-auth-delegator-{ns}", f"{party}: exactly one ClusterRoleBinding vault-auth-delegator-{ns}")
    if len(cl) == 1:
        check(cl[0]["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "system:auth-delegator"} and cl[0]["subjects"] == [{"kind": "ServiceAccount", "name": "vault", "namespace": ns}], f"{party}: binds only system:auth-delegator to ServiceAccount vault of {ns}")

    # stealth S1 (PR #14) allow-same-namespace would let st-gw reach the key store (policies add up)
    s1 = docs(s1render, party)
    same = [d for d in of(s1, "NetworkPolicy") if d["metadata"]["name"] == "allow-same-namespace"]
    sel = same[0]["spec"]["podSelector"].get("matchExpressions", []) if same else []
    check(any(e["key"] == "app.kubernetes.io/name" and e["operator"] == "NotIn" and "vault" in e["values"] for e in sel), f"{party}: S1 allow-same-namespace must exclude app.kubernetes.io/name=vault, else vault-ingress restricts nothing")

check(run(render, "bank-c").returncode != 0, "render.sh bank-c must fail (cluster 2 is out of scope)")
check([d["metadata"]["namespace"] for d in docs(render, "all") if d["kind"] == "NetworkPolicy"] == list(PARTIES.values()), "all: one vault-ingress per party in order bi, bank-a, bank-b")

# policy: the signer may read exactly one path
try:
    hcl = open(policy).read()
    paths = re.findall(r'path\s+"([^"]+)"\s*{\s*capabilities\s*=\s*\[([^\]]*)\]', hcl)
    check(paths == [("secret/data/stealth-keys", '"read"')], f"policy: exactly path secret/data/stealth-keys with capabilities [\"read\"], got {paths}")
except OSError as e:
    check(False, f"policy file missing: {e}")

# probes: four throwaway pods; none prints a secret value
pr = docs(render, "probe", "bank-a", "bank-b")
pods = {d["metadata"]["name"]: d for d in of(pr, "Pod")}
check(sorted(pods) == ["vprobe-gw", "vprobe-other", "vprobe-signer", "vprobe-wrongsa"], f"probe: pods {sorted(pods)}")
if len(pods) == 4:
    check(all(d["metadata"]["labels"].get("throwaway") == "stealth-s7-probe" for d in pr), "probe: every object carries throwaway=stealth-s7-probe")
    def pod(n, ns, app, sa):
        p = pods[n]
        check(p["metadata"]["namespace"] == ns and p["metadata"]["labels"]["app"] == app and p["spec"].get("serviceAccountName", "default") == sa, f"{n}: namespace {ns}, app={app}, serviceAccount {sa}")
    pod("vprobe-signer", "rd-stealth-bank-a", "stealth-signer", "stealth-signer")
    pod("vprobe-wrongsa", "rd-stealth-bank-a", "stealth-signer", "default")
    pod("vprobe-gw", "rd-stealth-bank-a", "st-gw", "default")
    pod("vprobe-other", "rd-stealth-bank-b", "stealth-signer", "default")
    for n, p in pods.items():
        c = p["spec"]["containers"][0]; s = c["command"][-1]
        check(c["image"] == IMAGE, f"{n}: image {IMAGE}")
        kv = re.findall(r"kv get \S+( >/dev/null)?", s)
        check("-format" not in s and all(kv) and not re.search(r"-field=(?!token)", s) and "cat " not in s.replace("cat /var/run", ""), f"{n}: must not print a secret value (kv get only to /dev/null, no -format, only -field=token captured)")
    sg = pods["vprobe-signer"]["spec"]["containers"][0]["command"][-1]
    check("auth/kubernetes/login" in sg and "role=stealth-signer" in sg and "kv get secret/stealth-keys >/dev/null" in sg and "READ-OK" in sg and "READ-DENIED" in sg, "vprobe-signer: login, kv get to /dev/null, READ-OK / READ-DENIED")
    check("LOGIN-DENIED" in pods["vprobe-wrongsa"]["spec"]["containers"][0]["command"][-1], "vprobe-wrongsa: LOGIN-DENIED")
    for n in ("vprobe-gw", "vprobe-other"):
        s = pods[n]["spec"]["containers"][0]["command"][-1]
        check("timeout 5 nc -z" in s and "BLOCKED" in s and "REFUSED" in s and "for i in 1 2 3" in s, f"{n}: nc with timeout, BLOCKED vs REFUSED, 3 attempts")

# optional: render the real pinned chart
chart_dir = os.environ.get("VAULT_CHART_DIR")
if chart_dir and shutil.which("helm"):
    vals = subprocess.run([render, "values", "bank-a"], capture_output=True, text=True).stdout
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".yaml") as f:
        f.write(vals); f.flush()
        out = run("helm", "template", "vault", chart_dir, "-n", "rd-stealth-bank-a", "-f", f.name)
    if out.returncode != 0:
        fails.append(f"helm template failed: {out.stderr.strip()[:300]}")
    else:
        h = [d for d in yaml.safe_load_all(out.stdout) if d]
        sts = of(h, "StatefulSet")
        check(len(sts) == 1 and sts[0]["spec"]["template"]["spec"]["containers"][0]["image"] == IMAGE, "chart: one StatefulSet with image " + IMAGE)
        check(not of(h, "ClusterRoleBinding") and not of(h, "Deployment") and not of(h, "NetworkPolicy"), "chart: no ClusterRoleBinding, injector Deployment or NetworkPolicy")
        check([d["metadata"]["name"] for d in of(h, "Service")] == ["vault-internal", "vault"] or sorted(d["metadata"]["name"] for d in of(h, "Service")) == ["vault", "vault-internal"], "chart: Services vault, vault-internal")
        vct = (sts[0]["spec"].get("volumeClaimTemplates") or [{}]) if sts else [{}]
        check(any(t.get("spec", {}).get("storageClassName") == "alicloud-essd" and t["spec"]["resources"]["requests"]["storage"] == "20Gi" for t in vct), "chart: PVC 20Gi alicloud-essd")
        lab = sts[0]["spec"]["template"]["metadata"]["labels"] if sts else {}
        check(lab.get("app.kubernetes.io/name") == "vault" and lab.get("component") == "server", f"chart: pod labels must match vault-ingress selector: {lab}")
else:
    print("SKIP chart render (set VAULT_CHART_DIR to the unpacked hashicorp/vault 0.34.1 chart and have helm)")

if fails:
    print("\n".join("FAIL " + f for f in fails if f), file=sys.stderr)
    sys.exit(1)
print("OK all S7 assertions hold")
