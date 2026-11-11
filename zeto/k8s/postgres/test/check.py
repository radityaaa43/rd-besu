#!/usr/bin/env python3
"""Offline check of the rendered zeto S8 manifests (final-design/zeto/PLAN.md S8: Postgres per party).
Usage: check.py <postgres/render.sh> <compare-counts.py> <s1 render.sh>   Exit 0 = all hold; 1 = failures on stderr.
Needs PyYAML only; no cluster."""
import os, re, subprocess, sys, tempfile, yaml

render, compare, s1render = sys.argv[1:4]
PARTIES = {"bi": "rd-zeto-bi", "bank-a": "rd-zeto-bank-a", "bank-b": "rd-zeto-bank-b"}
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
    check(bool(ds), f"{party}: no objects rendered")
    if not ds:
        continue
    check(sorted(d["kind"] for d in ds) == ["NetworkPolicy", "Service", "StatefulSet"], f"{party}: kinds must be exactly Service, StatefulSet, NetworkPolicy (no Secret: no key material in git): {[d['kind'] for d in ds]}")
    for d in ds:
        m = d["metadata"]
        check(m.get("namespace") == ns, f"{party}: {d['kind']}/{m['name']} not in {ns}")
        check(m.get("labels", {}).get("part-of") == "rd-zeto" and m.get("labels", {}).get("party") == party, f"{party}: {d['kind']}/{m['name']} needs labels part-of=rd-zeto, party={party}")
    svc = of(ds, "Service")
    check(len(svc) == 1 and svc[0]["metadata"]["name"] == "paladin-pg" and svc[0]["spec"].get("type", "ClusterIP") == "ClusterIP", f"{party}: Service paladin-pg (ClusterIP) required")
    if svc:
        check([p["port"] for p in svc[0]["spec"]["ports"]] == [5432] and svc[0]["spec"]["selector"] == {"app": "paladin-pg"}, f"{party}: Service must expose 5432 and select app=paladin-pg")
    ss = of(ds, "StatefulSet")
    if len(ss) == 1:
        s = ss[0]; sp = s["spec"]; pod = sp["template"]["spec"]; c = pod["containers"][0]
        check(s["metadata"]["name"] == "paladin-pg" and sp["serviceName"] == "paladin-pg" and sp["replicas"] == 1, f"{party}: StatefulSet paladin-pg, serviceName paladin-pg, 1 replica")
        check(sp["selector"]["matchLabels"] == {"app": "paladin-pg"} and sp["template"]["metadata"]["labels"].get("app") == "paladin-pg", f"{party}: pod label app=paladin-pg")
        check(re.fullmatch(r"postgres:17\.\d+", c["image"]) is not None, f"{party}: image must be the pinned postgres:17.x line as today, got {c['image']}")
        vct = sp["volumeClaimTemplates"]
        check(len(vct) == 1 and vct[0]["spec"]["resources"]["requests"]["storage"] == "20Gi" and vct[0]["spec"]["storageClassName"] == "alicloud-essd-wffc" and vct[0]["spec"]["accessModes"] == ["ReadWriteOnce"], f"{party}: one RWO PVC template 20Gi alicloud-essd-wffc (WaitForFirstConsumer, PLAN S8)")
        env = {e["name"]: e for e in c["env"]}
        for name, key in (("POSTGRES_USER", "username"), ("POSTGRES_PASSWORD", "password"), ("POSTGRES_DB", "database")):
            ref = env.get(name, {}).get("valueFrom", {}).get("secretKeyRef", {})
            check(ref.get("name") == "paladin-pg-credentials" and ref.get("key") == key and "value" not in env.get(name, {}), f"{party}: {name} must come from Secret paladin-pg-credentials key {key}, never a literal")
        check(env.get("PGDATA", {}).get("value", "").startswith("/var/lib/postgresql/data/") and env["PGDATA"]["value"] != "/var/lib/postgresql/data", f"{party}: PGDATA must be a subdirectory of the volume (lost+found)")
        check(pod["securityContext"].get("runAsNonRoot") is True and pod["securityContext"].get("fsGroup") == 999, f"{party}: pod must run non-root with fsGroup 999")
        check(c["securityContext"].get("allowPrivilegeEscalation") is False, f"{party}: allowPrivilegeEscalation false")
        res = c["resources"]
        check(set(res.get("requests", {})) >= {"cpu", "memory"} and set(res.get("limits", {})) >= {"cpu", "memory"}, f"{party}: requests and limits for cpu and memory")
        check(res["requests"] == {"cpu": "50m", "memory": "256Mi"} and res["limits"] == {"cpu": "1", "memory": "1Gi"}, f"{party}: paladin-pg requests 50m / 256Mi (resize 2026-11-12), limits unchanged 1 / 1Gi")
        check(all(p in c for p in ("startupProbe", "livenessProbe", "readinessProbe")), f"{party}: startup, liveness and readiness probes")
        check(pod.get("automountServiceAccountToken") is False, f"{party}: no API token for the database pod")
        aff = pod.get("affinity", {})
        na = aff.get("nodeAffinity", {}).get("requiredDuringSchedulingIgnoredDuringExecution", {}).get("nodeSelectorTerms", [])
        check(any(e["key"] == "kubernetes.io/hostname" and e["operator"] == "NotIn" and sorted(e["values"]) == ["member-16033-node", "member-16034-node"] for t in na for e in t.get("matchExpressions", [])), f"{party}: nodeAffinity must keep the pod off the two nodes at 97%/85% CPU requests (hostname labels member-16033-node, member-16034-node; zeto CURRENT section 12 gives the short names)")
        pa = aff.get("podAntiAffinity", {})
        req = pa.get("requiredDuringSchedulingIgnoredDuringExecution", [])
        pref = [t["podAffinityTerm"] for t in pa.get("preferredDuringSchedulingIgnoredDuringExecution", [])]
        check(any(t["topologyKey"] == "kubernetes.io/hostname" and t.get("namespaceSelector") == {} and t["labelSelector"]["matchLabels"] == {"app": "paladin-pg"} for t in req), f"{party}: required anti-affinity against other paladin-pg pods (all namespaces) on the same node")
        check(any(t["topologyKey"] == "kubernetes.io/hostname" and t.get("namespaceSelector") == {} for t in pref), f"{party}: preferred anti-affinity against Besu pods on the same node")
    else:
        check(False, f"{party}: exactly one StatefulSet required")
    np = of(ds, "NetworkPolicy")
    if len(np) == 1:
        sp = np[0]["spec"]
        check(np[0]["metadata"]["name"] == "paladin-pg-ingress" and sp["podSelector"] == {"matchLabels": {"app": "paladin-pg"}} and sp["policyTypes"] == ["Ingress"], f"{party}: paladin-pg-ingress must select app=paladin-pg, Ingress")
        check(len(sp["ingress"]) == 1 and sp["ingress"][0]["from"] == [{"podSelector": {"matchLabels": {"app": "paladin"}}}] and sp["ingress"][0]["ports"] == [{"protocol": "TCP", "port": 5432}], f"{party}: only pods app=paladin of the same namespace, TCP 5432")
    else:
        check(False, f"{party}: exactly one NetworkPolicy required")

    # S1 allow-same-namespace would otherwise let every pod in the namespace reach the database (policies are additive)
    s1 = docs(s1render, party)
    same = [d for d in of(s1, "NetworkPolicy") if d["metadata"]["name"] == "allow-same-namespace"]
    sel = same[0]["spec"]["podSelector"].get("matchExpressions", []) if same else []
    check(any(e["key"] == "app" and e["operator"] == "NotIn" and "paladin-pg" in e["values"] for e in sel), f"{party}: S1 allow-same-namespace must exclude app=paladin-pg, else paladin-pg-ingress restricts nothing")

