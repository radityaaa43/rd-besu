#!/usr/bin/env python3
"""Offline check of the rendered zeto S9 manifests (final-design/zeto/PLAN.md S9: Paladin node per party).
Usage: check.py <render.sh>   Exit 0 = all assertions hold; 1 = list of failures on stderr.
Needs PyYAML only; no cluster."""
import json, os, re, subprocess, sys, yaml

render = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
PARTIES = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}  # party -> Paladin node number (Zeto owner key names bi@node1 ...)
FORK = "ghcr.io/radityaaa43/paladin@sha256:6f113f3829fefd7f954d3377935d7613ab78a90ba89c6af8e79159617b339f71"
OPERATOR = "docker.io/lfdecentralizedtrust/paladin-operator:v1.0.0@sha256:e778ee8123e0ce1e6a9efea9aacd64e139b0229cd2e112b1d3b30973cefcd9c3"
CRDS = {"besugeneses", "besus", "paladindomains", "paladinregistrations", "paladinregistries", "paladins", "smartcontractdeployments", "transactioninvokes"}
FORBIDDEN_KINDS = {"Namespace", "ClusterRole", "ClusterRoleBinding", "CustomResourceDefinition", "PaladinDomain", "PaladinRegistry",
                   "PaladinRegistration", "SmartContractDeployment", "TransactionInvoke", "Secret", "Besu", "BesuGenesis"}
fails = []


def check(ok, msg):
    if not ok:
        fails.append(msg)


def run(*args):
    return subprocess.run([render, *args], capture_output=True, text=True)


