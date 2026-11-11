"""POST /bundles/<name> of the sink (python3 -m unittest test_sink_bundles). Standard library + the `opa` and `openssl` binaries (as the Publisher uses them).

Throwaway RSA key pairs are made per test run; no key of the repo or of a cluster is read.
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import sink

OPA = os.environ.get("OPA_BIN") or shutil.which("opa")
TOKEN = "s3cret"
REGO = b"package gw\n\ndefault allow := false\n"


def make_tar(files, dirs=(), extra=None):
    """tar.gz in memory from {name: bytes}; `extra(tar)` can add odd members (links, devices)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for d in dirs:
            ti = tarfile.TarInfo(d)
            ti.type = tarfile.DIRTYPE
            t.addfile(ti)
        for name, data in files.items():
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            t.addfile(ti, io.BytesIO(data))
        if extra:
            extra(t)
    return buf.getvalue()


def keypair(d, name):
    priv, pub = os.path.join(d, name + ".pem"), os.path.join(d, name + ".pub")
    subprocess.run(["openssl", "genrsa", "-out", priv, "2048"], check=True, capture_output=True)
    subprocess.run(["openssl", "rsa", "-in", priv, "-pubout", "-out", pub], check=True, capture_output=True)
    return priv, pub


def verifies(bundle_path, pub, keyid):
    """Same check the gateways do: `opa build` verifies .signatures.json of a bundle file with the public key."""
    r = subprocess.run([OPA, "build", "-b", bundle_path, "--verification-key", pub, "--verification-key-id", keyid, "-o", os.devnull], capture_output=True)
    return r.returncode == 0


def post(port, path, body=b"", token=TOKEN, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method="POST")
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Base(unittest.TestCase):
    own = ("bank",)
    keyid = "bank-a"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.store = os.path.join(self.tmp, "store")
        os.mkdir(self.store)
        self.priv, self.pub = keypair(self.tmp, "k")
        h = sink.Handler
        h.token, h.store, h.own, h.key_file, h.key_id, h.opa_bin, h.max_bytes = TOKEN, self.store, set(self.own), self.priv, self.keyid, OPA, 1024 * 1024
        sink.STATUS.clear()
        server = ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        self.port = server.server_address[1]

    def files(self, name):
        d = os.path.join(self.store, name)
        return sorted(os.listdir(d)) if os.path.isdir(d) else []


@unittest.skipUnless(OPA, "opa binary not found (set OPA_BIN)")
class OwnBundle(Base):
    def test_unsigned_source_is_built_signed_and_stored_append_only(self):
        blob = make_tar({"gw/gw.rego": REGO, "bank/data.json": b'{"a": 1}'})
        code, body = post(self.port, "/bundles/bank", blob)
        self.assertEqual(code, 201, body)
        rev = json.loads(body)["revision"]
        self.assertRegex(rev, r"^\d{8}T\d{12}Z-" + hashlib.sha256(blob).hexdigest() + "$")  # timestamp + sha256 of the uploaded source
        d = os.path.join(self.store, "bank")
        self.assertEqual(self.files("bank"), sorted([f"{rev}.tar.gz", f"{rev}.signatures.json", "latest.tar.gz", "latest.signatures.json"]))
        self.assertTrue(verifies(os.path.join(d, f"{rev}.tar.gz"), self.pub, "bank-a"), "signature must verify with the public key")
        self.assertFalse(verifies(os.path.join(d, f"{rev}.tar.gz"), keypair(self.tmp, "other")[1], "bank-a"), "another key must not verify")
        sigs = json.load(open(os.path.join(d, f"{rev}.signatures.json")))
        self.assertTrue(sigs["signatures"])
        # nginx serves latest.tar.gz: it must be the newest revision
        self.assertEqual(open(os.path.join(d, "latest.tar.gz"), "rb").read(), open(os.path.join(d, f"{rev}.tar.gz"), "rb").read())

    def test_second_upload_never_overwrites_and_latest_moves(self):
        a = json.loads(post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO}))[1])["revision"]
        before = {f: open(os.path.join(self.store, "bank", f), "rb").read() for f in (f"{a}.tar.gz", f"{a}.signatures.json")}
        b = json.loads(post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO}))[1])["revision"]  # same content again
        self.assertNotEqual(a, b)
        for f, data in before.items():
            self.assertEqual(open(os.path.join(self.store, "bank", f), "rb").read(), data)
        self.assertEqual(os.path.realpath(os.path.join(self.store, "bank", "latest.tar.gz")), os.path.join(os.path.realpath(self.store), "bank", f"{b}.tar.gz"))

    def test_existing_revision_file_is_never_replaced(self):
        orig = sink.revision_id
        sink.revision_id = lambda data: "fixed"
        self.addCleanup(setattr, sink, "revision_id", orig)
        self.assertEqual(post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO}))[0], 201)
        first = open(os.path.join(self.store, "bank", "fixed.tar.gz"), "rb").read()
        self.assertEqual(post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO + b"# x\n"}))[0], 409)
        self.assertEqual(open(os.path.join(self.store, "bank", "fixed.tar.gz"), "rb").read(), first)

    def test_bad_rego_is_refused_and_stores_nothing(self):
        code, _ = post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": b"package gw\nallow := {{{\n"}))
        self.assertEqual(code, 422)
        self.assertEqual(self.files("bank"), [])

    def test_presigned_upload_to_own_name_is_refused(self):
        code, _ = post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO, ".signatures.json": b'{"signatures": ["x"]}'}))
        self.assertEqual(code, 422)
        self.assertEqual(self.files("bank"), [])


