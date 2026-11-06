# Fabric-X rules (bi.platform.fabricx + bank.platform.fabricx), both bundles together as gw dispatches target=fabricx.
# Documents: the fixture BI document as the Fabric-X one, and a bank document that deals with every party (so one
# document serves each gateway in these tests) unless a test patches it.
package fabricx_test

import data.bank.platform.fabricx as bank
import data.bi.platform.fabricx as bi
import data.fixtures
import data.gw

# Thursday 2026-11-05 10:00 WIB; the day starts 2026-11-04T17:00:00Z.
now_ns := time.parse_rfc3339_ns("2026-11-05T03:00:00Z")

bi_cfg(patch) := object.union(fixtures.bi, {"policy": {"fabricx": object.union(fixtures.bi_doc, patch)}})

bank_doc := {"counterparties": ["bi@node1", "bankA@node2", "bankB@node3", "bankC@node4"]}

bank_cfg(patch) := {"policy": {"fabricx": object.union(bank_doc, patch)}}

door(node, body) := {
	"attributes": {
		"contextExtensions": {"target": "fabricx", "node": node},
		"request": {"http": {"method": "POST"}},
	},
	"parsed_body": body,
}

# Both bundles must allow, as in gw; no http.send unless a test mocks one.
allowed_with(node, body, bi_patch, bank_patch) if {
	bi.allow with input as door(node, body) with data.bi.config as bi_cfg(bi_patch) with time.now_ns as now_ns
	bank.allow with input as door(node, body) with data.bi.config as bi_cfg(bi_patch)
		with data.bank.config as bank_cfg(bank_patch) with time.now_ns as now_ns
}

allowed(node, body) if allowed_with(node, body, {}, {})

transfer(from, to, amount) := {"op": "transfer", "from": from, "to": to, "type": "RD", "amount": amount}

swap(from, to) := {
	"op": "swap", "id": "s-1", "from": from, "to": to,
	"give": {"type": "DFABI-2027A", "amount": "2"}, "get": {"type": "RD", "amount": "2000000"},
}

precheck(s) := object.union(s, {"op": "precheck", "kind": "swap"})

award_pc(to) := {
	"op": "precheck", "kind": "award", "id": "a-1", "from": "issuer", "to": to,
	"give": {"type": "DFABI-2027A", "amount": "3"}, "get": {"type": "RD", "amount": "3000000"},
}

closed := {"RD": {"days": [1, 2, 3, 4, 5], "open": "11:00", "close": "15:00"}}

frozen_c := {"frozen": ["bankC@node4"]}

# --- reads and the door itself

test_reads_any_node if {
	every n in ["node1", "node2", "node3", "node4"] {
		every op in ["balance", "history", "records", "finality", "report", "usage"] {
			allowed(n, {"op": op})
		}
	}
}

test_get_denied if {
	i := object.union(door("node2", {"op": "balance"}), {"attributes": {"request": {"http": {"method": "GET"}}}})
	not bi.allow with input as i with data.bi.config as bi_cfg({})
}

test_unknown_op_denied if {
	not allowed("node2", {"op": "mint", "from": "bank2", "to": "bank3", "type": "RD", "amount": "1"})
	not allowed("node2", {"op": "setup-pp"})
	not allowed("node2", {})
}

test_no_fabricx_document_denies_writes if {
	cfg := object.remove(fixtures.bi, ["policy"])
	not bi.allow with input as door("node2", transfer("bank2", "bank3", "1")) with data.bi.config as cfg
	not bi.allow with input as door("node2", transfer("bank2", "bank3", "1"))
		with data.bi.config as object.union(cfg, {"policy": {"zeto": fixtures.bi_doc}})
}

# --- issue and award: issuer node only

test_issue if {
	allowed("node1", {"op": "issue", "to": "bank3", "type": "RD", "amount": "1000000000000000"})
	not allowed("node1", {"op": "issue", "to": "bank3", "type": "RD", "amount": "1000000000000001"})
	not allowed("node2", {"op": "issue", "to": "bank3", "type": "RD", "amount": "1"})
	not allowed("node1", {"op": "issue", "to": "issuer", "type": "RD", "amount": "1"})
	not allowed("node1", {"op": "issue", "to": "bank3", "type": "USD", "amount": "1"})
	not allowed_with("node1", {"op": "issue", "to": "bank4", "type": "RD", "amount": "1"}, frozen_c, {})
	not allowed_with("node1", {"op": "issue", "to": "bank3", "type": "RD", "amount": "1"}, {"hours": closed}, {})
}