def docs(*args):
    out = run(*args)
    if out.returncode != 0:
        fails.append(f"render.sh {' '.join(args)} exited {out.returncode}: {out.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(out.stdout) if d]


def prune(v, key=None):
    """Drop zero-value leaves so a static config compares with the operator-generated one (it prints every unset field)."""
    if isinstance(v, dict):
        o = {k: prune(x, k) for k, x in v.items()}
        return {k: x for k, x in o.items() if x not in (None, "", False, {}, [])}
    if isinstance(v, list):
        return [prune(x) for x in v]
    if isinstance(v, str) and key in ("registryAddress", "contractAddress"):
        return v.lower()
    return v


live = json.load(open(os.path.join(here, "fixtures", "live-domains-registries.json")))
crd = json.load(open(os.path.join(here, "fixtures", "paladin-crd-spec.json")))  # paladin@v1.0.0 operator/config/crd/bases/core.paladin.io_paladins.yaml

for party, n in PARTIES.items():
    ns = f"rd-zeto-{party}"
    ds = docs(party)
    check(bool(ds), f"{party}: no objects rendered")
    if not ds:
        continue
    kinds = sorted(d["kind"] for d in ds)
    check(kinds == ["ConfigMap", "Deployment", "Paladin", "Role", "RoleBinding", "ServiceAccount", "StatefulSet"], f"{party}: kinds {kinds}")
    for d in ds:
        check(d["kind"] not in FORBIDDEN_KINDS, f"{party}: forbidden kind {d['kind']}")
        check(d["metadata"].get("namespace") == ns, f"{party}: {d['kind']}/{d['metadata']['name']} not in {ns}")
    by = {d["kind"]: d for d in ds}
    if len(by) != len(ds):
        continue

    # operator: namespaced only, one namespace watched, image pinned, fork digest in its ConfigMap
    role = by["Role"]
    seen = {r for rule in role["rules"] if "core.paladin.io" in rule["apiGroups"] for r in rule["resources"] if "/" not in r}
    check(seen == CRDS, f"{party}: Role core.paladin.io resources {sorted(seen)} != {sorted(CRDS)}")
    check(all("*" not in rule.get("verbs", []) and "*" not in rule.get("resources", []) for rule in role["rules"]), f"{party}: Role must not use wildcards")
    rb = by["RoleBinding"]
    check(rb["roleRef"]["kind"] == "Role" and rb["subjects"] == [{"kind": "ServiceAccount", "name": "paladin-operator", "namespace": ns}], f"{party}: RoleBinding must bind Role to SA paladin-operator in {ns}")
    dep = by["Deployment"]
    pod = dep["spec"]["template"]["spec"]
    c = pod["containers"][0]
    env = {e["name"]: e for e in c["env"]}
    check(env.get("WATCH_NAMESPACE", {}).get("valueFrom", {}).get("fieldRef", {}).get("fieldPath") == "metadata.namespace", f"{party}: WATCH_NAMESPACE must come from metadata.namespace")
    check(env.get("CONFIG_PATH", {}).get("value") == "/etc/config", f"{party}: CONFIG_PATH must be /etc/config")
    check(c["image"] == OPERATOR, f"{party}: operator image {c['image']} != {OPERATOR}")
    check(pod.get("serviceAccountName") == "paladin-operator" and dep["spec"]["replicas"] == 1, f"{party}: operator SA/replicas")
    check(c["securityContext"].get("allowPrivilegeEscalation") is False and pod.get("securityContext", {}).get("runAsNonRoot") is True, f"{party}: operator must run non-root without privilege escalation")
    cm = by["ConfigMap"]
    opcfg = json.loads(cm["data"]["config.json"])
    check(opcfg["paladin"]["image"] == FORK, f"{party}: operator config paladin image {opcfg['paladin']['image']} != fork digest")
    check(opcfg["paladin"]["labels"] == {"app": "paladin"}, f"{party}: Paladin pods must carry app=paladin (S1 rehearsal egress policy selects it)")

    # Paladin CR
    cr = by["Paladin"]
    check(cr["apiVersion"] == "core.paladin.io/v1alpha1" and cr["metadata"]["name"] == f"node{n}", f"{party}: CR must be core.paladin.io/v1alpha1 Paladin node{n}")
    s = cr["spec"]
    ep = s["baseLedgerEndpoint"]["endpoint"]
    check(ep == {"jsonrpc": f"http://besu-rpc.{ns}.svc.cluster.local:8545", "ws": f"ws://besu-rpc.{ns}.svc.cluster.local:8546"}, f"{party}: baseLedgerEndpoint {ep}")
    db = s["database"]
    check(db.get("mode") == "preConfigured" and db.get("passwordSecret") == "paladin-pg-credentials" and db.get("migrationMode") == "auto" and "pvcTemplate" not in db, f"{party}: database {db}")
    sg = s["secretBackedSigners"]
    check(sg == [{"name": "signer-1", "secret": f"node{n}.keys", "type": "autoHDWallet", "derivationType": "bip32", "keySelector": ".*", "keySelectorMustNotMatch": False}], f"{party}: secretBackedSigners {sg}")
    check(s.get("domains") == [] and s.get("registries") == [], f"{party}: domains/registries must be present and empty (CRD requires them; static in spec.config, no selectors to PaladinDomain/PaladinRegistry CRs)")
    check(set(crd["specRequired"]) <= set(s), f"{party}: CR spec lacks CRD-required fields {sorted(set(crd['specRequired']) - set(s))}")
    check(set(s) <= set(crd["specProperties"]), f"{party}: CR spec has fields unknown to the CRD {sorted(set(s) - set(crd['specProperties']))}")
    # paused stub: the operator creates its StatefulSet only if absent (paladin_controller.go:287-292) and never updates replicas (:297-306)
    sts = by["StatefulSet"]
    lab = {"app": "paladin", "app.kubernetes.io/instance": f"node{n}", "app.kubernetes.io/name": f"paladin-node{n}", "app.kubernetes.io/part-of": "paladin"}
    check(sts["metadata"]["name"] == f"paladin-node{n}" and sts["spec"]["replicas"] == 0, f"{party}: stub StatefulSet must be paladin-node{n} with replicas 0")
    check(sts["spec"]["selector"]["matchLabels"] == lab and sts["spec"]["template"]["metadata"]["labels"] == lab, f"{party}: stub selector/pod labels must equal the operator's")
    check(sts["spec"].get("serviceName", "") == "" and "ownerReferences" not in sts["metadata"], f"{party}: stub serviceName empty (as operator-created) and no ownerReference")
    check(sts["spec"]["template"]["spec"]["containers"][0]["name"] == "paladin" and sts["spec"]["template"]["spec"]["containers"][0]["image"] == FORK, f"{party}: stub container paladin with the fork digest")
    order = [d["kind"] for d in ds]
    check(order.index("StatefulSet") < order.index("Paladin"), f"{party}: stub StatefulSet must come BEFORE the Paladin CR in the render")
    tr = s.get("transports", [])
    check(len(tr) == 1 and tr[0]["name"] == "grpc" and tr[0]["plugin"] == {"type": "c-shared", "library": "/app/transports/libgrpc.so"} and "tls" not in tr[0], f"{party}: one grpc transport without tls (tls is S10)")
    check(tr and json.loads(tr[0]["configJSON"]) == {"port": 9000, "address": "0.0.0.0"}, f"{party}: transport configJSON must be port 9000 on 0.0.0.0")
    conf = yaml.safe_load(s["config"])
    check(conf.get("keyManager", {}).get("disableSignRPC") is True, f"{party}: keyManager.disableSignRPC must be true")
    check(conf.get("log", {}).get("level") == "info", f"{party}: log.level info")
    pg = conf.get("db", {}).get("postgres", {})
    check(conf.get("db", {}).get("type") == "postgres", f"{party}: db.type must be postgres (preConfigured does not set it)")
    check(pg.get("dsn") == f"postgres://{{{{.username}}}}:{{{{.password}}}}@paladin-pg.{ns}.svc.cluster.local:5432/{{{{.database}}}}?sslmode=disable", f"{party}: dsn {pg.get('dsn')}")
    check(pg.get("dsnParams", {}).get("database") == {"file": "/db-creds/database"}, f"{party}: dsnParams.database must read /db-creds/database")
    check(re.search(r"://[^{]*:[^{@]+@", str(pg.get("dsn"))) is None, f"{party}: dsn must not carry a literal password")
    # the static domain/registry config must equal what the operator generates from the live PaladinDomain/PaladinRegistry CRs
    check(prune(conf.get("domains")) == live["domains"], f"{party}: config.domains differs from live generated config")
    check(prune(conf.get("registries")) == live["registries"], f"{party}: config.registries differs from live generated config")
    check(not re.search(r"(?i)password:\s*\S|secretkey|BEGIN .*PRIVATE", yaml.safe_dump(ds)), f"{party}: rendered output must not contain a secret value")

# refusals and determinism
for bad in (["nope"], [], ["bi", "bank-a"]):
    check(run(*bad).returncode != 0, f"render.sh {' '.join(bad) or '<none>'} must exit non-zero")
a, b = run("bi").stdout, run("bi").stdout
check(a == b and a != "", "render must be deterministic")
allout = run("all")
check(allout.returncode == 0 and len([d for d in yaml.safe_load_all(allout.stdout) if d and d["kind"] == "Paladin"]) == 4, "render.sh all must emit 4 Paladin CRs")

# ---- S10a: transport LoadBalancer + TLS secret reference (PLAN S10; orchestrator: per-node CA, externalHostname = the node's own LB IP)
HOSTS = {"bi": "8.215.38.252", "bank-a": "147.139.181.201", "bank-b": "147.139.205.80", "bank-c": "203.0.113.9"}
for party, n in PARTIES.items():
    ns = f"rd-zeto-{party}"
    base = docs(party)
    withhost = docs(party, "--transport-host", HOSTS[party])
    crs = [d for d in withhost if d["kind"] == "Paladin"]
    check(len(crs) == 1 and len(withhost) == len(base), f"{party}: --transport-host must not add or drop objects")
    if crs:
        tr = crs[0]["spec"]["transports"][0]
        cj = json.loads(tr["configJSON"])
        check(cj == {"port": 9000, "address": "0.0.0.0", "externalHostname": HOSTS[party]}, f"{party}: configJSON {cj}")
        check(tr.get("tls") == {"certName": f"paladin-node{n}-mtls", "secretName": f"paladin-node{n}-mtls"}, f"{party}: tls must be exactly certName+secretName paladin-node{n}-mtls (the CRD requires both; NO issuer; the operator only creates a Certificate when the Secret is missing, paladin_controller.go:1352-1360): {tr.get('tls')}")
    check([d for d in base if d["kind"] == "Paladin"][0]["spec"]["transports"][0].get("tls") is None, f"{party}: without --transport-host there is no tls")
    net = docs("transport", party, "--external-cidr", "198.51.100.7/32")
    kinds = sorted(d["kind"] for d in net)
    check(kinds == ["NetworkPolicy", "Service"], f"{party} transport: kinds {kinds}")
    svc = [d for d in net if d["kind"] == "Service"][0]
    check(svc["metadata"]["name"] == "paladin-transport" and svc["metadata"]["namespace"] == ns and svc["spec"]["type"] == "LoadBalancer", f"{party}: Service paladin-transport LoadBalancer in {ns}")
    check([(p["port"], p["protocol"]) for p in svc["spec"]["ports"]] == [(9000, "TCP")] and svc["spec"]["ports"][0]["targetPort"] == 9000, f"{party}: only TCP 9000 (not 8549)")
    check(svc["spec"]["selector"] == {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"}, f"{party}: selector {svc['spec']['selector']}")
    check("annotations" not in svc["metadata"] and "loadBalancerSourceRanges" not in svc["spec"], f"{party}: no cloud-specific field without --acl-id")
    check(svc["spec"].get("externalTrafficPolicy") == "Cluster", f"{party}: externalTrafficPolicy Cluster must be explicit (Local broke the p2p CLB health check)")
    np = [d for d in net if d["kind"] == "NetworkPolicy"][0]
    check(np["metadata"]["name"] == "paladin-transport-ingress" and np["spec"]["podSelector"] == {"matchLabels": {"app": "paladin"}} and np["spec"]["policyTypes"] == ["Ingress"], f"{party}: policy selects app=paladin, Ingress")
    ing = np["spec"]["ingress"]
    check(len(ing) == 1 and ing[0]["ports"] == [{"protocol": "TCP", "port": 9000}], f"{party}: only TCP 9000 allowed: {ing}")
    frm = ing[0]["from"]
    check({"namespaceSelector": {"matchExpressions": [{"key": "part-of", "operator": "In", "values": ["rd-zeto"]}]}} in frm and {"ipBlock": {"cidr": "198.51.100.7/32"}} in frm, f"{party}: from must hold the rd-zeto namespaces and the --external-cidr: {frm}")
    check(not any("100.64.0.0/10" in json.dumps(f) for f in frm), f"{party}: no CLB health CIDR unless asked")
    live = docs("transport", party, "--external-cidr", "198.51.100.7/32", "--acl-id", "acl-test123", "--clb-health-cidr", "100.64.0.0/10")
    lsvc = [d for d in live if d["kind"] == "Service"][0]
    check(lsvc["metadata"]["annotations"] == {"service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-status": "on", "service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-type": "white",
          "service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id": "acl-test123", "service.beta.kubernetes.io/backend-type": "eni"}, f"{party}: ACL annotations")
    check(lsvc["spec"]["loadBalancerSourceRanges"] == ["198.51.100.7/32"], f"{party}: loadBalancerSourceRanges")
    lnp = [d for d in live if d["kind"] == "NetworkPolicy"][0]["spec"]["ingress"]
    check(len(lnp) == 2 and lnp[1]["from"] == [{"ipBlock": {"cidr": "100.64.0.0/10"}}], f"{party}: health CIDR as the second rule")
    check(run("transport", party, "--acl-id", "acl-x").returncode != 0 and run("transport", party, "--acl-id", "bad id", "--external-cidr", "1.2.3.4/32").returncode != 0, f"{party}: --acl-id needs a cidr and a valid id")
    check(run(party, "--transport-host", "bad host!").returncode != 0, f"{party}: bad --transport-host must fail")
    # probe pods (no Paladin process): listener carries the node's selector labels, client connects
    pl = docs("probe-listener", party)
    check(len(pl) == 1 and pl[0]["kind"] == "Pod" and pl[0]["metadata"]["namespace"] == ns and pl[0]["metadata"]["labels"].get("throwaway") == "zeto-s10-probe", f"{party}: probe-listener pod")
    check(pl and all(pl[0]["metadata"]["labels"].get(k) == v for k, v in {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"}.items()), f"{party}: listener must carry the transport Service selector labels")
    check(pl and "paladin" not in pl[0]["spec"]["containers"][0]["image"] and "9000" in json.dumps(pl[0]["spec"]["containers"][0]["command"]), f"{party}: listener runs nc on 9000, not a Paladin image")
pc = docs("probe-client", "bank-a", "bank-b-lb", "147.139.205.80")
check(len(pc) == 1 and pc[0]["kind"] == "Pod" and pc[0]["metadata"]["namespace"] == "rd-zeto-bank-a" and "147.139.205.80" in json.dumps(pc[0]["spec"]["containers"][0]["command"]), "probe-client: pod in the client's ns connecting to the given IP")
check(run("probe-client", "bank-a", "x", "not-an-ip").returncode != 0, "probe-client: target must be an IPv4")

# gen-certs: own CA per node, CN node<N>, SAN = the LB IP; keys never inside the repo
import tempfile, shutil
gen = os.path.join(os.path.dirname(render), "gen-certs.sh")
with tempfile.TemporaryDirectory() as td:
    out = os.path.join(td, "mtls")
    r = subprocess.run([gen, "bank-a", "147.139.181.201"], env={**os.environ, "PALADIN_MTLS_DIR": out}, capture_output=True, text=True)
    check(r.returncode == 0, f"gen-certs bank-a exit {r.returncode}: {r.stderr[-200:]}")
    if r.returncode == 0:
        files = sorted(os.listdir(out))
        check(files == ["ca.crt", "ca.key", "tls.crt", "tls.key"], f"gen-certs files {files}")
        check(all(oct(os.stat(os.path.join(out, f)).st_mode & 0o777) == "0o600" for f in files) and oct(os.stat(out).st_mode & 0o777) == "0o700", "gen-certs: dir 700, files 600")
        subj = subprocess.run(["openssl", "x509", "-in", os.path.join(out, "tls.crt"), "-noout", "-subject", "-ext", "subjectAltName"], capture_output=True, text=True).stdout
        check("CN = node2" in subj.replace("CN=node2", "CN = node2") and "147.139.181.201" in subj, f"gen-certs: CN node2 and SAN IP: {subj}")
        ver = subprocess.run(["openssl", "verify", "-CAfile", os.path.join(out, "ca.crt"), os.path.join(out, "tls.crt")], capture_output=True, text=True)
        check(ver.returncode == 0, f"gen-certs: leaf must verify against its own CA: {ver.stdout}{ver.stderr}")
        check(subprocess.run([gen, "bank-a", "147.139.181.201"], env={**os.environ, "PALADIN_MTLS_DIR": out}, capture_output=True).returncode != 0, "gen-certs: must refuse to overwrite an existing dir")
    repo_inside = os.path.join(os.path.dirname(os.path.abspath(render)), "x-mtls")
    check(subprocess.run([gen, "bank-a", "1.2.3.4"], env={**os.environ, "PALADIN_MTLS_DIR": repo_inside}, capture_output=True).returncode != 0 and not os.path.exists(repo_inside), "gen-certs: refuses a directory inside the repo")
    check(subprocess.run([gen, "bank-z", "1.2.3.4"], env={**os.environ, "PALADIN_MTLS_DIR": os.path.join(td, "z")}, capture_output=True).returncode != 0, "gen-certs: unknown party refused")

if fails:
    print("\n".join(f"FAIL {f}" for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"OK zeto S9: {len(PARTIES)} parties checked")
