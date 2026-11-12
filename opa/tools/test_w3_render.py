#!/usr/bin/env python3 -I
"""Offline test of w3_render.py (OPA config of the iroha3 gateway, one per party; PUBLIC keys only).
python3 -I opa/tools/test_w3_render.py   (python stdlib only; no cluster, no network, no key)
Golden sha256 = the values iroha recorded for the files that are applied/handed over (bi is live); a mismatch means the renderer or the committed public keys drifted."""
import hashlib, os, re, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import w3_render
GOLDEN = {"bi": "36e1ca8b43cf46ad416dc656d547e98fe27f3656d9962eb8afc922b6f4cfefa5",
          "bank-a": "e8b13ae67f6d3d27d2de34a531c6756cb6d860653a7c66535dfc07f876c18c98",
          "bank-b": "f746061a52b40515e795d666e5ff03e6bc99925d13a995fd5e85ac604ea080d1",
          "bank-c": "af39e595578704b0f0b7c9860986cbfc5197f2d91c4cd9c37f3967668b5dd93c"}
DUMMY = "keys:\n  bi:\n    algorithm: RS256\n    key: |\n      -----BEGIN PUBLIC KEY-----\n      AAAA\n      -----END PUBLIC KEY-----\n  bank-a:\n    algorithm: RS256\n    key: |\n      -----BEGIN PUBLIC KEY-----\n      BBBB\n      -----END PUBLIC KEY-----\n  bank-b:\n    algorithm: RS256\n    key: |\n      -----BEGIN PUBLIC KEY-----\n      CCCC\n      -----END PUBLIC KEY-----\n  bank-c:\n    algorithm: RS256\n    key: |\n      -----BEGIN PUBLIC KEY-----\n      DDDD\n      -----END PUBLIC KEY-----\n"

class W3(unittest.TestCase):
    def test_template_fields_per_party(self):
        for p in w3_render.PARTIES:
            b = w3_render.render(p, DUMMY)
            self.assertIn("addr: 127.0.0.1:9191", b); self.assertIn("path: gw/allow", b); self.assertIn("dry-run: false", b)
            self.assertIn(f"url: http://bundle-server.rd-zeto-{p}.svc.cluster.local", b)
            self.assertIn("    signing: {keyid: bi}\n  bank:", b)
            self.assertIn(f"    signing: {{keyid: {p}}}\ndecision_logs:", b)
            self.assertIn("polling: {min_delay_seconds: 5, max_delay_seconds: 15}", b)
            self.assertTrue(b.endswith(DUMMY)); self.assertEqual(len(re.findall(r"^  [a-z0-9-]+:\n    algorithm: RS256", b, re.M)), 4)

    def test_deterministic(self):
        for p in w3_render.PARTIES:
            self.assertEqual(w3_render.render(p, DUMMY), w3_render.render(p, DUMMY))

    def test_refuses_private_key_material_and_wrong_key_set(self):
        with self.assertRaises(ValueError): w3_render.render("bi", DUMMY + "-----BEGIN RSA " + "PRIVATE KEY-----\n")
        with self.assertRaises(ValueError): w3_render.render("bi", DUMMY.replace("  bank-c:", "  bank-x:"))
        with self.assertRaises(ValueError): w3_render.render("bank-z", DUMMY)

    def test_committed_keys_are_public_only_and_render_the_golden_sha256(self):
        keys = open(w3_render.KEYS, encoding="utf-8").read()
        self.assertNotIn("PRIVATE KEY", keys); self.assertEqual(keys.count("BEGIN PUBLIC KEY"), 4)
        for p, want in GOLDEN.items():
            b = w3_render.render(p, keys); self.assertNotIn("PRIVATE KEY", b)
            self.assertEqual(hashlib.sha256(b.encode()).hexdigest(), want, p)

    def test_cli_writes_four_files_and_sha256sums_twice_byte_equal(self):
        outs = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as d:
                r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "w3_render.py"), d], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(sorted(os.listdir(d)), ["SHA256SUMS", "opa-bank-a.yaml", "opa-bank-b.yaml", "opa-bank-c.yaml", "opa-bi.yaml"])
                sums = open(os.path.join(d, "SHA256SUMS")).read()
                self.assertEqual(subprocess.run(["sha256sum", "-c", "SHA256SUMS"], cwd=d, capture_output=True).returncode, 0)
                outs.append(sums)
        self.assertEqual(outs[0], outs[1])
        for p, want in GOLDEN.items(): self.assertIn(f"{want}  opa-{p}.yaml", outs[0])

if __name__ == "__main__":
    unittest.main()
