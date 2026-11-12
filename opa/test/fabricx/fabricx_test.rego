# Fabric-X rules (bi.platform.fabricx + bank.platform.fabricx), both bundles together as gw dispatches target=fabricx.
# Documents: the fixture BI document as the Fabric-X one, and a bank document that deals with every party (so one
# document serves each gateway in these tests) unless a test patches it.
package fabricx_test

import data.bank.platform.fabricx as bank
import data.bi.platform.fabricx as bi
import data.fabricx_pki as pki
import data.fixtures
import data.gw

# Thursday 2026-11-05 10:00 WIB; the day starts 2026-11-04T17:00:00Z.
now_ns := time.parse_rfc3339_ns("2026-11-05T03:00:00Z")

# Public CA certificates the BI document carries (data.bi.config.fabricx_ca): per node, the org's Fabric-X TLS root (peer gateways)
# and bank-gw-ca-<N> (Lensa). Test PKI: gen-pki.sh.
fx_ca := {
	"gw": {"node1": pki.ca_gw1, "node2": pki.ca_gw2, "node3": pki.ca_gw3, "node4": pki.ca_gw4},
	"lensa": {"node1": pki.ca_lensa1, "node2": pki.ca_lensa2, "node3": pki.ca_lensa3, "node4": pki.ca_lensa4},
}

bi_cfg(patch) := object.union(fixtures.bi, {"policy": {"fabricx": object.union(fixtures.bi_doc, patch)}, "fabricx_ca": fx_ca})

bank_doc := {"counterparties": ["bi@node1", "bankA@node2", "bankB@node3", "bankC@node4"]}

bank_cfg(patch) := {"policy": {"fabricx": object.union(bank_doc, patch)}}

# What Envoy forwards (forward_client_cert_details SANITIZE_SET, cert: true): the verified client leaf, URL-encoded PEM.
xfcc(pem) := sprintf("Hash=00;Cert=\"%s\";Subject=\"x\"", [urlquery.encode(pem)])

lensa_leaf := {"node1": pki.lensa_leaf1, "node2": pki.lensa_leaf2, "node3": pki.lensa_leaf3, "node4": pki.lensa_leaf4}

door_with(node, body, headers) := {
	"attributes": {
		"contextExtensions": {"target": "fabricx", "node": node},
		"request": {"http": {"method": "POST", "headers": headers}},
	},
	"parsed_body": body,
}

door_as(node, body, pem) := door_with(node, body, {"x-forwarded-client-cert": xfcc(pem)})

# The default caller is Lensa with its own party's client certificate.
door(node, body) := door_as(node, body, lensa_leaf[node])

# Both bundles must allow, as in gw; no http.send unless a test mocks one.
allowed_with(node, body, bi_patch, bank_patch) if {
	bi.allow with input as door(node, body) with data.bi.config as bi_cfg(bi_patch) with time.now_ns as now_ns
	bank.allow with input as door(node, body) with data.bi.config as bi_cfg(bi_patch)
		with data.bank.config as bank_cfg(bank_patch) with time.now_ns as now_ns
}

allowed(node, body) if allowed_with(node, body, {}, {})

# Same, but the caller presents the given certificate (PEM).
allowed_as(node, body, pem) if {
	bi.allow with input as door_as(node, body, pem) with data.bi.config as bi_cfg({}) with time.now_ns as now_ns
	bank.allow with input as door_as(node, body, pem) with data.bi.config as bi_cfg({})
		with data.bank.config as bank_cfg({}) with time.now_ns as now_ns
}

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

# --- caller identity (S16): the XFCC leaf must verify against the right CA; Lensa everything, a peer gateway precheck and report only

swap23 := precheck(swap("bank2", "bank3"))

test_lensa_own_ca_ok_every_node if {
	every n in ["node1", "node2", "node3", "node4"] {
		allowed(n, {"op": "balance"})
	}
}

test_no_client_cert_denied if {
	i := {"attributes": {"contextExtensions": {"target": "fabricx", "node": "node3"}, "request": {"http": {"method": "POST"}}}, "parsed_body": swap23}
	not bi.allow with input as i with data.bi.config as bi_cfg({}) with time.now_ns as now_ns
	i2 := door_with("node3", swap23, {"x-forwarded-client-cert": "Hash=00;Subject=\"CN=lensa\""})
	not bi.allow with input as i2 with data.bi.config as bi_cfg({}) with time.now_ns as now_ns
	i3 := door_with("node3", swap23, {"x-forwarded-client-cert": "Hash=00;Cert=\"not-a-cert\""})
	not bi.allow with input as i3 with data.bi.config as bi_cfg({}) with time.now_ns as now_ns
}

test_two_cert_elements_denied if {
	one := xfcc(pki.peer_2_org2)
	i := door_with("node3", swap23, {"x-forwarded-client-cert": concat(",", [one, one])})
	not bi.allow with input as i with data.bi.config as bi_cfg({}) with time.now_ns as now_ns
}

test_lensa_cert_from_another_ca_denied if {
	# CN=lensa signed by an org root, and CN=lensa of node2's CA at node1's gateway
	not allowed_as("node1", {"op": "balance"}, pki.lensa_by_gw)
	not allowed_as("node1", {"op": "balance"}, pki.lensa_leaf2)
	allowed_as("node1", {"op": "balance"}, pki.lensa_leaf1)
}

test_peer_org_ca_precheck_only if {
	# org 2's gateway asks node 3's gateway for the counterparty leg
	allowed_as("node3", swap23, pki.peer_2_org2)
	not allowed_as("node3", {"op": "report"}, pki.peer_2_org2)
	not allowed_as("node3", {"op": "balance"}, pki.peer_2_org2)
	not allowed_as("node3", {"op": "usage"}, pki.peer_2_org2)
	not allowed_as("node3", swap("bank3", "bank2"), pki.peer_2_org2)
	not allowed_as("node3", transfer("bank3", "bank2", "5"), pki.peer_2_org2)
	not allowed_as("node3", {"op": "issue", "to": "bank2", "type": "RD", "amount": "1"}, pki.peer_2_org2)
}

