#!/usr/bin/env python3
"""Offline check of the stealth signer manifests (stealth-address/signer/SPEC.md "Placement (binding)", ../S17.md).
Usage: check.py <render.sh>. Exit 0 = all assertions hold; 1 = failures on stderr. Needs PyYAML; no cluster."""
import os, subprocess, sys, tempfile, yaml

render = os.path.abspath(sys.argv[1])
IMG = "registry.example/rd-stealth-signer@sha256:" + "0" * 64
CHAIN = {"CHAIN_ID": "1337", "RD": "0x" + "1" * 40, "BOND": "0x" + "2" * 40, "ANNOUNCER": "0x" + "3" * 40,
         "VALIDATOR": "0x" + "4" * 40, "DVP_FACTORY": "0x" + "5" * 40, "FROM_BLOCK": "12345"}
CERT_URL = "https://st-gw-1.rd-stealth-bi.svc.cluster.local:8550"
SIGNERS = "CN=bank-a-signer,CN=bank-b-signer"
BANKS = {"bank-a": "A", "bank-b": "B", "bank-c": "C"}
KEYWORDS = ("spendkey", "viewkey", "identitykey", "certkey", "private")
fails = []
tmp = tempfile.mkdtemp()


def check(ok, msg):
    if not ok:
        fails.append(msg)


def chain_file(name="chain.env", **over):
    d = {**CHAIN, **over}
    d = {k: v for k, v in d.items() if v is not None}
    p = os.path.join(tmp, name)
    with open(p, "w") as f:
        f.write("# public chain constants\n\n" + "".join(f"{k}={v}\n" for k, v in d.items()))
    return p


GOOD = chain_file()


def run(*a):
    try:
        return subprocess.run([render, *a], capture_output=True, text=True)
    except FileNotFoundError as e:
        return subprocess.CompletedProcess(a, 127, "", str(e))


def docs(*a):
    r = run(*a)
    if r.returncode != 0:
        fails.append(f"render.sh {' '.join(a)} exited {r.returncode}: {r.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]


def bank_args(p="bank-a", image=IMG, chain=GOOD, url=CERT_URL):
    return [p, "--image", image, "--chain-env", chain, "--cert-url", url]


def bi_args(image=IMG, chain=GOOD, url=CERT_URL):
    return ["bi", "--image", image, "--chain-env", chain, "--cert-url", url]


BI_SIGNER = "CN=stealth-signer-bi"


def cust_args(image=IMG, chain=GOOD, signers=SIGNERS):
    return ["custodian", "--image", image, "--chain-env", chain, "--bank-signers", signers, "--bi-signer", BI_SIGNER]


# S17 2026-11-12 topology: every signer pod reaches its party's validator through that party's own bank-gw-N Besu door (mTLS), never a JWT node.
GW = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}
def door(plabel):
    return f"https://bank-gw-{GW[plabel]}.rd-zeto-{plabel}.svc.cluster.local:8545"


def rejects(msg, *a):
    r = run(*a)
    check(r.returncode == 2, f"reject: {msg} must exit 2 (got {r.returncode}); stderr: {r.stderr.strip()[:120]}")
    check(r.stdout == "", f"reject: {msg} must print nothing on stdout")


def secret_items(vol):
    s = vol["secret"]
    return s["secretName"], [i["key"] for i in s["items"]], {i["mode"] if "mode" in i else s.get("defaultMode") for i in s["items"]}


