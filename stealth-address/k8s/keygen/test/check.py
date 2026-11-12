"""Offline check of the stealth keygen renders (Option C: the key is made IN a pod of the party's own namespace): stealth-address/k8s/keygen/render.sh.
Every assertion names what it protects. Refusals are asserted as non-zero exits with the expected word."""
import itertools, subprocess, sys
import yaml

R = sys.argv[1]
IMG = "ghcr.io/x/rd-stealth-signer@sha256:" + "a" * 64
IPS = ["172.28.18.47", "172.28.47.223"]
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
def run(*a):
    return subprocess.run(["bash", R, *a], capture_output=True, text=True)
def docs(*a):
    r = run(*a)
    check(r.returncode == 0, f"render {a} rc={r.returncode}: {r.stderr.strip()[:160]}")
    return [d for d in yaml.safe_load_all(r.stdout) if d] if r.returncode == 0 else []
def kube_args(): return list(itertools.chain.from_iterable(["--kube-api-ip", i] for i in IPS))

# w -> (namespace, Secret, kinds the Job may generate)
WL = {"cert": ("rd-stealth-bi", "stealth-cert-key", ["certKey"]), "bi": ("rd-stealth-bi", "stealth-bi-keys", ["spendKey", "viewKey"])}
def sel(s, lab):
    if s is None: return True
    if any(lab.get(k) != v for k, v in s.get("matchLabels", {}).items()): return False
    for e in s.get("matchExpressions", []):
        k, op, vals = e["key"], e["operator"], e.get("values", []); has = k in lab
        if (op == "In" and not (has and lab[k] in vals)) or (op == "NotIn" and has and lab[k] in vals) or (op == "Exists" and not has) or (op == "DoesNotExist" and has): return False
    return True