@unittest.skipUnless(OPA, "opa binary not found (set OPA_BIN)")
class ForeignBundle(Base):
    def signed_bi(self):
        """A bundle signed by BI's key, built the way BI's own bundle-server does."""
        src = os.path.join(self.tmp, "src")
        os.makedirs(os.path.join(src, "gw"))
        open(os.path.join(src, "gw", "gw.rego"), "wb").write(REGO)
        out = os.path.join(self.tmp, "bi.tar.gz")
        subprocess.run([OPA, "build", "-b", src, "--signing-key", self.bi_priv, "--verification-key-id", "bi", "-o", out], check=True, capture_output=True)
        return open(out, "rb").read()

    def test_foreign_signed_bundle_is_stored_byte_identical_without_resigning(self):
        self.bi_priv, bi_pub = keypair(self.tmp, "bi")
        blob = self.signed_bi()
        code, body = post(self.port, "/bundles/bi", blob)
        self.assertEqual(code, 201, body)
        rev = json.loads(body)["revision"]
        d = os.path.join(self.store, "bi")
        stored = open(os.path.join(d, f"{rev}.tar.gz"), "rb").read()
        self.assertEqual(hashlib.sha256(stored).hexdigest(), hashlib.sha256(blob).hexdigest())
        self.assertTrue(verifies(os.path.join(d, f"{rev}.tar.gz"), bi_pub, "bi"), "must still verify under BI's key, not this server's")
        self.assertFalse(verifies(os.path.join(d, f"{rev}.tar.gz"), self.pub, "bi"))
        with tarfile.open(fileobj=io.BytesIO(blob)) as t:
            self.assertEqual(open(os.path.join(d, f"{rev}.signatures.json"), "rb").read(), next(t.extractfile(m).read() for m in t if m.name.lstrip("/") == ".signatures.json"))

    def test_foreign_unsigned_source_is_refused(self):
        code, _ = post(self.port, "/bundles/bi", make_tar({"gw/gw.rego": REGO}))
        self.assertEqual(code, 422)
        self.assertEqual(self.files("bi"), [])

    def test_foreign_second_upload_is_a_new_revision(self):
        self.bi_priv, _ = keypair(self.tmp, "bi")
        blob = self.signed_bi()
        a = json.loads(post(self.port, "/bundles/bi", blob)[1])["revision"]
        b = json.loads(post(self.port, "/bundles/bi", blob)[1])["revision"]
        self.assertNotEqual(a, b)
        self.assertEqual(len([f for f in self.files("bi") if f.endswith(".tar.gz") and not f.startswith("latest")]), 2)


class BiServerOwnsTwoBundles(Base):
    own = ("bi", "bank")
    keyid = "bi"

    @unittest.skipUnless(OPA, "opa binary not found (set OPA_BIN)")
    def test_both_names_are_signed_with_the_one_key(self):
        for name in ("bi", "bank"):
            code, body = post(self.port, f"/bundles/{name}", make_tar({"gw/gw.rego": REGO}))
            self.assertEqual(code, 201, body)
            rev = json.loads(body)["revision"]
            self.assertTrue(verifies(os.path.join(self.store, name, f"{rev}.tar.gz"), self.pub, "bi"))