def common(d, role, ns, party, plabel, label, extra=False):
    """Checks shared by bank, bi and custodian Deployments (extra: bi also mounts the viewcopies volume); returns (pod spec, container, env dict, vols dict)."""
    m = d["metadata"]
    check(m["namespace"] == ns, f"{label}: namespace {ns}")
    check(m["labels"].get("part-of") == "rd-stealth" and m["labels"].get("party") == plabel, f"{label}: labels part-of rd-stealth, party {plabel}")
    want = {"app": "stealth-signer", "role": role}
    check(m["labels"].get("app") == "stealth-signer" and m["labels"].get("role") == role, f"{label}: Deployment labels app=stealth-signer role={role}")
    s = d["spec"]
    check(s["replicas"] == 1, f"{label}: replicas 1")
    check(s["strategy"] == {"type": "Recreate"}, f"{label}: strategy Recreate (in-memory keys, never two pods)")
    check(s["selector"]["matchLabels"] == want, f"{label}: selector {want}")
    check(s["template"]["metadata"]["labels"] == {**want, "rd/egress-locked": "true", "rd/egress": "stealth-custodian" if role == "custodian" else "stealth-signer"}, f"{label}: pod labels {want} + rd/egress-locked=true (excluded from allow-dns-egress) + rd/egress=<profile> (selected by egress/render.sh)")
    pod = s["template"]["spec"]
    check(pod["automountServiceAccountToken"] is False, f"{label}: automountServiceAccountToken false")
    check(pod["securityContext"] == {"runAsNonRoot": True, "runAsUser": 10001, "fsGroup": 10001, "seccompProfile": {"type": "RuntimeDefault"}}, f"{label}: pod securityContext")
    for bad in ("hostNetwork", "hostPID", "hostIPC"):
        check(not pod.get(bad), f"{label}: no {bad}")
    check(len(pod["containers"]) == 1 and pod["containers"][0]["name"] == "signer", f"{label}: one container named signer")
    c = pod["containers"][0]
    check(c["image"] == IMG, f"{label}: image is the given digest ref")
    check(c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{label}: container securityContext")
    check(not c["securityContext"].get("privileged"), f"{label}: not privileged")
    check(c["resources"] == {"requests": {"cpu": "50m", "memory": "128Mi"}, "limits": {"memory": "512Mi"}}, f"{label}: resources")
    env = {}
    for e in c["env"]:
        check("valueFrom" not in e and "value" in e, f"{label}: env {e.get('name')} is a plain value (no valueFrom)")
        env[e["name"]] = e.get("value")
        check(not any(k in (e["name"] + str(e.get("value"))).lower() for k in KEYWORDS), f"{label}: env {e['name']} has no key-ish word")
    check("envFrom" not in c, f"{label}: no envFrom")
    for k, v in CHAIN.items():
        check(env.get(k) == v, f"{label}: env {k}={v}")
    rpc_tls = "/rpc-tls" if role == "custodian" else "/tls"
    for k, v in {"RPC_URL": door(plabel), "RPC_TLS_DIR": rpc_tls, "RPC_SERVERNAME": f"bank-gw-{GW[plabel]}", "KEYS_DIR": "/keys", "TLS_DIR": "/tls", "PARTY": party, "ROLE": role}.items():
        check(env.get(k) == v, f"{label}: env {k}={v}")
    check("RPC_JWT_KEY_FILE" not in env and "rpc-jwt" not in yaml.dump(d) and "stealth-rpc-jwt" not in yaml.dump(d), f"{label}: no JWT key, no rpc-jwt volume (the node door is bank-gw)")
    vols = {v["name"]: v for v in pod["volumes"]}
    want_vols = {"keys", "tls", "tmp"} | ({"viewcopies"} if extra else set()) | ({"rpc-tls"} if role == "custodian" else set())
    check(set(vols) == want_vols, f"{label}: volumes exactly {sorted(want_vols)} (got {sorted(vols)})")
    check(all(set(v) == {"name", "secret"} or set(v) == {"name", "emptyDir"} for v in vols.values()), f"{label}: only secret/emptyDir volumes (no hostPath)")
    mounts = {m["name"]: m for m in c["volumeMounts"]}
    want_mounts = {"keys": ("/keys", True), "tls": ("/tls", True), "tmp": ("/tmp", False)}
    if role == "custodian":
        want_mounts["rpc-tls"] = ("/rpc-tls", True)
    if extra:
        want_mounts["viewcopies"] = ("/viewcopies", True)
    check({k: (m["mountPath"], m.get("readOnly", False)) for k, m in mounts.items()} == want_mounts, f"{label}: mounts {sorted(want_mounts)}, all readOnly but /tmp")
    check("emptyDir" in vols.get("tmp", {}), f"{label}: tmp is emptyDir")
    return pod, c, env, vols


for p, party in BANKS.items():
    ns = f"rd-stealth-{p}"
    ds = docs(*bank_args(p))
    check([(d["kind"], d["metadata"]["name"]) for d in ds] == [("Deployment", "stealth-signer"), ("Service", "stealth-signer")], f"{p}: exactly Deployment + Service stealth-signer (got {[(d['kind'], d['metadata']['name']) for d in ds]})")
    if len(ds) != 2:
        continue
    dep, svc = ds
    pod, c, env, vols = common(dep, "bank", ns, party, p, p)
    check(env.get("PARTY") == party, f"{p}: PARTY={party}")
    check(env.get("PORT") == "8080" and env.get("CERT_URL") == CERT_URL and env.get("CERT_SERVERNAME") == "custodian-1", f"{p}: PORT 8080, CERT_URL given, CERT_SERVERNAME custodian-1")
    check("BANK_SIGNERS" not in env, f"{p}: no BANK_SIGNERS")
    check(c["ports"] == [{"name": "http", "containerPort": 8080}], f"{p}: port 8080 named http")
    probe = {"httpGet": {"path": "/health", "port": 8080}}
    check(all(c[k].get("httpGet") == probe["httpGet"] for k in ("readinessProbe", "livenessProbe")), f"{p}: readiness+liveness httpGet /health 8080")
    check(secret_items(vols["keys"]) == ("stealth-keys", ["spendKey", "viewKey", "identityKey"], {0o440}), f"{p}: keys = Secret stealth-keys, items spendKey/viewKey/identityKey only, 0440")
    check(secret_items(vols["tls"]) == ("stealth-signer-mtls", ["client.key", "client.crt", "ca.crt"], {0o440}), f"{p}: tls = Secret stealth-signer-mtls, items client.key/client.crt/ca.crt, 0440")
    check("stealth-cert-key" not in yaml.dump(dep), f"{p}: bank pod never references Secret stealth-cert-key")
    check("imagePullSecrets" not in pod, f"{p}: no imagePullSecrets without --pull-secret")
    check(svc["metadata"]["namespace"] == ns and svc["metadata"]["labels"].get("part-of") == "rd-stealth" and svc["metadata"]["labels"].get("party") == p, f"{p}: Service ns + labels")
    check(svc["spec"].get("type", "ClusterIP") == "ClusterIP", f"{p}: Service ClusterIP")
    check(svc["spec"]["selector"] == {"app": "stealth-signer", "role": "bank"}, f"{p}: Service selector app+role bank")
    check(svc["spec"]["ports"] == [{"name": "http", "port": 8080, "targetPort": 8080}], f"{p}: Service port 8080 -> 8080 named http")
    check(not any(d["kind"] == "Secret" for d in ds), f"{p}: no Secret rendered")

# pull secret
ds = docs(*bank_args("bank-b"), "--pull-secret", "regcred")
check(ds and ds[0]["spec"]["template"]["spec"].get("imagePullSecrets") == [{"name": "regcred"}], "bank-b: --pull-secret sets imagePullSecrets [{name: regcred}]")

# custodian
ds = docs(*cust_args())
check([(d["kind"], d["metadata"]["name"]) for d in ds] == [("Deployment", "stealth-custodian")], f"custodian: exactly one Deployment stealth-custodian, no Service (got {[(d['kind'], d['metadata']['name']) for d in ds]})")
if ds:
    dep = ds[0]
    pod, c, env, vols = common(dep, "custodian", "rd-stealth-bi", "BI", "bi", "custodian")
    check(env.get("PORT") == "9443" and env.get("BANK_SIGNERS") == SIGNERS and env.get("BI_SIGNER") == BI_SIGNER, "custodian: PORT 9443, BANK_SIGNERS + BI_SIGNER given")
    # its own RPC client cert = its server cert (BI CA, clientAuth too), projected under the client file names
    rv = vols.get("rpc-tls", {}).get("secret", {})
    check(rv.get("secretName") == "stealth-custodian-mtls" and rv.get("items") == [{"key": "server.key", "path": "client.key"}, {"key": "server.crt", "path": "client.crt"}, {"key": "ca.crt", "path": "ca.crt"}] and rv.get("defaultMode") == 0o440,
          f"custodian: rpc-tls = stealth-custodian-mtls server.key/server.crt as client.key/client.crt + ca.crt, 0440 (got {rv})")
    check("CERT_URL" not in env and "CERT_SERVERNAME" not in env, "custodian: no CERT_URL/CERT_SERVERNAME")
    check(c["ports"] == [{"name": "mtls", "containerPort": 9443}], "custodian: port 9443 named mtls")
    check(all(c[k] == {"tcpSocket": {"port": 9443}} for k in ("readinessProbe", "livenessProbe")), "custodian: probes tcpSocket 9443 only (https demands a client cert)")
    check(secret_items(vols["keys"]) == ("stealth-cert-key", ["certKey"], {0o440}), "custodian: keys = Secret stealth-cert-key, item certKey only, 0440")
    check(secret_items(vols["tls"]) == ("stealth-custodian-mtls", ["server.key", "server.crt", "ca.crt"], {0o440}), "custodian: tls = Secret stealth-custodian-mtls, items server.key/server.crt/ca.crt, 0440")
    check("stealth-keys" not in yaml.dump(dep), "custodian pod never references Secret stealth-keys")
    check("imagePullSecrets" not in pod, "custodian: no imagePullSecrets without --pull-secret")
ds = docs(*cust_args(), "--pull-secret", "regcred")
check(ds and ds[0]["spec"]["template"]["spec"].get("imagePullSecrets") == [{"name": "regcred"}], "custodian: --pull-secret sets imagePullSecrets")

# bi (S10 signer)
ds = docs(*bi_args())
check([(d["kind"], d["metadata"]["name"]) for d in ds] == [("Deployment", "stealth-signer"), ("Service", "stealth-signer")], f"bi: exactly Deployment + Service stealth-signer (got {[(d['kind'], d['metadata']['name']) for d in ds]})")
if len(ds) == 2:
    dep, svc = ds
    pod, c, env, vols = common(dep, "bi", "rd-stealth-bi", "BI", "bi", "bi", extra=True)
    check(env.get("PARTY") == "BI" and env.get("ROLE") == "bi", "bi: PARTY=BI ROLE=bi")
    check(env.get("PORT") == "8080" and env.get("CERT_URL") == CERT_URL and env.get("CERT_SERVERNAME") == "custodian-1", "bi: PORT 8080, CERT_URL given, CERT_SERVERNAME custodian-1")
    check(env.get("VIEWCOPIES_DIR") == "/viewcopies", "bi: env VIEWCOPIES_DIR=/viewcopies")
    check("BANK_SIGNERS" not in env, "bi: no BANK_SIGNERS")
    check(c["ports"] == [{"name": "http", "containerPort": 8080}], "bi: port 8080 named http")
    check(all(c[k] == {"httpGet": {"path": "/health", "port": 8080}} for k in ("readinessProbe", "livenessProbe")), "bi: readiness+liveness httpGet /health 8080")
    check(secret_items(vols["keys"]) == ("stealth-bi-keys", ["issuerKey", "spendKey", "viewKey"], {0o440}), "bi: keys = Secret stealth-bi-keys, items issuerKey/spendKey/viewKey only, 0440")
    check(secret_items(vols["tls"]) == ("stealth-signer-mtls", ["client.key", "client.crt", "ca.crt"], {0o440}), "bi: tls = Secret stealth-signer-mtls, items client.key/client.crt/ca.crt, 0440")
    check(vols["viewcopies"] == {"name": "viewcopies", "secret": {"secretName": "stealth-bi-viewcopies", "optional": True, "defaultMode": 0o440}}, f"bi: viewcopies = optional Secret stealth-bi-viewcopies, defaultMode 0440, no items (got {vols['viewcopies']})")
    dump = yaml.dump(dep)
    check("stealth-cert-key" not in dump and "stealth-keys" not in dump, "bi pod never references Secret stealth-cert-key or stealth-keys")
    check("imagePullSecrets" not in pod, "bi: no imagePullSecrets without --pull-secret")
    check(svc["metadata"]["namespace"] == "rd-stealth-bi" and svc["metadata"]["labels"] == {"app": "stealth-signer", "role": "bi", "part-of": "rd-stealth", "party": "bi"}, "bi: Service ns + labels")
    check(svc["spec"].get("type", "ClusterIP") == "ClusterIP", "bi: Service ClusterIP")
    check(svc["spec"]["selector"] == {"app": "stealth-signer", "role": "bi"}, "bi: Service selector app+role bi")
    check(svc["spec"]["ports"] == [{"name": "http", "port": 8080, "targetPort": 8080}], "bi: Service port 8080 -> 8080 named http")
    check(not any(d["kind"] == "Secret" for d in ds), "bi: no Secret rendered")
ds = docs(*bi_args(), "--pull-secret", "regcred")
check(ds and ds[0]["spec"]["template"]["spec"].get("imagePullSecrets") == [{"name": "regcred"}], "bi: --pull-secret sets imagePullSecrets")
# the bank and custodian renders carry no viewcopies volume or VIEWCOPIES_DIR
for a in (bank_args(), cust_args()):
    ds = docs(*a)
    check(ds and "viewcopies" not in yaml.dump(ds[0]).lower(), f"{a[0]}: no viewcopies volume/env")

# compare (S11 viewing-key compare CronJob, ns rd-stealth-bi)
REGISTRY = "0x" + "6" * 40


def compare_args(image=IMG, chain=GOOD, registry=REGISTRY):
    return ["compare", "--image", image, "--chain-env", chain, "--registry", registry]


ds = docs(*compare_args())
check([(d["kind"], d["metadata"]["name"]) for d in ds] == [("CronJob", "stealth-viewkey-compare")], f"compare: exactly one CronJob stealth-viewkey-compare (got {[(d['kind'], d['metadata']['name']) for d in ds]})")
if len(ds) == 1:
    cj = ds[0]
    check(cj["apiVersion"] == "batch/v1", "compare: apiVersion batch/v1")
    check(cj["metadata"]["namespace"] == "rd-stealth-bi", "compare: namespace rd-stealth-bi")
    check(cj["metadata"]["labels"] == {"app": "stealth-viewkey", "role": "compare", "part-of": "rd-stealth", "party": "bi"}, "compare: CronJob labels")
    s = cj["spec"]
    check(s["schedule"] == "*/5 * * * *", "compare: schedule */5 * * * *")
    check(s["concurrencyPolicy"] == "Forbid", "compare: concurrencyPolicy Forbid")
    check(s["successfulJobsHistoryLimit"] == 3 and s["failedJobsHistoryLimit"] == 3, "compare: history limits 3/3")
    js = s["jobTemplate"]["spec"]
    check(js["backoffLimit"] == 0, "compare: backoffLimit 0")
    check(isinstance(js.get("activeDeadlineSeconds"), int) and js["activeDeadlineSeconds"] == 240 and js["activeDeadlineSeconds"] < 300, f"compare: activeDeadlineSeconds 240 (< the 300 s schedule; got {js.get('activeDeadlineSeconds')})")
    tpl = js["template"]
    check(tpl["metadata"]["labels"] == {"app": "stealth-viewkey", "role": "compare", "rd/egress-locked": "true", "rd/egress": "stealth-viewkey"}, "compare: pod labels app=stealth-viewkey role=compare (not admitted by the signer NetworkPolicy) + rd/egress-locked=true + rd/egress=stealth-viewkey")
    pod = tpl["spec"]
    check(pod["restartPolicy"] == "Never", "compare: restartPolicy Never")
    check(pod["automountServiceAccountToken"] is False, "compare: automountServiceAccountToken false")
    check(pod["securityContext"] == {"runAsNonRoot": True, "runAsUser": 10001, "fsGroup": 10001, "seccompProfile": {"type": "RuntimeDefault"}}, "compare: pod securityContext")
    for bad in ("hostNetwork", "hostPID", "hostIPC"):
        check(not pod.get(bad), f"compare: no {bad}")
    check("imagePullSecrets" not in pod, "compare: no imagePullSecrets without --pull-secret")
    check(len(pod["containers"]) == 1 and pod["containers"][0]["name"] == "compare", "compare: one container named compare")
    c = pod["containers"][0]
    check(c["image"] == IMG, "compare: image is the given digest ref")
    check(c["command"] == ["node", "--experimental-transform-types", "signer/src/compareMain.ts", "once"], f"compare: command (got {c.get('command')})")
    check(c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, "compare: container securityContext")
    check(c["resources"] == {"requests": {"cpu": "50m", "memory": "128Mi"}, "limits": {"memory": "512Mi"}}, "compare: resources")
    check("ports" not in c and "readinessProbe" not in c and "livenessProbe" not in c and "envFrom" not in c, "compare: no ports, probes or envFrom (a batch job serves nothing)")
    env = {e["name"]: e.get("value") for e in c["env"]}
    check(all("valueFrom" not in e and "value" in e for e in c["env"]), "compare: env are plain values")
    check(env == {"RPC_URL": "http://besu-rpc:8545", "RPC_TOKEN_FILE": "/rpc-jwt/token", "CHAIN_ID": CHAIN["CHAIN_ID"], "REGISTRY": REGISTRY, "VIEWCOPIES_DIR": "/viewcopies"}, f"compare: env exactly RPC_URL RPC_TOKEN_FILE CHAIN_ID REGISTRY VIEWCOPIES_DIR (got {env})")
    vols = {v["name"]: v for v in pod["volumes"]}
    check(set(vols) == {"viewcopies", "rpc-jwt", "tmp"}, f"compare: volumes exactly viewcopies, rpc-jwt, tmp (got {sorted(vols)})")
    check(vols.get("viewcopies") == {"name": "viewcopies", "secret": {"secretName": "stealth-bi-viewcopies", "optional": True, "defaultMode": 0o440}}, "compare: viewcopies = optional Secret stealth-bi-viewcopies, 0440, no items")
    check(secret_items(vols["rpc-jwt"]) == ("stealth-compare-jwt", ["token"], {0o440}), "compare: rpc-jwt = Secret stealth-compare-jwt (a read-only token), item token only, 0440")
    check("emptyDir" in vols["tmp"], "compare: tmp is emptyDir")
    check({m["name"]: (m["mountPath"], m.get("readOnly", False)) for m in c["volumeMounts"]} == {"viewcopies": ("/viewcopies", True), "rpc-jwt": ("/rpc-jwt", True), "tmp": ("/tmp", False)}, "compare: mounts viewcopies, rpc-jwt readOnly, tmp")
    dump = yaml.dump(cj)
    for bad in ("stealth-bi-keys", "stealth-keys", "stealth-cert-key", "stealth-signer-mtls", "stealth-custodian-mtls", "stealth-rpc-jwt", "private.pem", "RPC_JWT_KEY_FILE"):
        check(bad not in dump, f"compare: never references {bad} (no node key, no issuer/spend/cert key, no client cert)")
ds = docs(*compare_args(), "--pull-secret", "regcred")
check(ds and ds[0]["spec"]["jobTemplate"]["spec"]["template"]["spec"].get("imagePullSecrets") == [{"name": "regcred"}], "compare: --pull-secret sets imagePullSecrets")
rejects("compare missing --registry", "compare", "--image", IMG, "--chain-env", GOOD)
for bad in ("0x123", "6" * 40, "0x" + "g" * 40, "0x" + "6" * 41, ""):
    rejects(f"compare --registry {bad!r}", *compare_args(registry=bad))
rejects("compare missing --image", "compare", "--chain-env", GOOD, "--registry", REGISTRY)
rejects("compare non-digest image", *compare_args(image="registry.example/rd-stealth-signer:latest"))
rejects("compare missing --chain-env", "compare", "--image", IMG, "--registry", REGISTRY)
rejects("compare chain-env missing RD", *compare_args(chain=chain_file("c-m.env", RD=None)))
f = chain_file("c-x.env"); open(f, "a").write("spendKey=0x" + "a" * 64 + "\n")
rejects("compare chain-env extra key", *compare_args(chain=f))
rejects("compare with --cert-url", *compare_args(), "--cert-url", CERT_URL)
rejects("compare with --bank-signers", *compare_args(), "--bank-signers", SIGNERS)
rejects("compare bad --pull-secret", *compare_args(), "--pull-secret", "Reg_Cred")
for a in (bi_args(), bank_args(), cust_args()):
    rejects(f"{a[0]} with --registry", *a, "--registry", REGISTRY)

# rejections
rejects("bi with no further args", "bi")
rejects("bi missing --cert-url", "bi", "--image", IMG, "--chain-env", GOOD)
rejects("bi with --bank-signers", *bi_args(), "--bank-signers", SIGNERS)
rejects("bi bad --image", *bi_args(image="registry.example/rd-stealth-signer:latest"))
rejects("bi missing --chain-env", "bi", "--image", IMG, "--cert-url", CERT_URL)
rejects("bi chain-env missing RD", *bi_args(chain=chain_file("bi-m.env", RD=None)))
rejects("bi bad --cert-url", *bi_args(url="http://st-gw-1:8550"))
rejects("bi bad --pull-secret", *bi_args(), "--pull-secret", "Reg_Cred")
rejects("no arguments")
rejects("unknown party", *bank_args("bank-d"))
rejects("unknown option", *bank_args(), "--bogus", "x")
rejects("missing --image", "bank-a", "--chain-env", GOOD, "--cert-url", CERT_URL)
rejects("bad --image chars", *bank_args(image="reg ex/x@sha256:" + "0" * 64))
rejects("non-digest image", *bank_args(image="registry.example/rd-stealth-signer:latest"))
rejects("short digest", *bank_args(image="registry.example/x@sha256:" + "0" * 63))
rejects("non-hex digest", *bank_args(image="registry.example/x@sha256:" + "g" * 64))
rejects("missing --chain-env", "bank-a", "--image", IMG, "--cert-url", CERT_URL)
rejects("chain-env not a file", *bank_args(chain=os.path.join(tmp, "nope.env")))
for k in CHAIN:
    rejects(f"chain-env missing {k}", *bank_args(chain=chain_file(f"m-{k}.env", **{k: None})))
for extra in ("spendKey", "OTHER"):
    f = chain_file(f"x-{extra}.env"); open(f, "a").write(f"{extra}=0x{'a' * 64}\n")
    rejects(f"chain-env extra key {extra}", *bank_args(chain=f))
    rejects(f"chain-env extra key {extra} (custodian)", *cust_args(chain=f))
for k, bad in (("RD", "0x123"), ("RD", "1" * 40), ("BOND", "0x" + "g" * 40), ("VALIDATOR", "0x" + "1" * 41), ("CHAIN_ID", "abc"), ("CHAIN_ID", "-1"), ("FROM_BLOCK", "1x"), ("FROM_BLOCK", "")):
    r = run(*bank_args(chain=chain_file("bad.env", **{k: bad})))
    check(r.returncode == 2 and k in r.stderr, f"reject: bad {k}={bad!r} exits 2 naming {k} (got {r.returncode}: {r.stderr.strip()[:100]})")
rejects("missing --cert-url", "bank-a", "--image", IMG, "--chain-env", GOOD)
for bad in ("http://st-gw-1.rd-stealth-bi:8550", "https://host:8550/cert", "https://host :8550", "https://", "st-gw-1:8550", "https://host:abc", "https://host/"):
    rejects(f"--cert-url {bad!r}", *bank_args(url=bad))
rejects("custodian missing --bank-signers", "custodian", "--image", IMG, "--chain-env", GOOD)
for bad in ("a", "CN=a b", "CN=a,", "CN=a,b", "CN=", "CN=a;CN=b"):
    rejects(f"--bank-signers {bad!r}", *cust_args(signers=bad))
rejects("custodian with --cert-url", *cust_args(), "--cert-url", CERT_URL)
rejects("bank with --bank-signers", *bank_args(), "--bank-signers", SIGNERS)
for bad in ("Reg_Cred", "-x", "x.", ""):
    rejects(f"--pull-secret {bad!r}", *bank_args(), "--pull-secret", bad)

# S11 rework D3: bi --viewcopy-store = ServiceAccount stealth-bi-signer with a mounted token (the Role on ONE Secret is rbac/render.sh); without the flag nothing changes
base_bi = docs(*bi_args())
vs = docs(*bi_args(), "--viewcopy-store", "--registry", REGISTRY)
if len(vs) == 2 and len(base_bi) == 2:
    vpod = vs[0]["spec"]["template"]["spec"]
    # S17 2026-11-13: PUT /viewcopy checks the pushed copy against the ERC-6538 registry, so the store needs REGISTRY
    venv = {e["name"]: e["value"] for e in vpod["containers"][0]["env"]}
    check(venv.get("REGISTRY") == REGISTRY, f"bi --viewcopy-store --registry: env REGISTRY set (got {venv.get('REGISTRY')})")
    vpod["containers"][0]["env"] = [e for e in vpod["containers"][0]["env"] if e["name"] != "REGISTRY"]
    check(vpod.get("serviceAccountName") == "stealth-bi-signer" and vpod["automountServiceAccountToken"] is True, f"bi --viewcopy-store: serviceAccountName stealth-bi-signer + automountServiceAccountToken true (got {vpod.get('serviceAccountName')}, {vpod.get('automountServiceAccountToken')})")
    vs_norm = yaml.safe_load(yaml.dump(vs))
    vs_norm[0]["spec"]["template"]["spec"].pop("serviceAccountName", None)
    vs_norm[0]["spec"]["template"]["spec"]["automountServiceAccountToken"] = False
    check(vs_norm == base_bi, "bi --viewcopy-store: ONLY serviceAccountName + automountServiceAccountToken differ from the plain bi render")
else:
    check(False, "bi --viewcopy-store renders Deployment + Service")
check("serviceAccountName" not in base_bi[0]["spec"]["template"]["spec"] and base_bi[0]["spec"]["template"]["spec"]["automountServiceAccountToken"] is False, "bi without the flag: no ServiceAccount, no token")
for a in (bank_args(), cust_args(), compare_args()):
    rejects(f"{a[0]} with --viewcopy-store", *a, "--viewcopy-store")
rejects("bi --viewcopy-store with a value", *bi_args(), "--viewcopy-store", "yes")
rejects("bi --viewcopy-store without --registry", *bi_args(), "--viewcopy-store")
rejects("bi --registry without --viewcopy-store", *bi_args(), "--registry", REGISTRY)

# S11 rework D2: viewpush = the one-off Job that pushes THIS bank's view key to BI's door
DOOR = "https://st-gw-1.rd-stealth-bi.svc.cluster.local:8550"


def vp_args(p="bank-a", image=IMG, door=DOOR):
    return ["viewpush", p, "--image", image, "--door-url", door]


for p, party in BANKS.items():
    ns = f"rd-stealth-{p}"
    ds = docs(*vp_args(p))
    check([(d["kind"], d["metadata"]["name"]) for d in ds] == [("Job", "stealth-viewpush")], f"viewpush {p}: exactly one Job stealth-viewpush, no Service/Secret (got {[(d['kind'], d['metadata']['name']) for d in ds]})")
    if len(ds) != 1:
        continue
    job = ds[0]
    check(job["apiVersion"] == "batch/v1" and job["metadata"]["namespace"] == ns, f"viewpush {p}: batch/v1 in {ns}")
    check(job["metadata"]["labels"] == {"app": "stealth-viewpush", "role": "viewpush", "part-of": "rd-stealth", "party": p}, f"viewpush {p}: Job labels")
    js = job["spec"]
    check(js["backoffLimit"] == 0 and js["ttlSecondsAfterFinished"] == 600 and js["activeDeadlineSeconds"] == 120, f"viewpush {p}: backoffLimit 0, ttlSecondsAfterFinished 600, activeDeadlineSeconds 120")
    check(js["template"]["metadata"]["labels"] == {"app": "stealth-viewpush", "role": "viewpush", "rd/egress-locked": "true", "rd/egress": "stealth-viewpush"}, f"viewpush {p}: pod labels incl. rd/egress-locked=true + rd/egress=stealth-viewpush, and NOT app=stealth-signer (no Service selects it)")
    pod = js["template"]["spec"]
    check(pod["restartPolicy"] == "Never" and pod["automountServiceAccountToken"] is False and "serviceAccountName" not in pod, f"viewpush {p}: restartPolicy Never, no SA token")
    check(pod["securityContext"] == {"runAsNonRoot": True, "runAsUser": 10001, "fsGroup": 10001, "seccompProfile": {"type": "RuntimeDefault"}}, f"viewpush {p}: pod securityContext")
    for bad in ("hostNetwork", "hostPID", "hostIPC"):
        check(not pod.get(bad), f"viewpush {p}: no {bad}")
    check(len(pod["containers"]) == 1 and pod["containers"][0]["name"] == "viewpush", f"viewpush {p}: one container named viewpush")
    c = pod["containers"][0]
    check(c["image"] == IMG and c["command"] == ["node", "--experimental-transform-types", "signer/src/pushViewCopy.ts", p], f"viewpush {p}: digest image, command pushViewCopy.ts <own id> (live 2026-11-13: without the id the Job exits with usage) (got {c.get('command')})")
    check(c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"viewpush {p}: container securityContext")
    check(c["resources"] == {"requests": {"cpu": "50m", "memory": "128Mi"}, "limits": {"memory": "256Mi"}}, f"viewpush {p}: resources")
    check("ports" not in c and "readinessProbe" not in c and "livenessProbe" not in c and "envFrom" not in c, f"viewpush {p}: no ports, probes or envFrom")
    check(all("valueFrom" not in e and "value" in e for e in c["env"]), f"viewpush {p}: env are plain values")
    env = {e["name"]: e["value"] for e in c["env"]}
    check(env == {"PARTY": party, "KEYS_DIR": "/keys", "TLS_DIR": "/tls", "SIGNER_URL": "http://stealth-signer:8080", "DOOR_URL": DOOR, "DOOR_SERVERNAME": "viewcopy-1"}, f"viewpush {p}: env exactly PARTY KEYS_DIR TLS_DIR SIGNER_URL DOOR_URL DOOR_SERVERNAME (got {env})")
    vols = {v["name"]: v for v in pod["volumes"]}
    check(set(vols) == {"keys", "tls", "tmp"}, f"viewpush {p}: volumes exactly keys, tls, tmp (got {sorted(vols)})")
    check(vols["keys"] == {"name": "keys", "secret": {"secretName": "stealth-keys", "defaultMode": 0o440, "items": [{"key": "viewKey", "path": "viewKey"}]}}, f"viewpush {p}: keys = Secret stealth-keys projecting items [viewKey] ONLY (got {vols.get('keys')})")
    check(secret_items(vols["tls"]) == ("stealth-signer-mtls", ["client.key", "client.crt", "ca.crt"], {0o440}) and "emptyDir" in vols["tmp"], f"viewpush {p}: tls = Secret stealth-signer-mtls (3 items, 0440), tmp emptyDir")
    check({m["name"]: (m["mountPath"], m.get("readOnly", False)) for m in c["volumeMounts"]} == {"keys": ("/keys", True), "tls": ("/tls", True), "tmp": ("/tmp", False)}, f"viewpush {p}: mounts keys, tls readOnly, tmp")
    dump = yaml.dump(job)
    for bad in ("spendKey", "identityKey", "stealth-cert-key", "stealth-bi-keys", "stealth-rpc-jwt", "private.pem", "stealth-bi-viewcopies"):
        check(bad not in dump, f"viewpush {p}: never references {bad} (no spend/identity key path anywhere)")
    check("imagePullSecrets" not in pod, f"viewpush {p}: no imagePullSecrets without --pull-secret")
ds = docs(*vp_args("bank-b"), "--pull-secret", "regcred")
check(ds and ds[0]["spec"]["template"]["spec"].get("imagePullSecrets") == [{"name": "regcred"}], "viewpush: --pull-secret sets imagePullSecrets")
rejects("viewpush for bi", *vp_args("bi"))
rejects("viewpush for custodian", *vp_args("custodian"))
rejects("viewpush unknown bank", *vp_args("bank-d"))
rejects("viewpush with no bank", "viewpush")
rejects("viewpush missing --door-url", "viewpush", "bank-a", "--image", IMG)
rejects("viewpush missing --image", "viewpush", "bank-a", "--door-url", DOOR)
rejects("viewpush non-digest image", *vp_args(image="registry.example/rd-stealth-signer:latest"))
rejects("viewpush short digest", *vp_args(image="registry.example/x@sha256:" + "0" * 63))
for bad in ("http://st-gw-1.rd-stealth-bi:8550", "https://host:8550/viewcopy", "https://host :8550", "https://", "st-gw-1:8550", "https://host:abc"):
    rejects(f"viewpush --door-url {bad!r}", *vp_args(door=bad))
rejects("viewpush with --chain-env", *vp_args(), "--chain-env", GOOD)
rejects("viewpush with --cert-url", *vp_args(), "--cert-url", CERT_URL)
rejects("viewpush with --registry", *vp_args(), "--registry", REGISTRY)
rejects("viewpush with --bank-signers", *vp_args(), "--bank-signers", SIGNERS)
rejects("viewpush bad --pull-secret", *vp_args(), "--pull-secret", "Reg_Cred")
for a in (bi_args(), bank_args(), cust_args(), compare_args()):
    rejects(f"{a[0]} with --door-url", *a, "--door-url", DOOR)

if fails:
    print(f"FAIL: {len(fails)} assertion(s)", file=sys.stderr)
    for f in fails:
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)
print("OK: stealth signer render checks passed")
