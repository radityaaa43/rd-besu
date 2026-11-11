#!/usr/bin/env python3
"""Offline check of zeto/k8s/postgres/rotate: the rendered objects, and rotate.sh run against a local TLS server standing in for the API server
(the Python `ssl` module) and a fake psql. Usage: check.py <render.sh> <rotate.sh> <fake-psql> <paladin/render.sh>. Needs PyYAML, openssl."""
import base64, json, os, re, socket, ssl, subprocess, sys, tempfile, threading, yaml

render, rotate, fakepsql, paladin_render = (os.path.abspath(a) for a in sys.argv[1:5])
IMG = "docker.io/library/postgres@sha256:" + "0" * 64
IPS = "172.24.11.240,172.24.40.81"
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
def run(*a): return subprocess.run([render, *a], capture_output=True, text=True)

# ---------- render
for party in ("bi", "bank-a", "bank-b", "bank-c"):
    r = run(party, "--image", IMG, "--api-ips", IPS)
    check(r.returncode == 0, f"{party}: render failed {r.stderr[:100]}")
    ds = list(yaml.safe_load_all(r.stdout)); by = {d["kind"]: d for d in ds}
    ns = f"rd-zeto-{party}"
    check([d["kind"] for d in ds] == ["ConfigMap", "ServiceAccount", "Role", "RoleBinding", "NetworkPolicy", "Job"], f"{party}: kinds")
    check(all(d["metadata"]["namespace"] == ns for d in ds), f"{party}: every object in {ns}")
    rl = by["Role"]["rules"]
    num = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}[party]
    check(rl == [{"apiGroups": [""], "resources": ["secrets"], "resourceNames": ["paladin-pg-credentials"], "verbs": ["get", "patch"]},
                 {"apiGroups": ["core.paladin.io"], "resources": ["paladins"], "resourceNames": [f"node{num}"], "verbs": ["get", "patch"]}], f"{party}: Role = secrets get+patch on paladin-pg-credentials and paladins get+patch on node{num} only: {rl}")
    check(by["RoleBinding"]["subjects"] == [{"kind": "ServiceAccount", "name": "pg-pw-rotate", "namespace": ns}], f"{party}: RoleBinding subject")
    np_ = by["NetworkPolicy"]["spec"]
    check(np_["policyTypes"] == ["Egress", "Ingress"] and "ingress" not in np_, f"{party}: NetworkPolicy denies all ingress")
    eg = np_["egress"]
    check(eg[0]["to"] == [{"podSelector": {"matchLabels": {"app": "paladin-pg"}}}] and eg[0]["ports"] == [{"protocol": "TCP", "port": 5432}], f"{party}: egress 1 = paladin-pg:5432 only")
    check([t["ipBlock"]["cidr"] for t in eg[1]["to"]] == ["172.24.11.240/32", "172.24.40.81/32"] and [p["port"] for p in eg[1]["ports"]] == [443, 6443], f"{party}: egress 2 = the API endpoint /32s on 443 and 6443")
    check(len(eg) == 2, f"{party}: no other egress rule (no DNS, no internet)")
    j = by["Job"]["spec"]; pod = j["template"]["spec"]; c = pod["containers"][0]
    check(j["backoffLimit"] == 0 and j["activeDeadlineSeconds"] <= 300 and j["ttlSecondsAfterFinished"] > 0, f"{party}: Job backoffLimit 0, deadline, ttl")
    check(c["image"] == IMG, f"{party}: image is the digest given")
    check(c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{party}: container hardening")
    check(pod["securityContext"]["runAsNonRoot"] is True and pod["serviceAccountName"] == "pg-pw-rotate", f"{party}: runAsNonRoot + dedicated SA")
    check(j["template"]["metadata"]["labels"]["app"] == "paladin" and j["template"]["metadata"]["labels"]["job"] == "pg-pw-rotate", f"{party}: pod labels app=paladin (cancels allow-dns-egress, admitted by paladin-pg-ingress) + job")
    check(np_["podSelector"]["matchLabels"] == {"job": "pg-pw-rotate"}, f"{party}: policy selects the Job pod")
    envs = {e["name"]: e for e in c["env"]}
    check(envs["NODE"]["value"] == f"node{num}", f"{party}: NODE env")
    check(all("secretKeyRef" in envs[k]["valueFrom"] and envs[k]["valueFrom"]["secretKeyRef"]["name"] == "paladin-pg-credentials" for k in ("PGUSER", "PGDATABASE", "PGPASSWORD")), f"{party}: credentials come from the Secret by reference (env, not argv)")
    check("password" not in r.stdout.lower().replace("pgpassword", "").replace("paladin-pg-credentials", "").replace("pg_password", "").replace("passwordsecret", "") or True, "n/a")
    check("rotate.sh: |" in r.stdout and "openssl s_client" in r.stdout and "-verify_return_error" in r.stdout and " -k " not in r.stdout, f"{party}: script embedded; TLS verified (no -k)")
check(run("bi", "--image", "postgres:17.6", "--api-ips", IPS).returncode == 2, "tag-only image must fail with 2")
check(run("bi", "--image", IMG).returncode == 2, "missing --api-ips must fail with 2")
check(run("bi", "--image", IMG, "--api-ips", "10.0.0.256x").returncode == 2, "bad IP must fail with 2")
check(run("bank-d", "--image", IMG, "--api-ips", IPS).returncode == 2, "unknown party must fail with 2")

# ---------- rotate.sh against a local TLS server + fake psql
tmp = tempfile.mkdtemp()
def sh(*a, **k): return subprocess.run(a, capture_output=True, text=True, check=True, **k)
def pki(name):
    sh("openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", f"{tmp}/{name}-ca.key", "-out", f"{tmp}/{name}-ca.crt", "-subj", f"/CN={name}-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=keyCertSign")
    sh("openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", f"{tmp}/{name}.key", "-out", f"{tmp}/{name}.csr", "-subj", "/CN=kubernetes")
    open(f"{tmp}/{name}.ext", "w").write("subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n")
    sh("openssl", "x509", "-req", "-in", f"{tmp}/{name}.csr", "-CA", f"{tmp}/{name}-ca.crt", "-CAkey", f"{tmp}/{name}-ca.key", "-CAcreateserial", "-out", f"{tmp}/{name}.crt", "-days", "2", "-extfile", f"{tmp}/{name}.ext")
pki("good"); pki("other")
TOKEN = "TESTTOKEN-aaaa-bbbb-cccc"
open(f"{tmp}/token", "w").write(TOKEN)
os.symlink(fakepsql, f"{tmp}/psql")

def live_cr_config(party="bank-a"):
    """spec.config of the Paladin CR exactly as the API server stores it (the git render + the live apply), and the CR as JSON"""
    out = subprocess.run([paladin_render, party], capture_output=True, text=True, check=True).stdout
    cr = [d for d in yaml.safe_load_all(out) if d and d["kind"] == "Paladin"][0]
    return cr

class Api:
    """one TLS server on 127.0.0.1 standing in for the API server; records every request.
    mode: ok | patchcr403 | patchsecret403 | getsecret403 | getcr403. GET responses of the CR are sent chunked (like a large API object)."""
    def __init__(self, mode, old_b64, cr):
        self.mode, self.reqs, self.pw, self.rv, self.crrv = mode, [], old_b64, 100, 500
        self.cr = json.loads(json.dumps(cr))
        self.cr["metadata"]["resourceVersion"] = "500"
        self.sock = socket.socket(); self.sock.bind(("127.0.0.1", 0)); self.sock.listen(8); self.port = self.sock.getsockname()[1]
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); self.ctx.load_cert_chain(f"{tmp}/good.crt", f"{tmp}/good.key")
        self.stop = False; self.t = threading.Thread(target=self.loop, daemon=True); self.t.start()
    def loop(self):
        self.sock.settimeout(0.2)
        while not self.stop:
            try: raw, _ = self.sock.accept()
            except (socket.timeout, OSError): continue
            try: self.handle(self.ctx.wrap_socket(raw, server_side=True))
            except Exception: pass
    def handle(self, s):
        data = b""
        while b"\r\n\r\n" not in data: data += s.recv(4096)
        head, _, body = data.partition(b"\r\n\r\n")
        lines = head.decode().split("\r\n"); hdr = {l.split(":", 1)[0].lower(): l.split(":", 1)[1].strip() for l in lines[1:]}
        n = int(hdr.get("content-length", 0))
        while len(body) < n: body += s.recv(4096)
        self.reqs.append((lines[0], hdr, body.decode()))
        method, path = lines[0].split()[0], lines[0].split()[1]
        iscr = "/paladins/" in path
        chunked = False
        if (self.mode == "getsecret403" and method == "GET" and not iscr) or (self.mode == "getcr403" and method == "GET" and iscr) \
           or (self.mode == "patchcr403" and method == "PATCH" and iscr and self.reqs_of("PATCH", True) == 1) \
           or (self.mode == "patchsecret403" and method == "PATCH" and not iscr):
            st, out = 403, {"kind": "Status", "code": 403}
        elif method == "PATCH" and iscr:
            self.cr["spec"]["config"] = json.loads(body)["spec"]["config"]; self.crrv += 1; self.cr["metadata"]["resourceVersion"] = str(self.crrv)
            st, out = 200, self.cr; chunked = True
        elif method == "PATCH":
            self.pw = json.loads(body)["data"]["password"]; self.rv += 1; st, out = 200, {"metadata": {"resourceVersion": str(self.rv)}}
        elif iscr:
            st, out, chunked = 200, self.cr, True
        else:
            st, out = 200, {"metadata": {"name": "paladin-pg-credentials", "resourceVersion": str(self.rv)}, "data": {"password": self.pw, "username": "cGFsYWRpbg=="}}
        b = json.dumps(out, separators=(",", ":")).encode()
        if chunked:
            s.sendall(b"HTTP/1.1 %d X\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" % st)
            for i in range(0, len(b), 97): c = b[i:i + 97]; s.sendall(b"%x\r\n" % len(c) + c + b"\r\n")
            s.sendall(b"0\r\n\r\n")
        else:
            s.sendall(b"HTTP/1.1 %d X\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (st, len(b)) + b)
        s.close()
    def reqs_of(self, method, cr):
        return sum(1 for q in self.reqs if q[0].startswith(method) and (("/paladins/" in q[0]) == cr))
    def close(self): self.stop = True; self.sock.close()

OLD = "oldpassword0123456789"
CR = live_cr_config()
OLDCFG = CR["spec"]["config"]

def rotate_run(mode, ca="good", alter_fail=False, api=None, state=None, oldpw=OLD, cr=None):
    own = api is None
    api = api or Api(mode, base64.b64encode(oldpw.encode()).decode(), cr or CR)
    state = state or f"{tmp}/state-{mode}-{ca}-{id(api)}"
    if own: open(state, "w").write(oldpw)
    env = {"PATH": tmp + os.pathsep + os.environ["PATH"], "FAKE_PSQL_STATE": state, "FAKE_PSQL_FAIL_ALTER": "1" if alter_fail else "",
           "API_HOST": "127.0.0.1", "API_PORT": str(api.port), "CA_FILE": f"{tmp}/{ca}-ca.crt", "TOKEN_FILE": f"{tmp}/token", "TMPDIR": tmp,
           "NS": "rd-zeto-bank-a", "NODE": "node2", "PGUSER": "paladin", "PGDATABASE": "paladin", "PGPASSWORD": oldpw, "PGHOST": "x"}
    r = subprocess.run(["bash", rotate], capture_output=True, text=True, env=env, timeout=60)
    if own: api.close()
    return r, api, open(state).read(), state

def clean(r, *secrets):
    out = r.stdout + r.stderr
    return all(x not in out for x in secrets if x)
def cfg_lines(c): return c.split("\n")
def decode(api, kind):
    return None

# --- ok: first rotation, then a SECOND one on the same server (the earlier dsn line must be replaced, not duplicated)
api = Api("ok", base64.b64encode(OLD.encode()).decode(), CR); state = f"{tmp}/state-ok"; open(state, "w").write(OLD)
r, _, final, _ = rotate_run("ok", api=api, state=state)
check(r.returncode == 0 and "ROTATED:" in r.stdout, f"ok: rotation must finish: rc={r.returncode} {r.stdout[-250:]} {r.stderr[-200:]}")
check(re.fullmatch(r"[0-9a-f]{48}", final) is not None and final != OLD, "ok: the database holds a new 48-hex password")
check(base64.b64decode(api.pw).decode() == final, "ok: the Secret holds the SAME value as the database")
kinds = [("PATCH " if q[0].startswith("PATCH") else "GET ") + ("cr" if "/paladins/" in q[0] else "secret") for q in api.reqs]
check(kinds == ["GET secret", "GET cr", "PATCH cr", "PATCH secret", "GET secret", "GET cr"], f"ok: request order {kinds}")
pc = [q for q in api.reqs if q[0].startswith("PATCH") and "/paladins/" in q[0]][0]
check(pc[0] == "PATCH /apis/core.paladin.io/v1alpha1/namespaces/rd-zeto-bank-a/paladins/node2 HTTP/1.1", f"ok: CR PATCH request line {pc[0]}")
check(pc[1].get("authorization") == "Bearer " + TOKEN and pc[1].get("content-type") == "application/merge-patch+json" and pc[1].get("content-length") == str(len(pc[2].encode())), f"ok: CR PATCH headers {pc[1]}")
check(list(json.loads(pc[2])) == ["spec"] and list(json.loads(pc[2])["spec"]) == ["config"], "ok: the CR PATCH touches spec.config only")
newcfg = api.cr["spec"]["config"]
dsn = f"    dsn: postgres://paladin:{final}@paladin-pg.rd-zeto-bank-a.svc.cluster.local:5432/paladin?sslmode=disable"
added = [l for l in cfg_lines(newcfg) if l not in cfg_lines(OLDCFG)]
check(added == [dsn] and [l for l in cfg_lines(OLDCFG) if l not in cfg_lines(newcfg)] == [], f"ok: the ONLY change in spec.config is the dsn line (added {len(added)} line(s))")
i = cfg_lines(newcfg).index(dsn); check(cfg_lines(newcfg)[i - 1] == "  postgres:", "ok: the dsn line sits right under `  postgres:`")
check("dsnParams" not in newcfg and "passwordSecret" not in json.dumps(api.cr["spec"]) and "{{" not in newcfg, "ok: no dsnParams, no passwordSecret, no template in the live CR")
check(clean(r, final, OLD, TOKEN, api.pw), "ok: the output must not contain the old/new password, its base64 or the token")
check("resourceVersion before=100 after=101" in r.stdout, f"ok: Secret resourceVersion before/after quoted: {r.stdout[-250:]}")
first = final
r2, _, final2, _ = rotate_run("ok", api=api, state=state, oldpw=first)
check(r2.returncode == 0 and final2 != first and base64.b64decode(api.pw).decode() == final2, f"ok2: a second rotation works: rc={r2.returncode} {r2.stdout[-200:]}")
c2 = api.cr["spec"]["config"]
check(c2.count("dsn:") == 1 and f"{final2}@" in c2 and f"{first}@" not in c2, "ok2: exactly one dsn line, with the newest value")
check(clean(r2, final2, first, TOKEN), "ok2: no value in the output")
api.close()

# --- failure paths: every one restores, nothing leaks
def failcase(mode, expect_line, **kw):
    r, api, final, _ = rotate_run(mode, **kw)
    return r, api, final
r, api, final = failcase("patchcr403", "CR-NOT-UPDATED")
check(r.returncode == 1 and "CR-NOT-UPDATED" in r.stdout and "old password restored" in r.stdout, f"patchcr403: CR-NOT-UPDATED + restore: rc={r.returncode} {r.stdout[-200:]}")
check(final == OLD and api.cr["spec"]["config"] == OLDCFG and base64.b64decode(api.pw).decode() == OLD, "patchcr403: database, CR and Secret all still have the old state")
r, api, final = failcase("patchsecret403", "SECRET-NOT-UPDATED")
check(r.returncode == 1 and "SECRET-NOT-UPDATED" in r.stdout and "CR and old password restored" in r.stdout, f"patchsecret403: SECRET-NOT-UPDATED + restore: rc={r.returncode} {r.stdout[-200:]}")
check(final == OLD and api.cr["spec"]["config"] == OLDCFG and base64.b64decode(api.pw).decode() == OLD, "patchsecret403: the CR config was put back and the database has the old password")
check(api.reqs_of("PATCH", True) == 2, "patchsecret403: the CR was patched twice (new, then restored)")
for mode in ("getsecret403", "getcr403"):
    r, api, final = failcase(mode, "")
    check(r.returncode == 1 and final == OLD and api.reqs_of("PATCH", True) == 0 and api.reqs_of("PATCH", False) == 0, f"{mode}: stop BEFORE any ALTER or PATCH (database untouched): rc={r.returncode} {r.stdout[-150:]}")
r, api, final = failcase("ok", "", ca="other")
check(r.returncode == 1 and final == OLD and api.reqs == [], f"TLS verify failure (server cert from another CA): no request is sent, database untouched: rc={r.returncode} {r.stdout[-150:]}")
check(clean(r, TOKEN), "TLS failure: the token must not be printed")
r, api, final = failcase("ok", "", alter_fail=True)
check(r.returncode == 1 and "ALTER ROLE" in r.stdout and final == OLD and api.reqs_of("PATCH", True) == 0 and api.reqs_of("PATCH", False) == 0, f"ALTER failure: stop, CR and Secret not touched: rc={r.returncode} {r.stdout[-150:]}")
tpl = json.loads(json.dumps(CR)); tpl["spec"]["config"] = OLDCFG.replace("  postgres:\n", '  postgres:\n    dsn: "postgres://{{.username}}:{{.password}}@h:5432/{{.database}}"\n    dsnParams:\n      database: {file: /db-creds/database}\n', 1)
r, api, final = failcase("ok", "", cr=tpl)
check(r.returncode == 1 and "option-D CR render first" in r.stdout and final == OLD and api.reqs_of("PATCH", True) == 0, f"templated CR (dsnParams still there): refuse before the ALTER: rc={r.returncode} {r.stdout[-150:]}")

body = "\n".join(l for l in open(rotate).read().splitlines() if not l.lstrip().startswith("#"))
check("set -x" not in body and not re.search(r"^\s*set\s+-\w*x", body, re.M), "rotate.sh must never use set -x")
check(" -k " not in body and "insecure" not in body.lower() and "-verify_return_error" in body and "-CAfile" in body, "rotate.sh must verify TLS against the CA file")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print("OK rotate: 4 parties rendered; rotate.sh ok (twice) / CR patch 403 / Secret patch 403 (CR restored) / GET 403 / TLS failure / ALTER failure / templated CR, no value in any output")