class Rejects(Base):
    def test_missing_or_wrong_token_is_401_and_stores_nothing(self):
        t = make_tar({"gw/gw.rego": REGO})
        self.assertEqual(post(self.port, "/bundles/bank", t, token=None)[0], 401)
        self.assertEqual(post(self.port, "/bundles/bank", t, token="wrong")[0], 401)
        self.assertEqual(os.listdir(self.store), [])

    def test_bad_names_and_traversal(self):
        t = make_tar({"gw/gw.rego": REGO})
        for path in ("/bundles/", "/bundles/Bank", "/bundles/-x", "/bundles/a_b", "/bundles/..", "/bundles/a/b", "/bundles/%2e%2e", "/bundles/..%2fx", "/bundles/bank?x=1", "/bundles/ban%20k"):
            self.assertIn(post(self.port, path, t)[0], (400, 404), path)
        self.assertEqual(os.listdir(self.store), [])
        self.assertEqual(os.listdir(self.tmp).count("x"), 0)

    def test_oversized_body_is_413_before_it_is_read(self):
        code, _ = post(self.port, "/bundles/bank", b"x" * (1024 * 1024 + 1))
        self.assertEqual(code, 413)
        self.assertEqual(os.listdir(self.store), [])

    def test_unknown_content_is_400(self):
        for body in (b"", b"not a tar", b"\x1f\x8b" + b"garbage"):
            self.assertEqual(post(self.port, "/bundles/bank", body)[0], 400, body)
        self.assertEqual(os.listdir(self.store), [])

    def test_unsafe_tar_members_are_refused(self):
        def link(t):
            ti = tarfile.TarInfo("gw/evil")
            ti.type, ti.linkname = tarfile.SYMTYPE, "/etc/passwd"
            t.addfile(ti)

        for blob in (
            make_tar({"../evil.rego": REGO}),
            make_tar({"/abs/evil.rego": REGO}),
            make_tar({"gw/../../evil.rego": REGO}),
            make_tar({"gw/gw.rego": REGO}, extra=link),
            make_tar({}),
        ):
            self.assertIn(post(self.port, "/bundles/bank", blob)[0], (400, 422))
        self.assertEqual(os.listdir(self.store), [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "evil.rego")))

    def test_get_on_bundles_is_404(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/bundles/bank")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 404)


class OldEndpointsUnchanged(Base):
    def test_logs_and_status_still_work_with_the_token(self):
        st = {"labels": {"gateway": "bank-gw-1"}, "bundles": {"bi": {"active_revision": "r1", "code": "", "message": ""}}}
        self.assertEqual(post(self.port, "/status", json.dumps(st).encode(), token=None)[0], 401)
        self.assertEqual(post(self.port, "/status", json.dumps(st).encode())[0], 200)
        self.assertEqual(post(self.port, "/logs", b'[{"decision_id": "d"}]')[0], 200)
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/status") as r:
            self.assertEqual(json.loads(r.read())["bank-gw-1"]["bundles"]["bi"]["revision"], "r1")


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(OPA, "opa binary not found (set OPA_BIN)")
class GetLatest(Base):
    """GET /bundles/<name>/latest returns the newest stored signed bundle byte-identical (the relay of BI's bundle to the bank sinks)."""

    def get(self, path):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def test_own_bundle_latest_is_the_stored_tarball_and_follows_new_revisions(self):
        a = json.loads(post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO}))[1])["revision"]
        code, body, hdr = self.get("/bundles/bank/latest")
        self.assertEqual(code, 200)
        self.assertEqual(body, open(os.path.join(self.store, "bank", f"{a}.tar.gz"), "rb").read())
        self.assertEqual(hdr.get("Content-Type"), "application/gzip")
        b = json.loads(post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO + b"\n# v2\n"}))[1])["revision"]
        self.assertEqual(self.get("/bundles/bank/latest")[1], open(os.path.join(self.store, "bank", f"{b}.tar.gz"), "rb").read())

    def test_unknown_name_404_bad_names_400_no_path_escape(self):
        self.assertEqual(self.get("/bundles/bi/latest")[0], 404)
        for p in ("/bundles/A/latest", "/bundles/../latest", "/bundles/a/b/latest", "/bundles/bank/latest/x", "/bundles/bank/other"):
            self.assertIn(self.get(p)[0], (400, 404), p)

    def test_no_token_needed_it_is_signed_public_data(self):
        post(self.port, "/bundles/bank", make_tar({"gw/gw.rego": REGO}))
        self.assertEqual(self.get("/bundles/bank/latest")[0], 200)