for w, (ns, secret, kinds) in WL.items():
    ds = docs(w, "--image", IMG, *kube_args())
    by = {d["kind"]: d for d in ds}
    check(sorted(by) == ["Job", "NetworkPolicy", "Role", "RoleBinding", "ServiceAccount"], f"{w}: objects are exactly Job, NetworkPolicy, Role, RoleBinding, ServiceAccount, got {sorted(by)}")
    check(all(d["metadata"]["namespace"] == ns for d in ds), f"{w}: every object is in {ns} (the key never leaves the party's own namespace)")
    check(not any(d["kind"] == "Secret" for d in ds), f"{w}: no Secret is rendered (the party-admin pre-creates the EMPTY Secret; a rendered Secret would carry or overwrite a value)")
    if len(by) != 5: continue
    # Role: the only way the pod can reach the API
    role = by["Role"]
    check(len(role["rules"]) == 1, f"{w}: the Role has exactly one rule")
    rule = role["rules"][0]
    check(rule["apiGroups"] == [""] and rule["resources"] == ["secrets"] and rule["resourceNames"] == [secret], f"{w}: Role is limited to secrets named [{secret}] only (create cannot be limited by resourceNames and is therefore absent)")
    check(sorted(rule["verbs"]) == ["get", "patch", "update"], f"{w}: verbs are exactly get, patch, update (no create/list/watch/delete/deletecollection), got {rule['verbs']}")
    rb = by["RoleBinding"]
    check(rb["subjects"] == [{"kind": "ServiceAccount", "name": f"stealth-keygen-{w}", "namespace": ns}] and rb["roleRef"]["name"] == role["metadata"]["name"], f"{w}: the RoleBinding has the one dedicated ServiceAccount as its only subject")
    # Job
    job = by["Job"]; pod = job["spec"]["template"]["spec"]; plab = job["spec"]["template"]["metadata"]["labels"]
    check(pod["serviceAccountName"] == f"stealth-keygen-{w}" and pod.get("automountServiceAccountToken") is True, f"{w}: the token is mounted on the dedicated SA only (this pod is the ONLY one that gets a token)")
    check(plab.get("rd/egress-locked") == "true" and plab.get("rd/egress") == f"stealth-keygen-{w}", f"{w}: pod carries rd/egress-locked=true and rd/egress=stealth-keygen-{w}, got {plab}")
    check(job["spec"]["backoffLimit"] == 0 and job["spec"]["activeDeadlineSeconds"] <= 300 and job["spec"]["ttlSecondsAfterFinished"] <= 3600, f"{w}: backoffLimit 0 (no second key), deadline <= 300 s, ttl <= 1 h")
    check(pod["restartPolicy"] == "Never", f"{w}: restartPolicy Never")
    c = pod["containers"][0]
    check(c["image"] == IMG and "imagePullPolicy" in c, f"{w}: image is the digest-pinned ref")
    check(c["command"] == ["node", "--experimental-transform-types", "signer/src/keygen.ts", secret, *kinds], f"{w}: command is exactly keygen.ts {secret} {kinds}, got {c['command']}")
    check(not c.get("env") and not c.get("envFrom"), f"{w}: no env, no envFrom (nothing to smuggle a value in)")
    check(not pod.get("volumes") or all("secret" not in v and "configMap" not in v for v in pod["volumes"]), f"{w}: the pod mounts no Secret and no ConfigMap volume")
    check(c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{w}: container securityContext hardened")
    check(pod["securityContext"].get("runAsNonRoot") is True and pod["securityContext"]["runAsUser"] == 10001, f"{w}: runs as the image's non-root user 10001")
    # NetworkPolicy: kube API endpoint IPs :6443 ONLY
    np = by["NetworkPolicy"]; spec = np["spec"]
    check(np["metadata"]["name"] == f"stealth-keygen-{w}-egress" and spec["policyTypes"] == ["Egress"], f"{w}: Egress-only policy named stealth-keygen-{w}-egress")
    check(spec["podSelector"] == {"matchLabels": {"rd/egress": f"stealth-keygen-{w}"}}, f"{w}: selects rd/egress=stealth-keygen-{w} only, got {spec['podSelector']}")
    rules = spec["egress"]
    check(len(rules) == 1 and rules[0]["ports"] == [{"protocol": "TCP", "port": 6443}], f"{w}: one rule, TCP 6443 only (no DNS: the API address comes from the Service env), got {rules}")
    check([t for t in rules[0]["to"]] == [{"ipBlock": {"cidr": f"{i}/32"}} for i in IPS], f"{w}: destinations are exactly the kube API ENDPOINT IPs /32, got {rules[0]['to']}")
    # union equality: the baseline-style allow-all does not select the pod (rd/egress-locked), only the own policy does
    baseline = {"podSelector": {"matchExpressions": [{"key": "rd/egress-locked", "operator": "DoesNotExist"}]}, "policyTypes": ["Egress"], "egress": [{}]}
    pols = [("allow-dns-egress", baseline), (np["metadata"]["name"], spec)]
    u = [n for n, s in pols if sel(s["podSelector"], plab)]
    check(u == [np["metadata"]["name"]], f"{w}: union of Egress policies selecting the Job pod labels is exactly [own policy], got {u}")
    check(run(w, "--image", IMG, *kube_args()).stdout == run(w, "--image", IMG, *kube_args()).stdout, f"{w}: deterministic output")


# probe profile (Q-v3-2): exact labels of the Job pod's policy; the kube API endpoint :6443 is the OPEN control, everything else BLOCKED
def probe(w, *a): return docs("probe", w, "--image", IMG, *a)
for w, (ns, secret, kinds) in WL.items():
    pods = probe(w, "--target", "1.1.1.1:443", "--target", "10.0.0.10:53", "--control", f"{IPS[0]}:6443")
    check(len(pods) == 1 and pods[0]["kind"] == "Pod" and pods[0]["metadata"]["name"] == "egress-negative-probe" and pods[0]["metadata"]["namespace"] == ns, f"{w}: probe is one Pod egress-negative-probe in {ns}")
    if len(pods) != 1: continue
    pp = pods[0]; pl = pp["metadata"]["labels"]; psp = pp["spec"]
    job = [d for d in docs(w, "--image", IMG, *kube_args()) if d["kind"] == "Job"][0]; np_ = [d for d in docs(w, "--image", IMG, *kube_args()) if d["kind"] == "NetworkPolicy"][0]
    check(pl.get("rd/egress-locked") == "true" and pl.get("rd/egress") == f"stealth-keygen-{w}", f"{w}: probe carries the Job pod's policy labels rd/egress-locked + rd/egress, got {pl}")
    check(pl.get("app") != "stealth-keygen" and "role" not in pl, f"{w}: probe does not carry the Job's app/role labels (never adopted by anything)")
    baseline = {"podSelector": {"matchExpressions": [{"key": "rd/egress-locked", "operator": "DoesNotExist"}]}}
    pols = [("allow-dns-egress", baseline), (np_["metadata"]["name"], np_["spec"])]
    jl = job["spec"]["template"]["metadata"]["labels"]
    check([n for n, s in pols if sel(s["podSelector"], pl)] == [n for n, s in pols if sel(s["podSelector"], jl)] == [np_["metadata"]["name"]], f"{w}: union equality: probe labels and Job pod labels are both selected by exactly [own policy]")
    check(psp.get("automountServiceAccountToken") is False and "serviceAccountName" not in psp, f"{w}: probe has no ServiceAccount token")
    check(not psp.get("volumes"), f"{w}: probe mounts nothing")
    cmd = psp["containers"][0]["command"][-1]
    check("echo T1 OPEN; else echo T1 BLOCKED" in cmd and "echo T2 BLOCKED" in cmd and f"nc -w 3 {IPS[0]} 6443" in cmd and "echo CONTROL BLOCKED" in cmd and "1.1.1.1 443" in cmd and "10.0.0.10 53" in cmd, f"{w}: probe command tests T1,T2 then the :6443 CONTROL")
    check(psp["containers"][0]["image"] == IMG and psp["restartPolicy"] == "Never" and psp["activeDeadlineSeconds"] <= 60, f"{w}: probe image pinned, Never, deadline <= 60 s")
    check(psp["containers"][0]["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{w}: probe container hardened")

# refusals (rc != 0)
def refuse(why, *a):
    r = run(*a); check(r.returncode != 0 and r.stdout == "", f"must refuse ({why}): {a} rc={r.returncode}")
refuse("no kube API IP", "cert", "--image", IMG)
refuse("tag, not digest", "cert", "--image", "ghcr.io/x/y:latest", *kube_args())
refuse("digest-less ref", "cert", "--image", "ghcr.io/x/y", *kube_args())
refuse("ClusterIP/hostname, not an IPv4", "cert", "--image", IMG, "--kube-api-ip", "kubernetes.default.svc")
refuse("cidr instead of an address", "cert", "--image", IMG, "--kube-api-ip", "10.0.0.0/8")
refuse("octet out of range", "cert", "--image", IMG, "--kube-api-ip", "300.1.1.1")
refuse("unknown workload (issuerKey is COPIED, never generated)", "issuer", "--image", IMG, *kube_args())
refuse("unknown option", "cert", "--image", IMG, *kube_args(), "--extra")
refuse("no args", )
refuse("probe without a target", "probe", "cert", "--image", IMG, "--control", f"{IPS[0]}:6443")
refuse("probe control must be an IPv4:6443 (the allowed path), not DNS", "probe", "cert", "--image", IMG, "--target", "1.1.1.1:443", "--control", "kube-dns.kube-system.svc.cluster.local:53")
refuse("probe control on another port", "probe", "cert", "--image", IMG, "--target", "1.1.1.1:443", "--control", f"{IPS[0]}:443")
refuse("probe tag image", "probe", "cert", "--image", "ghcr.io/x/y:1", "--target", "1.1.1.1:443", "--control", f"{IPS[0]}:6443")
refuse("probe hostname target", "probe", "cert", "--image", IMG, "--target", "example.com:443", "--control", f"{IPS[0]}:6443")
refuse("probe unknown workload", "probe", "issuer", "--image", IMG, "--target", "1.1.1.1:443", "--control", f"{IPS[0]}:6443")
refuse("probe too many targets", "probe", "cert", "--image", IMG, *sum((["--target", f"1.1.1.{i}:443"] for i in range(5)), []), "--control", f"{IPS[0]}:6443")
refuse("bad pull secret name", "cert", "--image", IMG, *kube_args(), "--pull-secret", "Bad_Name")
for w in WL:
    ok = docs(w, "--image", IMG, *kube_args(), "--pull-secret", "ghcr-pull")
    j = [d for d in ok if d["kind"] == "Job"]
    check(j and j[0]["spec"]["template"]["spec"].get("imagePullSecrets") == [{"name": "ghcr-pull"}], f"{w}: --pull-secret renders imagePullSecrets")
if fails:
    print("\n".join("FAIL: " + f for f in fails)); sys.exit(1)
print(f"OK stealth keygen: {len(WL)} workloads, objects/Role/NetworkPolicy/Job/union/refusals checked")
