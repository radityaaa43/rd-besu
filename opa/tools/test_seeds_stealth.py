#!/usr/bin/env python3 -I
"""Stealth seed documents (2026-11-13): every seed file carries a `stealth` document, and with those seeds (BI = opa/seeds/bi.json, each bank =
its seed) the stealth rules allow the user's whole scenario at the right gateway: RD issue BI->banks, DFABI issue BI->BI, award (offer at BI's
gateway), RD + DFABI transfers bank->bank, DvP offer/bid/escrow/legs/settle. Lensa's PolicyStore creates v1 of a platform from these seeds.
Run from besu/opa: python3 -I tools/test_seeds_stealth.py (needs `opa` on PATH or OPA_BIN)."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OPA_DIR = os.path.dirname(HERE)
OPA = os.environ.get("OPA_BIN", "opa")
fails = []
check = lambda ok, msg: None if ok else fails.append(msg)

seeds = {n: json.load(open(os.path.join(OPA_DIR, "seeds", f"{n}.json"))) for n in ("bi", "bank-bi", "bank-a", "bank-b", "bank-c")}
for n, s in seeds.items():
    check("stealth" in s, f"seeds/{n}.json has a stealth document")
if fails:
    print("FAIL", *fails, sep="\n  - "); sys.exit(1)

data = json.load(open(os.path.join(OPA_DIR, "bundles/bi/bi/config/data.json")))
meta = {v: k for k, v in data["stealth_meta"].items()}  # node -> meta-address
bank_seed = {"node1": "bank-bi", "node2": "bank-a", "node3": "bank-b", "node4": "bank-c"}
party = {"node1": "BI", "node2": "A", "node3": "B", "node4": "C"}

def allowed(node, path, body):
    cfg = dict(data, policy={"stealth": seeds["bi"]["stealth"]})
    overlay = {"bi": {"config": cfg}, "bank": {"config": {"policy": {"stealth": seeds[bank_seed[node]]["stealth"]}}}}
    inp = {"attributes": {"contextExtensions": {"target": "stealth", "node": node}, "source": {"principal": "CN=lensa"},
                          "request": {"http": {"method": "POST", "path": path}}}, "parsed_body": body}
    with tempfile.TemporaryDirectory() as d:
        json.dump(overlay, open(os.path.join(d, "data.json"), "w")); json.dump(inp, open(os.path.join(d, "input.json"), "w"))
        q = "x := [data.bi.platform.stealth.allow, data.bank.platform.stealth.allow]"
        r = subprocess.run([OPA, "eval", "-f", "json", "-i", os.path.join(d, "input.json"),
                            "-d", os.path.join(OPA_DIR, "bundles/bi/bi/platform"), "-d", os.path.join(OPA_DIR, "bundles/bi/bi/clock"),
                            "-d", os.path.join(OPA_DIR, "bundles/bi/bi/ident"), "-d", os.path.join(OPA_DIR, "bundles/bank/bank/platform"),
                            "-d", os.path.join(OPA_DIR, "bundles/bank/bank/ident"), "-d", os.path.join(d, "data.json"), q], capture_output=True, text=True)
        if r.returncode != 0: return f"opa error: {r.stderr[-300:]}"
        return json.loads(r.stdout)["result"][0]["bindings"]["x"] == [True, True]

def intent(kind, frm, to, amount): return {"kind": kind, "from": frm, "to": {"metaAddress": meta[to]}, "amount": amount}

cases = [("node1", "/intent", intent("rd-mint", "BI", n, "3000000"), f"rd-issue BI->{party[n]} 3000000") for n in ("node2", "node3", "node4")]
cases += [("node1", "/intent", intent("bond-issue", "BI", "node1", "3"), "dfabi-issue BI->BI 3")]
cases += [("node1", "/dvp/offer", {"tradeId": "0x01", "amount": "1", "buyerMeta": meta[n]}, f"award offer BI->{party[n]}") for n in ("node2", "node3", "node4")]
cases += [(n, "/dvp/bid", {"tradeId": "0x01", "price": "1000000", "sellerMeta": meta["node1"]}, f"award bid {party[n]}") for n in ("node2", "node3", "node4")]
cases += [("node1", "/dvp/escrow", {"tradeId": "0x01", "bondAmount": "1", "rdAmount": "1000000"}, "escrow at BI")]
cases += [("node1", "/intent", {"kind": "dvp-leg", "leg": "bond", "from": "BI", "amount": "1", "escrow": "0xe5"}, "award bond leg BI")]
pairs = [("node2", "node3"), ("node3", "node4"), ("node4", "node2"), ("node2", "node4"), ("node4", "node3"), ("node3", "node2")]
for f, t in pairs:
    cases += [(f, "/intent", intent("rd-transfer", party[f], t, "7"), f"rd-transfer {party[f]}->{party[t]} 7"),
              (f, "/intent", intent("bond-transfer", party[f], t, "1"), f"dfabi-transfer {party[f]}->{party[t]} 1")]
for f, t in [("node2", "node3"), ("node3", "node4"), ("node4", "node2")]:
    cases += [(f, "/dvp/offer", {"tradeId": "0x02", "amount": "1", "buyerMeta": meta[t]}, f"dvp offer {party[f]}->{party[t]}"),
              (t, "/dvp/bid", {"tradeId": "0x02", "price": "1000000", "sellerMeta": meta[f]}, f"dvp bid {party[t]}"),
              (f, "/intent", {"kind": "dvp-leg", "leg": "bond", "from": party[f], "amount": "1", "escrow": "0xe5"}, f"dvp bond leg {party[f]}"),
              (t, "/intent", {"kind": "dvp-leg", "leg": "rd", "from": party[t], "amount": "1000000", "escrow": "0xe5"}, f"dvp rd leg {party[t]}"),
              (t, "/dvp/settle", {"escrow": "0xe5"}, f"settle {party[t]}")]
for node, path, body, name in cases:
    r = allowed(node, path, body)
    check(r is True, f"seeds allow {name} (got {r})")
# and the seeds still refuse what the scenario never does
check(allowed("node2", "/intent", intent("rd-mint", "A", "node3", "1")) is False, "seeds: a bank cannot mint")
check(allowed("node1", "/intent", intent("bond-issue", "BI", "node2", "1")) is False, "seeds: DFABI is issued to BI only")
if fails:
    print("FAIL", *fails, sep="\n  - "); sys.exit(1)
print(f"OK stealth seeds: 5 files carry stealth; {len(cases)} scenario writes allowed, 2 refusals hold")