test_award if {
	a := {"op": "award", "id": "a-1", "to": "bank2", "dfabi": "3", "rd": "3000000"}
	allowed("node1", a)
	not allowed("node2", a)
	not allowed("node1", object.union(a, {"id": ""}))
	not allowed("node1", object.union(a, {"rd": "1000000001"}))
	not allowed_with("node1", object.union(a, {"to": "bank4"}), frozen_c, {})
	not allowed_with("node1", a, {"hours": {"DFABI": closed.RD}}, {})
}

# --- transfer

test_transfer if {
	allowed("node2", transfer("bank2", "bank3", "1000000000"))
	allowed("node2", transfer("bank2", "issuer", "5"))
	not allowed("node2", transfer("bank2", "bank3", "1000000001"))
	not allowed("node2", transfer("bank3", "bank4", "1"))
	not allowed("node2", transfer("bank2", "bank2", "1"))
	not allowed("node2", transfer("bank2", "bank9", "1"))
	not allowed("node2", object.union(transfer("bank2", "bank3", "1"), {"type": "DFABI"}))
}

test_transfer_malformed_amounts if {
	every a in ["0", "01", "1.5", "-1", "1e3", " 1", "", "123456789012345678901"] {
		not allowed("node2", transfer("bank2", "bank3", a))
	}
	not allowed("node2", object.union(transfer("bank2", "bank3", "1"), {"amount": 1}))
}

test_transfer_frozen if {
	not allowed_with("node2", transfer("bank2", "bank4", "1"), frozen_c, {})
	not allowed_with("node4", transfer("bank4", "bank2", "1"), frozen_c, {})
	allowed_with("node2", transfer("bank2", "bank3", "1"), frozen_c, {})
}

# Frozen in another platform's document only: Fabric-X is not affected.
test_transfer_frozen_other_platform if {
	cfg := object.union(bi_cfg({}), {"policy": {"zeto": frozen_c}})
	bi.allow with input as door("node2", transfer("bank2", "bank4", "1")) with data.bi.config as cfg with time.now_ns as now_ns
}

test_transfer_bi_hours if {
	not allowed_with("node2", transfer("bank2", "bank3", "1"), {"hours": closed}, {})
	not allowed_with("node2", transfer("bank2", "bank3", "1"), {"holidays": [{"date": "2026-11-05", "name": "x"}]}, {})
}

# --- the bank's own document

test_bank_counterparties if {
	not allowed_with("node2", transfer("bank2", "bank3", "1"), {}, {"counterparties": ["bi@node1", "bankC@node4"]})
	allowed_with("node2", transfer("bank2", "bank4", "1"), {}, {"counterparties": ["bi@node1", "bankC@node4"]})
}

test_bank_cap_and_hours if {
	not allowed_with("node2", transfer("bank2", "bank3", "11"), {}, {"max_per_tx": {"RD": 10}})
	allowed_with("node2", transfer("bank2", "bank3", "10"), {}, {"max_per_tx": {"RD": 10}})
	not allowed_with("node2", transfer("bank2", "bank3", "1"), {}, {"hours": closed})
	allowed_with("node2", transfer("bank2", "bank3", "1"), {}, {"hours": {"DFABI": closed.RD}})
}

# --- swap (DvP) and its precheck at the buyer's gateway

test_swap if {
	allowed("node2", swap("bank2", "bank3"))
	not allowed("node3", swap("bank2", "bank3"))
	not allowed("node2", swap("bank2", "issuer"))
	not allowed("node2", swap("bank2", "bank2"))
	not allowed("node2", object.union(swap("bank2", "bank3"), {"get": {"type": "DFABI-2027A"}}))
	not allowed("node2", object.union(swap("bank2", "bank3"), {"get": {"amount": "1000000001"}}))
	not allowed("node2", object.union(swap("bank2", "bank3"), {"give": {"amount": "1001"}}))
	not allowed("node2", object.union(swap("bank2", "bank3"), {"id": "no spaces"}))
	not allowed_with("node2", swap("bank2", "bank3"), {"hours": {"DFABI": closed.RD}}, {})
	not allowed_with("node2", swap("bank2", "bank4"), frozen_c, {})
}