check(run(render, "bank-c").returncode != 0, "render.sh bank-c without --cluster 2 must fail")
check(run(render, "--cluster", "2", "bi").returncode != 0, "--cluster 2 renders bank-c only")
c2 = docs(render, "--cluster", "2", "bank-c")
check(sorted(d["kind"] for d in c2) == ["NetworkPolicy", "Service", "StatefulSet"], "bank-c: kinds must be Service, StatefulSet, NetworkPolicy")
check(all(d["metadata"].get("namespace") == "rd-zeto-bank-c" for d in c2), "bank-c: every object in rd-zeto-bank-c")
check([d for d in c2 if d["kind"] == "StatefulSet"][0]["spec"]["template"]["spec"]["containers"][0]["resources"]["requests"] == {"cpu": "50m", "memory": "256Mi"}, "bank-c: paladin-pg requests 50m / 256Mi (resize 2026-11-12)")
c2txt = yaml.safe_dump(c2)
check("alicloud-essd-wffc" not in c2txt and "storageClassName: alicloud-essd" in c2txt, "bank-c: cluster 2 has only StorageClass alicloud-essd")
check("member-160" not in c2txt and "nodeAffinity" not in c2txt, "bank-c: no cluster-1 node names in cluster 2")
c2ss = of(c2, "StatefulSet")
if c2ss:
    anti = c2ss[0]["spec"]["template"]["spec"]["affinity"]["podAntiAffinity"]
    terms = anti["requiredDuringSchedulingIgnoredDuringExecution"] + [t["podAffinityTerm"] for t in anti["preferredDuringSchedulingIgnoredDuringExecution"]]
    check(all("namespaceSelector" not in t and t.get("namespaces") == ["rd-zeto-bank-c"] for t in terms), "bank-c: affinity terms must name only ns rd-zeto-bank-c (no namespaceSelector over foreign namespaces)")