test_peer_report_denied_everywhere if {
	every n in ["node1", "node3", "node4"] {
		not allowed_as(n, {"op": "report"}, pki.peer_2_org2)
	}
}

# BI liveness probe (redeliver.go:270, serve.go:260-265): usage of RD since "now" at BI's gateway.
usage_since(sec) := {"op": "usage", "type": "RD", "since": time.format([now_ns + (sec * 1000000000), "UTC"])}

test_peer_usage_probe_at_node1_allowed if {
	allowed_as("node1", usage_since(0), pki.peer_2_org2)
	allowed_as("node1", usage_since(-59), pki.peer_2_org2)
	allowed_as("node1", usage_since(-60), pki.peer_2_org2)
	allowed_as("node1", usage_since(59), pki.peer_2_org2)
}

test_peer_usage_old_or_far_future_since_denied if {
	not allowed_as("node1", usage_since(-86400), pki.peer_2_org2)
	not allowed_as("node1", usage_since(-61), pki.peer_2_org2)
	not allowed_as("node1", usage_since(61), pki.peer_2_org2)
}

test_peer_usage_not_at_node1_denied if {
	# a peer of another org each time (a gateway never calls itself)
	not allowed_as("node2", usage_since(0), pki.peer_3_org3)
	not allowed_as("node3", usage_since(0), pki.peer_2_org2)
	not allowed_as("node4", usage_since(0), pki.peer_2_org2)
}

test_peer_usage_wrong_type_or_since_denied if {
	not allowed_as("node1", object.union(usage_since(0), {"type": "DFABI-2027A"}), pki.peer_2_org2)
	not allowed_as("node1", object.remove(usage_since(0), ["type"]), pki.peer_2_org2)
	not allowed_as("node1", object.union(usage_since(0), {"since": "yesterday"}), pki.peer_2_org2)
	not allowed_as("node1", object.union(usage_since(0), {"since": 12}), pki.peer_2_org2)
	not allowed_as("node1", object.remove(usage_since(0), ["since"]), pki.peer_2_org2)
}

test_lensa_usage_old_since_still_allowed if {
	allowed("node1", {"op": "usage", "type": "RD", "since": "2020-01-01T00:00:00Z"})
	allowed("node1", {"op": "usage", "type": "RD"})
}

test_peer_other_reads_at_node1_denied if {
	every op in ["balance", "history", "records", "finality"] {
		not allowed_as("node1", {"op": op, "type": "RD", "since": usage_since(0).since}, pki.peer_2_org2)
	}
}

test_peer_cn_of_another_org_denied if {
	# CN fx-gw-1-peer under org 3's root, and under a Lensa CA
	not allowed_as("node3", swap23, pki.peer_1_org3)
	not allowed_as("node3", {"op": "report"}, pki.peer_1_org3)
	not allowed_as("node3", swap23, pki.peer_1_lensa)
}

test_peer_wrong_cn_or_usage_denied if {
	not allowed_as("node3", swap23, pki.peer_server_cn)
	not allowed_as("node3", swap23, pki.peer_server_eku)
}

test_peer_is_not_lensa_and_not_itself if {
	not allowed_as("node3", swap23, pki.peer_3_org3)
	not allowed_as("node1", swap23, pki.peer_2_org2)
}

# --- c7 matrix (orchestrator option a): party X's Lensa leaf works only at X's gateway, on every WRITE op as well (the checks above use reads); issue/award are node1's.
own_write := {
	"node1": {"op": "issue", "to": "bank3", "type": "RD", "amount": "1"},
	"node2": transfer("bank2", "bank3", "5"),
	"node3": transfer("bank3", "bank2", "5"),
	"node4": transfer("bank4", "bank2", "5"),
}

cross_pairs := {[n, m] |
	some n in ["node1", "node2", "node3", "node4"]
	some m in ["node1", "node2", "node3", "node4"]
	n != m
}

test_own_leaf_own_write_allowed_matrix if every n in ["node1", "node2", "node3", "node4"] {
	allowed_as(n, own_write[n], lensa_leaf[n])
}

# the SAME request at gateway n, presented with the Lensa leaf of every other party: denied
test_cross_party_lensa_leaf_on_a_write_denied_matrix if every p in cross_pairs {
	not allowed_as(p[0], own_write[p[0]], lensa_leaf[p[1]])
}

# issue / award at the issuer gateway are not reachable for a bank's Lensa leaf even when the body is valid for node1
test_issue_with_a_bank_leaf_denied if every m in ["node2", "node3", "node4"] {
	not allowed_as("node1", own_write.node1, lensa_leaf[m])
	not allowed_as("node1", award_pc("bank3"), lensa_leaf[m])
}

# a peer gateway identity (CN fx-gw-<M>-peer from org M's root) is denied on EVERY op except precheck / the node1 usage probe, on every gateway
test_peer_identity_denied_on_every_write_matrix if every n in ["node1", "node2", "node3", "node4"] {
	not allowed_as(n, own_write[n], pki.peer_2_org2)
	not allowed_as(n, own_write[n], pki.peer_3_org3)
}

# a peer CN issued by the wrong root (a Lensa CA, another org's root) is denied even on precheck
test_peer_wrong_issuer_denied_on_precheck if {
	not allowed_as("node3", swap23, pki.peer_1_lensa)
	not allowed_as("node3", swap23, pki.peer_1_org3)
}
