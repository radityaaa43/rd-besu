#!/usr/bin/env python3 -I
"""Contract test: the reference SOURCE tar (source_tar.py) goes through the real sink.py (POST /bundles/<name>) with a THROWAWAY key on loopback.
python3 -I opa/tools/test_source_tar.py   (needs opa + openssl; no network beyond 127.0.0.1, no repo or cluster key)
Why: S21 layer 7 call 1 sent `opa build` output (rooted names) and got 400 "unsafe member name"; the sink wants a relative-name SOURCE tree."""
import gzip, hashlib, io, json, os, shutil, subprocess, sys, tarfile, tempfile, threading, unittest, urllib.error, urllib.request
from http.server import ThreadingHTTPServer
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "bundle-server")]
import sink, source_tar
OPA, BUNDLES, TOKEN = shutil.which("opa"), os.path.realpath(os.path.join(HERE, "..", "bundles")), "t0ken"   # realpath: `opa build -b a/../b` mis-reads the roots
REV = "bi-zeto.41-noto.11-fabricx.13-iroha3.1"

def post(port, name, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/bundles/{name}", data=body, method="POST", headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()

def opa_built_tar(bundle_dir, tmp):
    out = os.path.join(tmp, "built.tar.gz")
    subprocess.run([OPA, "build", "-b", bundle_dir, "-o", out], check=True, capture_output=True)
    with open(out, "rb") as f: return f.read()

@unittest.skipUnless(OPA, "opa not found")
class SourceTar(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, self.tmp, True)
        self.priv, self.pub = os.path.join(self.tmp, "k.pem"), os.path.join(self.tmp, "k.pub")   # throwaway pair, made here, never read from anywhere
        subprocess.run(["openssl", "genrsa", "-out", self.priv, "2048"], check=True, capture_output=True)
        subprocess.run(["openssl", "rsa", "-in", self.priv, "-pubout", "-out", self.pub], check=True, capture_output=True)
        self.store = os.path.join(self.tmp, "store"); os.mkdir(self.store)
        h = sink.Handler
        h.token, h.store, h.own, h.key_file, h.key_id, h.opa_bin, h.max_bytes = TOKEN, self.store, {"bi", "bank"}, self.priv, "bi", OPA, 10 * 1024 * 1024
        srv = ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown); self.addCleanup(srv.server_close); self.port = srv.server_address[1]

    def source(self, kind, data=None):
        return source_tar.make_tar(source_tar.source_files(os.path.join(BUNDLES, kind), data, REV))

    def test_deterministic_relative_sorted_zero_metadata(self):
        a, b = self.source("bi"), self.source("bi")
        self.assertEqual(a, b)
        self.assertEqual(a[4:8], b"\0\0\0\0", "gzip header mtime must be 0")
        with tarfile.open(fileobj=io.BytesIO(a)) as t:
            ms = t.getmembers()
        names = [m.name for m in ms]
        self.assertEqual(names, sorted(names))
        self.assertTrue(all(m.isreg() and m.mtime == 0 and m.uid == m.gid == 0 and m.mode == 0o644 for m in ms))
        self.assertTrue(all(not n.startswith(("/", "./")) and ".." not in n.split("/") for n in names), names)
        for must in (".manifest", "gw/gw.rego", "bi/config/data.json", "bi/atom/atom.rego"):
            self.assertIn(must, names)
        self.assertEqual(sink.read_archive(a, rooted=False)[".manifest"], json.dumps({"revision": REV, "roots": ["gw", "bi", "system"]}, sort_keys=True).encode() + b"\n")

    def test_the_opa_built_tar_that_failed_at_s21_is_refused_with_400(self):
        code, body = post(self.port, "bi", opa_built_tar(os.path.join(BUNDLES, "bi"), self.tmp))
        self.assertEqual((code, body.startswith(b"unsafe member name")), (400, True), body)
        self.assertEqual(os.listdir(self.store), [])

    def check_contract(self, kind, name):
        data = json.dumps({"marker": kind, "assembled": True}).encode()          # stands for fe's assembled data.json
        blob = self.source(kind, data)
        code, body = post(self.port, name, blob)
        self.assertEqual(code, 201, body)
        j = json.loads(body); self.assertEqual((j["bundle"], j["signed_here"]), (name, True))
        self.assertTrue(j["revision"].endswith("-" + hashlib.sha256(blob).hexdigest()))
        with open(os.path.join(self.store, name, j["revision"] + ".tar.gz"), "rb") as f: bundle = f.read()
        # signature verifies with the public key + key id, as a gateway does
        self.assertEqual(subprocess.run([OPA, "build", "-b", os.path.join(self.store, name, j["revision"] + ".tar.gz"), "--verification-key", self.pub, "--verification-key-id", "bi", "-o", os.devnull], capture_output=True).returncode, 0)
        built = sink.read_archive(bundle, rooted=True)
        src = sink.read_archive(blob, rooted=False)
        # CONTENT: every rego byte-equal to the source, data.json = the source data (under bi/config or bank/config), manifest revision + roots kept
        rego = {n.split("/src/", 1)[1]: b for n, b in built.items() if n.endswith(".rego")}
        self.assertEqual(rego, {n: b for n, b in src.items() if n.endswith(".rego")})
        d = json.loads(built["data.json"])[kind]["config"]
        self.assertEqual(d, json.loads(data))
        m = json.loads(built[".manifest"]); self.assertEqual((m["revision"], m["roots"]), (REV, json.loads(src[".manifest"])["roots"]))
        self.assertIn(".signatures.json", built)

    def test_bi_source_is_built_signed_and_content_equals_the_source(self): self.check_contract("bi", "bi")
    def test_bank_source_is_built_signed_and_content_equals_the_source(self): self.check_contract("bank", "bank")

if __name__ == "__main__":
    unittest.main()