csc = docs(render, "--cluster", "2", "bank-c", "--storage-class", "fabricx-essd")
check("storageClassName: fabricx-essd" in yaml.safe_dump(csc) and "storageClassName: alicloud-essd" not in yaml.safe_dump(csc), "bank-c: --storage-class must replace the storage class")
check(run(render, "--cluster", "2", "bank-c", "--storage-class", "bad class!").returncode != 0, "bank-c: --storage-class must be a DNS-1123 name")
check(run(render, "bi", "--storage-class", "x").returncode != 0, "--storage-class is only for --cluster 2 bank-c")
c2s1 = [d for d in of(docs(s1render, "--cluster", "2", "bank-c"), "NetworkPolicy") if d["metadata"]["name"] == "allow-same-namespace"]
check(bool(c2s1) and any(e["key"] == "app" and "paladin-pg" in e["values"] for e in c2s1[0]["spec"]["podSelector"].get("matchExpressions", [])), "bank-c: S1 allow-same-namespace must exclude app=paladin-pg")
allds = docs(render, "all")
check([d["metadata"]["namespace"] for d in of(allds, "StatefulSet")] == list(PARTIES.values()), "all: one StatefulSet per party in order bi, bank-a, bank-b")

# probe: throwaway proof that only a Paladin pod reaches the database
pr = docs(render, "probe", "bank-a", "bank-b")
pods = {d["metadata"]["name"]: d for d in of(pr, "Pod")}
check(sorted(pods) == ["pgprobe-control", "pgprobe-other", "pgprobe-paladin"], f"probe: pods {sorted(pods)} != pgprobe-control, pgprobe-other, pgprobe-paladin")
if len(pods) == 3:
    check(pods["pgprobe-paladin"]["metadata"]["namespace"] == "rd-zeto-bank-a" and pods["pgprobe-paladin"]["metadata"]["labels"]["app"] == "paladin", "pgprobe-paladin: own ns, app=paladin")
    check(pods["pgprobe-control"]["metadata"]["namespace"] == "rd-zeto-bank-a" and pods["pgprobe-control"]["metadata"]["labels"]["app"] == "pgprobe-control", "pgprobe-control: own ns, app=pgprobe-control")
    check(pods["pgprobe-other"]["metadata"]["namespace"] == "rd-zeto-bank-b" and pods["pgprobe-other"]["metadata"]["labels"]["app"] == "paladin", "pgprobe-other: other ns, app=paladin (label alone must not be enough)")
    check(all(d["metadata"]["labels"].get("throwaway") == "zeto-s8-probe" for d in pr), "probe: every object carries throwaway=zeto-s8-probe")
    s = pods["pgprobe-paladin"]["spec"]["containers"][0]
    check("psql" in s["command"][-1] and "select 1" in s["command"][-1], "pgprobe-paladin must run psql 'select 1' (PLAN S8 RED)")
    check(any(e.get("valueFrom", {}).get("secretKeyRef", {}).get("name") == "paladin-pg-credentials" for e in s["env"]), "pgprobe-paladin reads the password from the Secret, never a literal")
    check(not any("value" in e and "PASSWORD" in e["name"] for p in pods.values() for e in p["spec"]["containers"][0].get("env", [])), "probe: no literal password")
    for n in ("pgprobe-control", "pgprobe-other"):
        script = pods[n]["spec"]["containers"][0]["command"][-1]
        check("timeout" in script and "BLOCKED" in script and "REFUSED" in script and "range" not in script and "for i in 1 2 3" in script, f"{n}: tcp check with timeout, REFUSED vs BLOCKED, 3 attempts")

# scratch restore: dump restored into a throwaway Postgres, never into paladin-pg
sc = docs(render, "scratch", "bank-a")
check([d["kind"] for d in sc] == ["Pod"] and sc[0]["metadata"]["name"] == "pg-scratch" and sc[0]["metadata"]["labels"].get("throwaway") == "zeto-s8-scratch", "scratch: one Pod pg-scratch labelled throwaway=zeto-s8-scratch")
if sc:
    vols = sc[0]["spec"].get("volumes", [])
    check(vols and all("emptyDir" in v for v in vols), "scratch: emptyDir only, no PVC")
    check(sc[0]["metadata"]["labels"].get("app") == "pg-scratch", "scratch: app=pg-scratch (not paladin, not paladin-pg)")

# compare-counts: side-by-side row counts, exit 1 on any difference
with tempfile.TemporaryDirectory() as t:
    def w(name, text):
        p = os.path.join(t, name); open(p, "w").write(text); return p
    a = w("a", "public.txs|10\npublic.states|4\n")
    ok = run(compare, a, w("b", "public.states|4\npublic.txs|10\n"))
    check(ok.returncode == 0, f"compare-counts: equal counts (any order) must exit 0: {ok.stderr.strip()[:200]}")
    bad = run(compare, a, w("c", "public.txs|9\npublic.states|4\n"))
    check(bad.returncode == 1 and "public.txs" in bad.stdout and "10" in bad.stdout and "9" in bad.stdout, f"compare-counts: a differing table must exit 1 and show old/new: rc={bad.returncode} {bad.stdout.strip()[:200]}")
    miss = run(compare, a, w("d", "public.txs|10\n"))
    check(miss.returncode == 1 and "public.states" in miss.stdout, "compare-counts: a table missing on one side must exit 1")
    empty = run(compare, w("e", ""), w("f", ""))
    check(empty.returncode == 2, "compare-counts: two empty inputs must exit 2 (an empty DB proves nothing)")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK all S8 assertions hold")
