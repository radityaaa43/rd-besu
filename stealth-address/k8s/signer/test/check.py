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


def cust_args(image=IMG, chain=GOOD, signers=SIGNERS):
    return ["custodian", "--image", image, "--chain-env", chain, "--bank-signers", signers]


def rejects(msg, *a):
    r = run(*a)
    check(r.returncode == 2, f"reject: {msg} must exit 2 (got {r.returncode}); stderr: {r.stderr.strip()[:120]}")
    check(r.stdout == "", f"reject: {msg} must print nothing on stdout")


def secret_items(vol):
    s = vol["secret"]
    return s["secretName"], [i["key"] for i in s["items"]], {i["mode"] if "mode" in i else s.get("defaultMode") for i in s["items"]}


def common(d, role, ns, party, plabel, label):
    """Checks shared by bank and custodian Deployments; returns (pod spec, container, env dict, vols dict)."""
    m = d["metadata"]
    check(m["namespace"] == ns, f"{label}: namespace {ns}")
    check(m["labels"].get("part-of") == "rd-stealth" and m["labels"].get("party") == plabel, f"{label}: labels part-of rd-stealth, party {plabel}")
    want = {"app": "stealth-signer", "role": role}
    check(m["labels"].get("app") == "stealth-signer" and m["labels"].get("role") == role, f"{label}: Deployment labels app=stealth-signer role={role}")
    s = d["spec"]
    check(s["replicas"] == 1, f"{label}: replicas 1")
    check(s["strategy"] == {"type": "Recreate"}, f"{label}: strategy Recreate (in-memory keys, never two pods)")
    check(s["selector"]["matchLabels"] == want, f"{label}: selector {want}")
    check(s["template"]["metadata"]["labels"] == want, f"{label}: pod labels exactly {want}")
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
        check(not any(k in (e["name"] + str(e.get("value"))).lower().replace("/rpc-jwt/private.pem", "") for k in KEYWORDS), f"{label}: env {e['name']} has no key-ish word (only the path /rpc-jwt/private.pem is allowed to say private)")
    check("envFrom" not in c, f"{label}: no envFrom")
    for k, v in CHAIN.items():
        check(env.get(k) == v, f"{label}: env {k}={v}")
    for k, v in {"RPC_URL": "http://besu-rpc:8545", "RPC_JWT_KEY_FILE": "/rpc-jwt/private.pem", "KEYS_DIR": "/keys", "TLS_DIR": "/tls", "PARTY": party, "ROLE": role}.items():
        check(env.get(k) == v, f"{label}: env {k}={v}")
    vols = {v["name"]: v for v in pod["volumes"]}
    check(set(vols) == {"keys", "tls", "rpc-jwt", "tmp"}, f"{label}: volumes exactly keys, tls, rpc-jwt, tmp (got {sorted(vols)})")
    check(all(set(v) == {"name", "secret"} or set(v) == {"name", "emptyDir"} for v in vols.values()), f"{label}: only secret/emptyDir volumes (no hostPath)")
    mounts = {m["name"]: m for m in c["volumeMounts"]}
    check({k: (m["mountPath"], m.get("readOnly", False)) for k, m in mounts.items()} == {"keys": ("/keys", True), "tls": ("/tls", True), "rpc-jwt": ("/rpc-jwt", True), "tmp": ("/tmp", False)}, f"{label}: mounts /keys /tls /rpc-jwt readOnly, /tmp writable")
    check("emptyDir" in vols.get("tmp", {}), f"{label}: tmp is emptyDir")
    check(secret_items(vols["rpc-jwt"]) == ("stealth-rpc-jwt", ["private.pem"], {0o440}), f"{label}: rpc-jwt = Secret stealth-rpc-jwt, item private.pem only, 0440")
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
    check(env.get("PORT") == "9443" and env.get("BANK_SIGNERS") == SIGNERS, "custodian: PORT 9443, BANK_SIGNERS given")
    check("CERT_URL" not in env and "CERT_SERVERNAME" not in env, "custodian: no CERT_URL/CERT_SERVERNAME")
    check(c["ports"] == [{"name": "mtls", "containerPort": 9443}], "custodian: port 9443 named mtls")
    check(all(c[k] == {"tcpSocket": {"port": 9443}} for k in ("readinessProbe", "livenessProbe")), "custodian: probes tcpSocket 9443 only (https demands a client cert)")
    check(secret_items(vols["keys"]) == ("stealth-cert-key", ["certKey"], {0o440}), "custodian: keys = Secret stealth-cert-key, item certKey only, 0440")
    check(secret_items(vols["tls"]) == ("stealth-custodian-mtls", ["server.key", "server.crt", "ca.crt"], {0o440}), "custodian: tls = Secret stealth-custodian-mtls, items server.key/server.crt/ca.crt, 0440")
    check("stealth-keys" not in yaml.dump(dep), "custodian pod never references Secret stealth-keys")
    check("imagePullSecrets" not in pod, "custodian: no imagePullSecrets without --pull-secret")
ds = docs(*cust_args(), "--pull-secret", "regcred")
check(ds and ds[0]["spec"]["template"]["spec"].get("imagePullSecrets") == [{"name": "regcred"}], "custodian: --pull-secret sets imagePullSecrets")

# rejections
r = run("bi", "--image", IMG, "--chain-env", GOOD, "--cert-url", CERT_URL)
check(r.returncode == 2 and "role bi is S10, not rendered" in r.stderr, f"reject: bi exits 2 with 'role bi is S10, not rendered' (got {r.returncode}: {r.stderr.strip()[:100]})")
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

if fails:
    print(f"FAIL: {len(fails)} assertion(s)", file=sys.stderr)
    for f in fails:
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)
print("OK: stealth signer render checks passed")
