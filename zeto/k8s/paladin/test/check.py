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

for party, n in PARTIES.items():
    ns = f"rd-zeto-{party}"
    ds = docs(party)
    check(bool(ds), f"{party}: no objects rendered")
    if not ds:
        continue
    kinds = sorted(d["kind"] for d in ds)
    check(kinds == ["ConfigMap", "Deployment", "Paladin", "Role", "RoleBinding", "ServiceAccount"], f"{party}: kinds {kinds}")
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
    check(not s.get("domains") and not s.get("registries"), f"{party}: domains/registries are static in spec.config, no label selectors to PaladinDomain/PaladinRegistry CRs")
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

if fails:
    print("\n".join(f"FAIL {f}" for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"OK zeto S9: {len(PARTIES)} parties checked")