test_precheck_swap_at_buyer if {
	allowed("node3", precheck(swap("bank2", "bank3")))
	not allowed("node2", precheck(swap("bank2", "bank3")))
	not allowed("node4", precheck(swap("bank2", "bank3")))
	not allowed_with("node4", precheck(swap("bank2", "bank4")), frozen_c, {})

	# the buyer does not deal with the seller
	not allowed_with("node3", precheck(swap("bank2", "bank3")), {}, {"counterparties": ["bi@node1", "bankC@node4"]})

	# the buyer's own cap on what it pays (RD), and its hours
	not allowed_with("node3", precheck(swap("bank2", "bank3")), {}, {"max_per_tx": {"RD": 1999999}})
	not allowed_with("node3", precheck(swap("bank2", "bank3")), {}, {"hours": closed})
}

test_precheck_award_at_bank if {
	allowed("node4", award_pc("bank4"))
	not allowed("node3", award_pc("bank4"))
	not allowed("node4", object.union(award_pc("bank4"), {"from": "bank2"}))
	not allowed("node4", object.union(award_pc("bank4"), {"get": {"type": "DFABI-2027A"}}))
	not allowed_with("node4", award_pc("bank4"), frozen_c, {})
	not allowed_with("node4", award_pc("bank4"), {}, {"counterparties": ["bankB@node3"]})
}

# --- redeem

test_redeem if {
	r := {"op": "redeem", "from": "bank2", "type": "RD", "amount": "50"}
	allowed("node2", r)
	not allowed("node3", r)
	not allowed("node2", object.union(r, {"amount": "1000000001"}))
	not allowed_with("node4", object.union(r, {"from": "bank4"}), frozen_c, {})
}

# --- daily limit from the party's own token records (fxapi usage, mocked)

usage_req(req, t) if {
	req.url == "http://127.0.0.1:8080/"
	req.method == "POST"
	req.timeout == "2s"
	req.cache == false
	req.raise_error == false
	req.body == {"op": "usage", "type": t, "since": "2026-11-04T17:00:00Z"}
}

used_900(req) := {"status_code": 200, "body": {"amount": "900"}} if usage_req(req, "RD")

down(req) := {"status_code": 0, "error": {"message": "connection refused"}} if usage_req(req, "RD")

bad_body(req) := {"status_code": 200, "body": {"amount": 900}} if usage_req(req, "RD")

limit := {"daily_limit": {"RD": 1000}}

test_daily_limit if {
	allowed_with("node2", transfer("bank2", "bank3", "100"), {}, limit) with http.send as used_900
	not allowed_with("node2", transfer("bank2", "bank3", "101"), {}, limit) with http.send as used_900
	not allowed_with("node2", {"op": "redeem", "from": "bank2", "type": "RD", "amount": "101"}, {}, limit) with http.send as used_900

	# the buyer's RD leg counts at the buyer's gateway
	not allowed_with("node3", precheck(swap("bank2", "bank3")), {}, limit) with http.send as used_900
}

test_daily_limit_fails_closed if {
	not allowed_with("node2", transfer("bank2", "bank3", "1"), {}, limit) with http.send as down
	not allowed_with("node2", transfer("bank2", "bank3", "1"), {}, limit) with http.send as bad_body
}

# No limit for the token: no query at all (the mock answers nothing for DFABI, so a query would deny).
test_daily_limit_other_token_no_query if {
	allowed_with("node2", object.union(transfer("bank2", "bank3", "1"), {"type": "DFABI-2027A"}), {}, limit) with http.send as down
	allowed_with("node2", swap("bank2", "bank3"), {}, limit) with http.send as down
}

# --- through gw.allow (noto's dispatch): target only from Envoy's context_extensions

test_gw_dispatch if {
	i := door("node2", transfer("bank2", "bank3", "1"))
	gw.allow with input as i with data.bi.config as bi_cfg({}) with data.bank.config as bank_cfg({}) with time.now_ns as now_ns
	not gw.allow with input as i with data.bi.config as bi_cfg({"frozen": ["bankB@node3"]})
		with data.bank.config as bank_cfg({}) with time.now_ns as now_ns
	not gw.allow with input as i with data.bi.config as bi_cfg({})
		with data.bank.config as bank_cfg({"counterparties": ["bi@node1"]}) with time.now_ns as now_ns

	# a Fabric-X body on the Paladin door is not a Fabric-X request
	p := object.union(i, {"attributes": {"contextExtensions": {"target": "paladin"}}})
	not gw.allow with input as p with data.bi.config as bi_cfg({}) with data.bank.config as bank_cfg({}) with time.now_ns as now_ns
}
