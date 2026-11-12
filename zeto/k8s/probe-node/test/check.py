#!/usr/bin/env python3
"""Offline check of the (iv) node-read probe pod (zeto/k8s/probe-node/render.sh). Usage: check.py <render.sh>. Needs PyYAML only; no cluster."""
import re, subprocess, sys, yaml
render = sys.argv[1]
IMG = "docker.io/library/busybox:1.36@sha256:" + "a" * 64
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
def run(*a): return subprocess.run([render, *a], capture_output=True, text=True)
def docs(*a):
    r = run(*a)
    if r.returncode: fails.append(f"render.sh {' '.join(a)} exited {r.returncode}: {r.stderr.strip()[:150]}"); return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]
NUM = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}
for party, n in NUM.items():
    ns = f"rd-zeto-{party}"
    ds = docs(party, "--image", IMG)
    check([d["kind"] for d in ds] == ["Pod", "NetworkPolicy", "NetworkPolicy"], f"{party}: kinds Pod + 2 NetworkPolicy: {[d['kind'] for d in ds]}")
    if len(ds) != 3: continue
    pod, egress, ingress = ds
    check(all(d["metadata"]["namespace"] == ns for d in ds), f"{party}: every object in {ns}")
    lab = pod["metadata"]["labels"]
    check(lab.get("rd/egress-locked") == "true" and lab.get("app") == "node-probe" and lab.get("app") != "paladin", f"{party}: labelled rd/egress-locked=true, app=node-probe, never app=paladin: {lab}")
    sp = pod["spec"]; c = sp["containers"][0]
    check(len(sp["containers"]) == 1 and c["image"] == IMG, f"{party}: one container, the digest image")
    check(sp.get("automountServiceAccountToken") is False and "serviceAccountName" not in sp, f"{party}: no service account token")
    check("volumes" not in sp and "volumeMounts" not in c and "env" not in c and "envFrom" not in c, f"{party}: no volume, no env, no Secret")
    check(sp["restartPolicy"] == "Never" and sp.get("activeDeadlineSeconds", 999) <= 120, f"{party}: Never + a short deadline")
    check(sp["securityContext"].get("runAsNonRoot") is True and c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{party}: hardened")
    cmd = " ".join(c["command"]) + " " + " ".join(c.get("args", []))
    check(f"http://paladin-node{n}:8548" in cmd and cmd.count("http://") == 1, f"{party}: calls only http://paladin-node{n}:8548 (own ns Service)")
    check("ptx_queryPendingTransactions" in cmd, f"{party}: default method = the pending read")
    check(('echo 0' in cmd and 'NONZERO' in cmd) and "cat " not in cmd and "echo $R" not in cmd and 'echo "$R"' not in cmd and "set -x" not in cmd, f"{party}: prints ONLY 0 / NONZERO / ERROR, never the response body")
    es = egress["spec"]
    check(es["podSelector"]["matchLabels"] == {"rd/egress-locked": "true", "app": "node-probe"} and es["policyTypes"] == ["Egress", "Ingress"] and "ingress" not in es, f"{party}: probe policy selects the probe, Egress+Ingress (ingress none)")
    rules = es["egress"]
    check(len(rules) == 2 and rules[0]["to"] == [{"podSelector": {"matchLabels": {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"}}}] and rules[0]["ports"] == [{"protocol": "TCP", "port": 8548}], f"{party}: egress rule 1 = paladin-node{n}:8548 in the own ns only")
    check(rules[1]["to"] == [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}] and rules[1]["ports"] == [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}], f"{party}: egress rule 2 = kube-dns 53 (a name is used)")
    ing = ingress["spec"]
    check(ing["podSelector"]["matchLabels"] == {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"} and ing["policyTypes"] == ["Ingress"] and ing["ingress"] == [{"from": [{"podSelector": {"matchLabels": {"rd/egress-locked": "true", "app": "node-probe"}}}], "ports": [{"protocol": "TCP", "port": 8548}]}], f"{party}: extra ingress to the node's 8548 from the probe pod ONLY (paladin-ingress admits bank-gw only)")
    # jq mode + parameters
    j = docs(party, "--image", IMG, "--mode", "jq", "--method", "ptx_queryTransactions", "--params", '[{"limit":5}]')
    if j:
        jc = " ".join(j[0]["spec"]["containers"][0]["command"])
        check("jq" in jc and "length" in jc and "ptx_queryTransactions" in jc and '{"limit":5}' in jc, f"{party}: jq mode prints jq length of the chosen method/params")
# Behaviour: run the container command with a fake wget: [] -> 0, a non-empty result -> NONZERO, a failing call -> ERROR; the response body is never printed.
import os, stat, tempfile
d = tempfile.mkdtemp()
def fake_wget(body, rc=0):
    p = os.path.join(d, "wget"); open(p, "w").write(f"#!/bin/sh\n[ {rc} = 0 ] || exit 1\nprintf '%s' '{body}'\n"); os.chmod(p, 0o755)
cmd = docs("bank-a", "--image", IMG)[0]["spec"]["containers"][0]["command"]
def out(body, rc=0):
    fake_wget(body, rc)
    r = subprocess.run(cmd[:2] + [cmd[2]], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
    return r.stdout.strip(), r.stderr.strip()
check(out('{"jsonrpc":"2.0","id":1,"result":[]}') == ("0", ""), "behaviour: an empty result prints 0")
o = out('{"jsonrpc":"2.0","id":1,"result":[{"id":"SECRET-TX-1"}]}'); check(o == ("NONZERO", ""), f"behaviour: a non-empty result prints NONZERO and never the body: {o}")
o = out("", rc=1); check(o == ("ERROR", ""), f"behaviour: a failing call prints ERROR: {o}")
o = out('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"PD012345: bad filter"}}'); check(o == ("ERROR", ""), f"behaviour: a JSON-RPC error body prints ERROR, never NONZERO (a bad filter looked like data before): {o}")
o = out('<html>502</html>'); check(o == ("ERROR", ""), f"behaviour: a body without a result prints ERROR: {o}")

# ---- python modes (image with python3, e.g. the pinned rd-bundle-sink image): `ids` and `shape`. The script is embedded as base64 in the pod command and run by `python3 -`; the tests decode it,
# point it at a local HTTP server that answers canned JSON-RPC and check the output. ids: the pending SET (bank A keeps ONE known prepare-only tx pending forever); shape: structure of a receipt, never values.
import base64, http.server, json, threading
class Canned(http.server.BaseHTTPRequestHandler):
    answers = {}
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        key = req["method"] + ("|" + req["params"][0] if req["method"] == "ptx_getTransactionReceiptFull" else "")
        body = json.dumps(Canned.answers.get(key, {"jsonrpc": "2.0", "id": 1, "result": []})).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Canned); threading.Thread(target=srv.serve_forever, daemon=True).start()
def py_out(party, args, answers):
    ds = docs(party, "--image", IMG, *args)
    if len(ds) != 3: fails.append(f"{party} {args}: expected 3 objects, got {len(ds)}"); return None, None
    cmd = ds[0]["spec"]["containers"][0]["command"][2]
    m = re.search(r"echo ([A-Za-z0-9+/=]+) \| base64 -d \| python3 -", cmd)
    if not m: fails.append(f"{party} {args}: no embedded base64 python in {cmd[:120]}"); return None, None
    src = base64.b64decode(m.group(1)).decode().replace(f"http://paladin-node{NUM[party]}:8548", f"http://127.0.0.1:{srv.server_address[1]}")
    Canned.answers = answers
    r = subprocess.run([sys.executable, "-I", "-c", src], capture_output=True, text=True, timeout=20)
    return r.stdout.strip(), cmd
U1, U2 = "81daa2e9-3c5b-4f0a-9d2e-111111111111", "0a1b2c3d-1111-2222-3333-444444444444"
PEND = "ptx_queryPendingTransactions"
for party in NUM:
    check(py_out(party, ["--mode", "ids"], {PEND: {"jsonrpc": "2.0", "id": 1, "result": []}})[0] == "COUNT 0 IDS -", f"{party}: ids mode, empty set -> COUNT 0 IDS -")
    o, cmd = py_out(party, ["--mode", "ids"], {PEND: {"jsonrpc": "2.0", "id": 1, "result": [{"id": U1, "function": "spendLock(bytes32,string,bytes)", "data": {"lockId": "SECRET-LOCK", "id": "SECRET-INNER-ID"}}]}})
    check(o == "COUNT 1 IDS 81daa2e9", f"{party}: ids mode, one tx -> 8-char id only, never data: {o!r}")
    check(py_out(party, ["--mode", "ids"], {PEND: {"jsonrpc": "2.0", "id": 1, "result": [{"id": U1}, {"id": U2}]}})[0] == "COUNT 2 IDS 0a1b2c3d,81daa2e9", f"{party}: ids mode, two txs, sorted")
    check(py_out(party, ["--mode", "ids"], {PEND: {"jsonrpc": "2.0", "id": 1, "error": {"code": -32600, "message": "bad filter"}}})[0] == "ERROR", f"{party}: ids mode, error body -> ERROR")
    check(cmd is not None and "cat " not in cmd and "set -x" not in cmd, f"{party}: ids mode never echoes the body")
# shape: the receipt STRUCTURE for a chain tx hash on this node: PD code + first 60 chars of the domain error, domainReceipt yes/no, states keys/counts and whether ANY entry carries `data` (yes/no, never the value).
H = "0x" + "5144e6c8" + "0" * 52 + "6dfa"
FIND = "ptx_queryTransactionReceipts"
def shape(party, receipts, full):
    ans = {FIND: {"jsonrpc": "2.0", "id": 1, "result": receipts}}
    for rid, res in full.items(): ans["ptx_getTransactionReceiptFull|" + rid] = {"jsonrpc": "2.0", "id": 1, "result": res}
    return py_out(party, ["--mode", "shape", "--tx-hash", H], ans)[0]
ERR = "PD011658: Failed to get states for the receipt: could not fi"
OUTSIDER = {"domainReceiptError": "PD011658: Failed to get states for the receipt: could not find 0x" + "ab" * 32 + " in the store",
            "states": {"unavailable": {"confirmed": ["0x01", "0x02"], "info": ["0x03"]}}}
for party in NUM:
    o = shape(party, [{"id": U1}], {U1: OUTSIDER})
    check(o == f"receipts 1\nreceipt 1: states confirmed=0 spent=0 read=0 info=0 | unavailable confirmed=2 spent=0 read=0 info=1 | unavailable-nil:no | data:no | domainReceiptError PD011658 '{ERR}' | domainReceipt no", f"{party}: shape, the expected outsider receipt (no states, ids unavailable, PD011658, no domainReceipt): {o!r}")
    # RED fixture 1: a state entry carries `data` -> data:yes + R1-FINDING, never the value
    o = shape(party, [{"id": U1}], {U1: {"domainReceipt": {"x": "SECRET-DOMAIN-VALUE"}, "states": {"confirmed": [{"id": "S1", "data": {"amount": "SECRET-AMOUNT"}}], "unavailable": {}}}})
    check(o == "receipts 1\nreceipt 1: states confirmed=1 spent=0 read=0 info=0 | unavailable confirmed=0 spent=0 read=0 info=0 | unavailable-nil:no | data:yes | domainReceiptError none | domainReceipt yes R1-FINDING" and "SECRET" not in o, f"{party}: shape, data present -> data:yes + R1-FINDING, never the value: {o!r}")
    # RED fixture 2: `unavailable` nil while confirmed is non-empty -> R1-FINDING
    o = shape(party, [{"id": U1}], {U1: {"states": {"confirmed": [{"id": "S1"}]}}})
    check(o == "receipts 1\nreceipt 1: states confirmed=1 spent=0 read=0 info=0 | unavailable confirmed=0 spent=0 read=0 info=0 | unavailable-nil:yes | data:no | domainReceiptError none | domainReceipt no R1-FINDING", f"{party}: shape, unavailable nil + confirmed non-empty -> R1-FINDING: {o!r}")
    # nil unavailable with NOTHING confirmed is not a finding
    o = shape(party, [{"id": U1}], {U1: {"states": {}}})
    check("R1-FINDING" not in o and "unavailable-nil:yes" in o, f"{party}: shape, nothing confirmed and unavailable nil is not a finding: {o!r}")
    check(shape(party, [], {}) == "receipts 0", f"{party}: shape, no receipt for the hash -> receipts 0")
    o = py_out(party, ["--mode", "shape", "--tx-hash", H], {FIND: {"jsonrpc": "2.0", "id": 1, "error": {"code": 1, "message": "x"}}})[0]
    check(o == "ERROR", f"{party}: shape, error body -> ERROR: {o!r}")
# ---- schemas mode (analyst follow-up on the node4 outsider finding; STRUCTURE only): per receipt the domainReceipt KEY names, per confirmed/spent/read/info the entries grouped by schema (name via
# pstate_listSchemas + 8-char id) with/without `data`, contractAddress = a given Zeto token (zeto/other/absent), the 4 unavailable counts, and a verdict: COIN-DATA (data in a coin/lock schema = R1 break),
# OTHER-DATA (data in another non-MerkleTree schema), OK (data only in MerkleTree schemas). Never a state id, hash, amount, owner or value.
TOK = "0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6"
SCH_COIN, SCH_LOCK, SCH_ROOT, SCH_NODE, SCH_TXD = ("0x" + c * 64 for c in "abcde")
LIST = {"jsonrpc": "2.0", "id": 1, "result": [{"id": SCH_COIN, "definition": {"name": "ZetoCoin_V1"}}, {"id": SCH_LOCK, "definition": {"name": "ZetoLockInfo_V1"}}, {"id": SCH_ROOT, "definition": {"name": "MerkleTreeRoot"}}, {"id": SCH_NODE, "definition": {"name": "MerkleTreeNode"}}, {"id": SCH_TXD, "definition": {"name": "ZetoTransactionData_V1"}}]}
def schemas(party, receipts, full, listing=LIST):
    ans = {FIND: {"jsonrpc": "2.0", "id": 1, "result": receipts}, "pstate_listSchemas": listing}
    for rid, res in full.items(): ans["ptx_getTransactionReceiptFull|" + rid] = {"jsonrpc": "2.0", "id": 1, "result": res}
    return py_out(party, ["--mode", "schemas", "--tx-hash", H, "--zeto-token", TOK], ans)[0]
NOUN = "unavailable confirmed=%d spent=%d read=%d info=%d"
for party in NUM:
    benign = {"domain": "zeto", "domainReceipt": {"transfers": ["SECRET"], "lockInfo": {}}, "states": {"confirmed": [{"id": "S1", "schema": SCH_ROOT, "contractAddress": TOK, "data": {"rootIndex": "SECRET-ROOT"}}, {"id": "S2", "schema": SCH_NODE, "contractAddress": TOK, "data": {"x": 1}}, {"id": "S3", "schema": SCH_NODE, "contractAddress": TOK, "data": {"x": 2}}], "unavailable": {"confirmed": ["0x01"], "spent": ["0x02"]}}}
    o = schemas(party, [{"id": U1}], {U1: benign})
    check(o == "receipts 1\nreceipt 1: domainReceipt keys lockInfo,transfers | confirmed: data[MerkleTreeNode(bbbbbbbb)=2 MerkleTreeRoot(cccccccc)=1] nodata[none] addr[MerkleTreeNode(dddddddd)=zeto MerkleTreeRoot(cccccccc)=zeto] | spent: data[none] nodata[none] addr[none] | read: data[none] nodata[none] addr[none] | info: data[none] nodata[none] addr[none] | " + NOUN % (1, 1, 0, 0) + " | OK" or False, f"{party}: schemas, only Merkle schemas carry data -> OK: {o!r}") if False else None
    check(o is not None and "SECRET" not in o and o.endswith("| OK") and "domain zeto domainReceipt keys lockInfo:empty,transfers:filled" in o and "unavailable confirmed=1 spent=1 read=0 info=0" in o and "MerkleTreeNode(" in o and "=2" in o, f"{party}: schemas, only Merkle schemas carry data -> OK, key names, unavailable counts, no value: {o!r}")
    # nested key names under domainReceipt.states, each only filled/empty (lead: close outcome A)
    o = schemas(party, [{"id": U1}], {U1: {"domain": "zeto", "domainReceipt": {"states": {"inputs": [], "outputs": [], "lockedInputs": None, "lockedOutputs": [{"x": "SECRET"}]}}, "states": {}}})
    check(o is not None and "domainReceipt keys states{inputs:empty,lockedInputs:empty,lockedOutputs:filled,outputs:empty}" in o and "SECRET" not in o, f"{party}: schemas, nested key names + filled/empty only: {o!r}")
    # RED fixture 1: a coin schema WITH data -> COIN-DATA, never the value
    bad = {"domain": "zeto", "domainReceipt": {"transfers": []}, "states": {"confirmed": [{"id": "S1", "schema": SCH_COIN, "contractAddress": TOK, "data": {"amount": "SECRET-AMOUNT"}}, {"id": "S2", "schema": SCH_COIN}, {"id": "S3", "schema": SCH_NODE, "data": {"n": 1}}], "unavailable": {}}}
    o = schemas(party, [{"id": U1}], {U1: bad})
    check(o is not None and o.endswith("| COIN-DATA") and "SECRET" not in o and "ZetoCoin_V1(" in o and "data[MerkleTreeNode(" in o and "nodata[ZetoCoin_V1(" in o, f"{party}: schemas, coin schema with data -> COIN-DATA, never the value: {o!r}")
    # RED fixture 2: a lock/locked-coin schema with data
    o = schemas(party, [{"id": U1}], {U1: {"states": {"info": [{"id": "S1", "schema": SCH_LOCK, "data": {"k": 1}}]}}})
    check(o is not None and o.endswith("| COIN-DATA") and "info: data[ZetoLockInfo_V1(" in o, f"{party}: schemas, lock schema with data -> COIN-DATA: {o!r}")
    # data in another non-Merkle schema = OTHER-DATA (reported, not the stop rule); an unknown schema id with data cannot be proven harmless -> COIN-DATA
    o = schemas(party, [{"id": U1}], {U1: {"states": {"info": [{"id": "S1", "schema": SCH_TXD, "contractAddress": "0x" + "9" * 40, "data": {"k": 1}}]}}})
    check(o is not None and o.endswith("| OTHER-DATA") and "ZetoTransactionData_V1(" in o and "=other" in o, f"{party}: schemas, transaction-data schema with data -> OTHER-DATA, address other: {o!r}")
    o = schemas(party, [{"id": U1}], {U1: {"states": {"confirmed": [{"id": "S1", "schema": "0x" + "f" * 64, "data": {"k": 1}}]}}})
    check(o is not None and o.endswith("| COIN-DATA") and "unknown(ffffffff)=1" in o and "=absent" in o, f"{party}: schemas, unknown schema with data -> COIN-DATA: {o!r}")
    # an id-only stub: the `data` KEY is present but null/{} -> carries NO data (the first shape read counted the key and cried wolf)
    o = schemas(party, [{"id": U1}], {U1: {"states": {"confirmed": [{"id": "S1", "schema": SCH_COIN, "data": None}, {"id": "S2", "schema": SCH_COIN, "data": {}}]}}})
    check(o is not None and o.endswith("| OK") and "nodata[ZetoCoin_V1(" in o and "=2" in o and "data[none]" in o, f"{party}: schemas, data null/{{}} stubs are NOT data -> OK: {o!r}")
    check(schemas(party, [], {}) == "receipts 0", f"{party}: schemas, no receipt -> receipts 0")
    check(schemas(party, [{"id": U1}], {U1: {}}, listing={"jsonrpc": "2.0", "id": 1, "error": {"code": 1, "message": "x"}}).splitlines()[-1] == "ERROR", f"{party}: schemas, listSchemas error -> ERROR")
# ---- besu mode (S5b, R9): the party's OWN validator RPC (Service besu-rpc:8545 in its ns) through a throwaway pod; reads + the QBFT vote calls. Prints only addresses, counts and booleans.
#   render.sh <party> besu --image REF --op read|pending|propose|discard [--address 0x<40hex>] [--drop|--add]
# Objects: Pod besu-probe (rd/egress-locked, python image, no token) + NetworkPolicy besu-probe (egress ONLY to the besu-validator pods :8545 of its own ns + kube-dns; ingress none).
def besu_run(party, args, answers):
    ds = docs(party, "besu", "--image", IMG, *args)
    if len(ds) != 2 or [d["kind"] for d in ds] != ["Pod", "NetworkPolicy"]: fails.append(f"{party} besu {args}: expected Pod + NetworkPolicy, got {[d['kind'] for d in ds]}"); return None, ds
    cmd = ds[0]["spec"]["containers"][0]["command"][2]
    m = re.search(r"echo ([A-Za-z0-9+/=]+) \| base64 -d \| python3 -", cmd)
    if not m: fails.append(f"{party} besu {args}: no embedded python"); return None, ds
    src = base64.b64decode(m.group(1)).decode().replace("http://besu-rpc:8545", f"http://127.0.0.1:{srv.server_address[1]}")
    class H(Canned): pass
    Canned.answers = answers; calls.clear()
    return subprocess.run([sys.executable, "-I", "-c", src], capture_output=True, text=True, timeout=20).stdout.strip(), ds
calls = []
_orig_post = Canned.do_POST
def _rec_post(self):
    n = int(self.headers["Content-Length"]); body = self.rfile.read(n); req = json.loads(body); calls.append((req["method"], req.get("params")))
    ans = Canned.answers.get(req["method"], {"jsonrpc": "2.0", "id": 1, "result": []})
    out = json.dumps(ans).encode(); self.send_response(200); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
Canned.do_POST = _rec_post
A8 = ["0x" + c * 40 for c in "abcdef"][:6]
VALS = {"qbft_getValidatorsByBlockNumber": {"jsonrpc": "2.0", "id": 1, "result": A8[:4]}, "eth_blockNumber": {"jsonrpc": "2.0", "id": 1, "result": "0x2710"}, "net_peerCount": {"jsonrpc": "2.0", "id": 1, "result": "0x3"},
        "qbft_getSignerMetrics": {"jsonrpc": "2.0", "id": 1, "result": [{"address": A8[0], "proposedBlockCount": "0x2", "lastProposedBlockNumber": "0x270f", "signedBlockCount": "0x8"}, {"address": A8[1], "proposedBlockCount": "0x0", "lastProposedBlockNumber": "0x0"}]}}
for party in NUM:
    o, ds = besu_run(party, ["--op", "read"], VALS)
    check(o is not None and o.splitlines() == ["height 10000", "validators 4: " + ",".join(A8[:4]), "peers 3", f"signers(last 8 blocks): {A8[0]}=2 {A8[1]}=0"], f"{party}: besu read prints height, validators, peers, signer counts only: {o!r}")
    if ds:
        pod, pol = ds; lab = pod["metadata"]["labels"]; sp = pol["spec"]
        check(pod["metadata"]["name"] == "besu-probe" and lab.get("rd/egress-locked") == "true" and lab.get("app") == "besu-probe" and pod["spec"].get("automountServiceAccountToken") is False and "volumes" not in pod["spec"] and "env" not in pod["spec"]["containers"][0], f"{party}: besu pod: locked label, no token/volume/env: {lab}")
        check(sp["podSelector"] == {"matchLabels": {"rd/egress-locked": "true", "app": "besu-probe"}} and sp["policyTypes"] == ["Egress", "Ingress"] and "ingress" not in sp, f"{party}: besu policy selects the probe, Egress+Ingress, ingress none")
        want = [{"to": [{"podSelector": {"matchLabels": {"app.kubernetes.io/name": "besu-validator"}}}], "ports": [{"protocol": "TCP", "port": 8545}]},
                {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]}]
        check(sp["egress"] == want, f"{party}: besu egress = own besu-validator pods :8545 + kube-dns only: {sp['egress']}")
    # vote: one qbft_proposeValidatorVote(<addr>, false) call, prints only the boolean
    o, _ = besu_run(party, ["--op", "propose", "--address", A8[4], "--drop"], {"qbft_proposeValidatorVote": {"jsonrpc": "2.0", "id": 1, "result": True}})
    check(o == f"VOTE drop {A8[4][:10]} true" and calls == [("qbft_proposeValidatorVote", [A8[4], False])], f"{party}: propose drop = ONE call (addr, false), prints only the boolean: {o!r} {calls}")
    o, _ = besu_run(party, ["--op", "propose", "--address", A8[4], "--add"], {"qbft_proposeValidatorVote": {"jsonrpc": "2.0", "id": 1, "result": True}})
    check(o == f"VOTE add {A8[4][:10]} true" and calls == [("qbft_proposeValidatorVote", [A8[4], True])], f"{party}: propose add = (addr, true): {o!r} {calls}")
    o, _ = besu_run(party, ["--op", "propose", "--address", A8[4], "--drop"], {"qbft_proposeValidatorVote": {"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "Method not enabled"}}})
    check(o == "ERROR", f"{party}: propose, error body (e.g. method not enabled) -> ERROR: {o!r}")
    o, _ = besu_run(party, ["--op", "discard", "--address", A8[4]], {"qbft_discardValidatorVote": {"jsonrpc": "2.0", "id": 1, "result": True}})
    check(o == f"DISCARD {A8[4][:10]} true" and calls == [("qbft_discardValidatorVote", [A8[4]])], f"{party}: discard = ONE call: {o!r} {calls}")
    o, _ = besu_run(party, ["--op", "pending"], {"qbft_getPendingVotes": {"jsonrpc": "2.0", "id": 1, "result": {A8[4]: False, A8[5]: True}}})
    check(o == f"pending 2: {A8[4][:10]}=drop {A8[5][:10]}=add", f"{party}: pending votes: {o!r}")
# legacy validators (S5b: the OLD QBFT validators in ns `besu`, R19 (b)3, cluster-admin by the operator): party `legacy-<N>` (N=1..4) -> ns besu, Service besu-node-validator-<N>:8545;
# THREE objects: Pod besu-probe, NetworkPolicy besu-probe (egress to that old validator pod :8545 + kube-dns), NetworkPolicy s5b-vote-ingress-<N> (ingress to that ONE old validator from the probe pod only, :8545).
for n in (1, 2, 3, 4):
    ds = docs(f"legacy-{n}", "besu", "--image", IMG, "--op", "propose", "--address", A8[4], "--drop")
    check([d["kind"] for d in ds] == ["Pod", "NetworkPolicy", "NetworkPolicy"] and all(d["metadata"]["namespace"] == "besu" for d in ds), f"legacy-{n}: Pod + 2 NetworkPolicy in ns besu: {[(d['kind'], d['metadata'].get('namespace')) for d in ds]}")
    if len(ds) == 3:
        cmd = ds[0]["spec"]["containers"][0]["command"][2]; m = re.search(r"echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash$", cmd); src = base64.b64decode(m.group(1)).decode() if m else ""
        sel = {"app.kubernetes.io/namespace": "besu", "app.kubernetes.io/part-of": f"besu-node-validator-{n}", "app.kubernetes.io/release": f"validator-{n}"}
        check(m is not None and f"/dev/tcp/besu-node-validator-{n}/8545" in src and "python" not in cmd and ds[1]["spec"]["egress"][0] == {"to": [{"podSelector": {"matchLabels": sel}}], "ports": [{"protocol": "TCP", "port": 8545}]}, f"legacy-{n}: bash /dev/tcp to that ONE old validator, egress to it only")
        # behaviour: run the script against the canned server (bash /dev/tcp), host replaced by loopback + the server port
        for ans, want in (({"jsonrpc": "2.0", "id": 1, "result": True}, f"VOTE drop {A8[4][:10]} true"), ({"jsonrpc": "2.0", "id": 1, "result": False}, f"VOTE drop {A8[4][:10]} false"), ({"jsonrpc": "2.0", "id": 1, "error": {"code": 1, "message": "x"}}, "ERROR")):
            Canned.answers = {"qbft_proposeValidatorVote": ans}; calls.clear()
            r = subprocess.run(["bash", "-c", src.replace(f"/dev/tcp/besu-node-validator-{n}/8545", f"/dev/tcp/127.0.0.1/{srv.server_address[1]}")], capture_output=True, text=True, timeout=20)
            check(r.stdout.strip() == want and (want == "ERROR" or calls == [("qbft_proposeValidatorVote", [A8[4], False])]), f"legacy-{n}: bash vote prints only the boolean line: {r.stdout!r} {calls}")
        ing = ds[2]["spec"]
        check(ds[2]["metadata"]["name"] == f"s5b-vote-ingress-{n}" and ing["podSelector"] == {"matchLabels": sel} and ing["policyTypes"] == ["Ingress"] and ing["ingress"] == [{"from": [{"podSelector": {"matchLabels": {"rd/egress-locked": "true", "app": "besu-probe"}}}], "ports": [{"protocol": "TCP", "port": 8545}]}], f"legacy-{n}: ingress to that old validator from the probe pod only: {ing}")
for bad in (["legacy-1", "besu", "--image", IMG, "--op", "read"], ["legacy-5", "besu", "--image", IMG, "--op", "read"], ["legacy-1", "--image", IMG], ["legacy-1", "negative", "--image", IMG, "--target", "1.1.1.1:443"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")
for bad in (["bi", "besu", "--image", IMG], ["bi", "besu", "--image", IMG, "--op", "x"], ["bi", "besu", "--image", IMG, "--op", "propose"], ["bi", "besu", "--image", IMG, "--op", "propose", "--address", "0x12", "--drop"],
            ["bi", "besu", "--image", IMG, "--op", "propose", "--address", "0x" + "a" * 40], ["bi", "besu", "--image", IMG, "--op", "propose", "--address", "0x" + "a" * 40, "--drop", "--add"],
            ["bi", "besu", "--image", IMG, "--op", "read", "--address", "0x" + "a" * 40], ["bi", "besu", "--image", IMG, "--op", "discard", "--address", "0x" + "a" * 40 + ";id"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")

# ---- msgs mode (R2 live test, lead 2026-11-12): did THIS node receive/record the privacy-group report message? pgroup_queryMessages on the own node (BI = node1), COUNTS and one yes/no only:
#   render.sh <party> --image REF --mode msgs --topic zeto-report-v1 --since 2026-11-12T00:00:00Z [--contains 0x<tx hash>]
# prints `messages N (topic T, since S)`, `newest sent <ts|none>`, and with --contains `contains <hash10>: yes|no`; never a data value, id or group.
TOPIC = "zeto-report-v1"; H2 = "0x" + "9d39af1c" + "0" * 52 + "b479"
def msgs(party, extra, rows):
    ans = {"pgroup_queryMessages": {"jsonrpc": "2.0", "id": 1, "result": rows}}
    return py_out(party, ["--mode", "msgs", "--topic", TOPIC, "--since", "2026-11-12T00:00:00Z"] + extra, ans)[0]
ROWS = [{"id": U1, "sent": "2026-11-12T00:10:00Z", "topic": TOPIC, "data": {"txHash": H2, "amount": "SECRET-AMOUNT"}}, {"id": U2, "sent": "2026-11-12T00:20:00Z", "topic": TOPIC, "data": {"txHash": "0x" + "ab" * 32}}]
for party in NUM:
    o = msgs(party, [], ROWS)
    check(o == f"messages 2 (topic {TOPIC}, since 2026-11-12T00:00:00Z)\nnewest sent 2026-11-12T00:20:00Z", f"{party}: msgs, count + newest sent only: {o!r}")
    o = msgs(party, ["--contains", H2], ROWS)
    check(o is not None and o.splitlines()[-1] == f"contains {H2[:10]}: yes" and "SECRET" not in o, f"{party}: msgs --contains present -> yes, never the data: {o!r}")
    o = msgs(party, ["--contains", "0x" + "cd" * 32], ROWS)
    check(o is not None and o.splitlines()[-1] == "contains 0xcdcdcdcd: no", f"{party}: msgs --contains absent -> no: {o!r}")
    check(msgs(party, [], []) == f"messages 0 (topic {TOPIC}, since 2026-11-12T00:00:00Z)\nnewest sent none", f"{party}: msgs, empty -> 0 / none")
    o = py_out(party, ["--mode", "msgs", "--topic", TOPIC, "--since", "2026-11-12T00:00:00Z"], {"pgroup_queryMessages": {"jsonrpc": "2.0", "id": 1, "error": {"code": 1, "message": "x"}}})[0]
    check(o == "ERROR", f"{party}: msgs, error body -> ERROR: {o!r}")
for bad in (["bi", "--image", IMG, "--mode", "msgs"], ["bi", "--image", IMG, "--mode", "msgs", "--topic", "x;id", "--since", "2026-11-12T00:00:00Z"], ["bi", "--image", IMG, "--mode", "msgs", "--topic", TOPIC, "--since", "yesterday"],
            ["bi", "--image", IMG, "--mode", "msgs", "--topic", TOPIC, "--since", "2026-11-12T00:00:00Z", "--contains", "0x12"], ["bi", "--image", IMG, "--mode", "ids", "--topic", TOPIC]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")

for bad in (["bi", "--image", IMG, "--mode", "shape"], ["bi", "--image", IMG, "--mode", "shape", "--tx-hash", "0x12"], ["bi", "--image", IMG, "--mode", "shape", "--tx-hash", "0x" + "g" * 64], ["bi", "--image", IMG, "--mode", "ids", "--tx-hash", H], ["bi", "--image", IMG, "--mode", "schemas", "--tx-hash", H, "--zeto-token", "0x12"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")

# ---- negative egress probe: a throwaway pod labelled app=paladin (so paladin-egress selects it) that must NOT reach the targets; a positive control proves the probe works.
for party in NUM:
    ns = f"rd-zeto-{party}"
    ds = docs(party, "negative", "--image", IMG, "--target", "1.1.1.1:443", "--target", "172.24.18.52:8548")
    check(len(ds) == 1 and ds[0]["kind"] == "Pod", f"{party}: negative = ONE Pod (the policy under test is paladin-egress, not ours)")
    if len(ds) != 1: continue
    p = ds[0]; sp = p["spec"]; c = sp["containers"][0]; lab = p["metadata"]["labels"]
    check(p["metadata"]["name"] == "egress-negative-probe" and p["metadata"]["namespace"] == ns, f"{party}: name/namespace")
    check(lab.get("app") == "paladin" and "rd/egress-locked" not in lab and lab.get("probe") == "egress-negative", f"{party}: labelled app=paladin (selected by paladin-egress), NOT rd/egress-locked: {lab}")
    check(sp.get("automountServiceAccountToken") is False and "volumes" not in sp and "env" not in c and "envFrom" not in c and "serviceAccountName" not in sp, f"{party}: no token, no Secret, no env, no volume")
    check(c["image"] == IMG and c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}} and sp["securityContext"].get("runAsNonRoot") is True, f"{party}: digest image, hardened")
    cmd = c["command"][2]
    check(cmd.count("nc -w 3") == 3 and "1.1.1.1 443" in cmd and "172.24.18.52 8548" in cmd and "paladin-pg 5432" in cmd, f"{party}: nc to the 2 targets and the paladin-pg control only: {cmd}")
    check(sp["restartPolicy"] == "Never" and sp.get("activeDeadlineSeconds", 999) <= 60, f"{party}: Never + deadline <= 60 s")
    # lead's risk (2026-11-12): the probe must NEVER become a Service endpoint (live traffic would hit it). 1) a readiness probe that never passes, 2) no known Service selector is a subset of the probe's labels.
    check(c.get("readinessProbe", {}).get("exec", {}).get("command") == ["false"], f"{party}: readinessProbe exec false (never Ready, so never an endpoint): {c.get('readinessProbe')}")
    n = NUM[party]
    paladin_sel = [{"app": "paladin", "app.kubernetes.io/instance": f"node{n}", "app.kubernetes.io/name": f"paladin-node{n}", "app.kubernetes.io/part-of": "paladin"},   # operator Service paladin-node<N> (read live 2026-11-12)
                   {"app": "paladin", "app.kubernetes.io/name": f"paladin-node{n}"},                                                                                           # paladin-transport (render.sh transport)
                   {"app": "bank-gw", "node": f"node{n}"}, {"app": "paladin-pg"}, {"app": "bundle-server"}, {"app.kubernetes.io/name": "besu-validator"}]
    check(not any(all(lab.get(k) == v for k, v in sel.items()) for sel in paladin_sel), f"{party}: no known Service selector selects the probe's label set {lab}")
    # behaviour: fake nc: refuses everything except paladin-pg -> BLOCKED BLOCKED CONTROL OPEN
    ncp = os.path.join(d, "nc"); open(ncp, "w").write("#!/bin/sh\n[ \"$3\" = paladin-pg ] && exit 0\nexit 1\n"); os.chmod(ncp, 0o755)
    r = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
    check(r.stdout.split() == ["T1", "BLOCKED", "T2", "BLOCKED", "CONTROL", "OPEN"], f"{party}: behaviour: prints only T1/T2 BLOCKED and CONTROL OPEN: {r.stdout!r}")
    ncp2 = os.path.join(d, "nc"); open(ncp2, "w").write("#!/bin/sh\nexit 0\n"); os.chmod(ncp2, 0o755)
    r = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
    check(r.stdout.split() == ["T1", "OPEN", "T2", "OPEN", "CONTROL", "OPEN"], f"{party}: behaviour: reachable targets print OPEN: {r.stdout!r}")
for bad in (["bi", "negative", "--image", IMG], ["bi", "negative", "--image", IMG, "--target", "1.1.1.1"], ["bi", "negative", "--image", IMG, "--target", "1.1.1.1:443;id"], ["bi", "negative", "--image", IMG, "--target", "host:443"], ["bi", "negative", "--image", "busybox:1.36", "--target", "1.1.1.1:443"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")

# ---- lbpath probe (lead 2026-11-12, R17 risk; run it with --via ipblock AND --via selector, as two pods, same target): does the CNI match `ipBlock <LB>/32` for a same-cluster peer's LB IP, or only the selector form? One Pod + ONE temp NetworkPolicy
# with a single rule, and a control (1.1.1.1:443 must be BLOCKED by that same policy, so the policy is proven to be enforced).
for party in NUM:
    ns = f"rd-zeto-{party}"; peer = "bank-b" if party != "bank-b" else "bank-a"
    for via in ("ipblock", "selector"):
        args = [party, "lbpath", "--image", IMG, "--target", "8.215.47.22:9000", "--via", via] + (["--peer-ns", f"rd-zeto-{peer}"] if via == "selector" else [])
        ds = docs(*args)
        check([d["kind"] for d in ds] == ["Pod", "NetworkPolicy"], f"{party}/{via}: lbpath = Pod + ONE NetworkPolicy: {[d['kind'] for d in ds]}")
        if len(ds) != 2: continue
        pod, pol = ds; lab = pod["metadata"]["labels"]; c = pod["spec"]["containers"][0]
        check(pod["metadata"]["name"] == f"lb-path-probe-{via}" and pol["metadata"]["name"] == f"lb-path-probe-{via}" and all(d["metadata"]["namespace"] == ns for d in ds), f"{party}/{via}: names + namespace")
        check(lab.get("rd/egress-locked") == "true" and lab.get("app") == "lb-path-probe" and lab.get("probe") == f"lb-path-{via}", f"{party}/{via}: rd/egress-locked=true (excluded from allow-dns-egress after R17-0), app=lb-path-probe, never app=paladin: {lab}")
        check(c.get("readinessProbe", {}).get("exec", {}).get("command") == ["false"] and pod["spec"].get("automountServiceAccountToken") is False and "volumes" not in pod["spec"] and "env" not in c, f"{party}/{via}: never Ready, no token, no volume, no env")
        sp = pol["spec"]
        check(sp["podSelector"] == {"matchLabels": {"probe": f"lb-path-{via}"}} and sp["policyTypes"] == ["Egress"] and len(sp["egress"]) == 1 and sp["egress"][0]["ports"] == [{"protocol": "TCP", "port": 9000}], f"{party}/{via}: policy selects ONLY the probe, ONE egress rule on TCP 9000: {sp}")
        want = [{"ipBlock": {"cidr": "8.215.47.22/32"}}] if via == "ipblock" else [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"rd-zeto-{peer}"}}, "podSelector": {"matchLabels": {"app": "paladin"}}}]
        check(sp["egress"][0]["to"] == want, f"{party}/{via}: the rule is exactly {want}: {sp['egress'][0]['to']}")
        cmd = c["command"][2]
        check(cmd.count("nc -w 3") == 2 and "8.215.47.22 9000" in cmd and "1.1.1.1 443" in cmd, f"{party}/{via}: nc to the target and the 1.1.1.1:443 control only: {cmd}")
        for ncbody, want_out in (("exit 0", ["TARGET", "OPEN", "CONTROL", "OPEN"]), ("sleep 3; exit 1", ["TARGET", "BLOCKED", "CONTROL", "BLOCKED"]), ('[ "$4" = 9000 ] && exit 1; sleep 3; exit 1', ["TARGET", "REFUSED", "CONTROL", "BLOCKED"])):
            ncp = os.path.join(d, "nc"); open(ncp, "w").write(f"#!/bin/sh\n{ncbody}\n"); os.chmod(ncp, 0o755)
            r = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, env={"PATH": d + ":/usr/bin:/bin"})
            check(r.stdout.split() == want_out, f"{party}/{via}: behaviour {ncbody!r} -> {want_out}: {r.stdout!r}")
for bad in (["bi", "lbpath", "--image", IMG, "--target", "8.215.47.22:9000"], ["bi", "lbpath", "--image", IMG, "--target", "8.215.47.22:9000", "--via", "selector"],
            ["bi", "lbpath", "--image", IMG, "--target", "8.215.47.22:9000", "--via", "ipblock", "--peer-ns", "rd-zeto-bank-a"], ["bi", "lbpath", "--image", IMG, "--target", "8.215.47.22:9000", "--via", "selector", "--peer-ns", "rd-zeto-bi"],
            ["bi", "lbpath", "--image", IMG, "--target", "8.215.47.22:9000", "--via", "selector", "--peer-ns", "kube-system"], ["bi", "lbpath", "--image", IMG, "--target", "8.215.47.22:9000;id", "--via", "ipblock"],
            ["bi", "lbpath", "--image", IMG, "--via", "ipblock"], ["bi", "lbpath", "--image", IMG, "--target", "8.215.47.22:9000", "--via", "x"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")

for bad in (["bi"], ["bi", "--image", "busybox:1.36"], ["bi", "--image", IMG, "--mode", "xx"], ["bi", "--image", IMG, "--method", "x; rm"], ["bi", "--image", IMG, "--params", "[\"'; id\"]"],
            ["bank-d", "--image", IMG], ["bi", "--image", IMG, "--extra"]):
    check(run(*bad).returncode == 2, f"render.sh {' '.join(bad)} must be refused with 2")
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print("OK node probe pod: 4 parties checked")
