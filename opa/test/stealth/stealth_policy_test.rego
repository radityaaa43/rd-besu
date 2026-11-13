# Stealth Kebijakan (2026-11-13, user: "ya buat kebijakan OPA untuk stealth"): bi.platform.stealth + bank.platform.stealth enforce the
# policy.stealth documents (same schema as zeto/noto/fabricx) on the value-moving signer routes, from the request body Envoy sends to OPA.
# Counterparties are party ids; a body names a party by its stealth meta-address, mapped to a node by data.bi.config.stealth_meta.
package stealth_policy_test

import data.bank.platform.stealth as bank
import data.bi.platform.stealth as bi
import data.fixtures

# Thursday 2026-11-05 10:00 WIB
now_ns := time.parse_rfc3339_ns("2026-11-05T03:00:00Z")

meta := {
	"node1": "0x031111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
	"node2": "0x032222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222", "node3": "0x033333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333", "node4": "0x034444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444444",
}

stealth_meta := {m: n | some n, m in meta}

party := {"node1": "BI", "node2": "A", "node3": "B", "node4": "C"}

bi_cfg(patch) := object.union(fixtures.bi, {"policy": {"stealth": object.union(fixtures.bi_doc, patch)}, "stealth_meta": stealth_meta})

bank_doc := {"counterparties": ["bi@node1", "bankA@node2", "bankB@node3", "bankC@node4"]}

bank_cfg(patch) := {"policy": {"stealth": object.union(bank_doc, patch)}}

door(node, path, body) := {
	"attributes": {
		"contextExtensions": {"target": "stealth", "node": node},
		"source": {"principal": "CN=lensa"},
		"request": {"http": {"method": "POST", "path": path}},
	},
	"parsed_body": body,
}

allowed_with(node, path, body, bi_patch, bank_patch) if {
	bi.allow with input as door(node, path, body) with data.bi.config as bi_cfg(bi_patch) with time.now_ns as now_ns
	bank.allow with input as door(node, path, body) with data.bi.config as bi_cfg(bi_patch)
		with data.bank.config as bank_cfg(bank_patch) with time.now_ns as now_ns
}

allowed(node, path, body) if allowed_with(node, path, body, {}, {})

intent(kind, from, to_node, amount) := {"kind": kind, "from": from, "to": {"metaAddress": meta[to_node]}, "amount": amount}

# --- in-hours write per function, with the own party's identity ---

test_rd_mint_bi_to_bank if allowed("node1", "/intent", intent("rd-mint", "BI", "node2", "3000000"))

test_dfabi_issue_bi_to_itself if allowed("node1", "/intent", intent("bond-issue", "BI", "node1", "3"))

test_rd_transfer_bank_to_bank if allowed("node2", "/intent", intent("rd-transfer", "A", "node3", "7"))

test_dfabi_transfer_bank_to_bank if allowed("node3", "/intent", intent("bond-transfer", "B", "node4", "1"))

test_dvp_offer_bid_escrow_legs_settle_cancel if {
	allowed("node2", "/dvp/offer", {"tradeId": "0x01", "amount": "1", "buyerMeta": meta.node3})
	allowed("node3", "/dvp/bid", {"tradeId": "0x01", "price": "1000000", "sellerMeta": meta.node2})
	allowed("node1", "/dvp/escrow", {"tradeId": "0x01", "bondAmount": "1", "rdAmount": "1000000"})
	allowed("node2", "/intent", {"kind": "dvp-leg", "leg": "bond", "from": "A", "amount": "1", "escrow": "0xe5"})
	allowed("node3", "/intent", {"kind": "dvp-leg", "leg": "rd", "from": "B", "amount": "1000000", "escrow": "0xe5"})
	allowed("node3", "/dvp/settle", {"escrow": "0xe5"})
	allowed("node2", "/dvp/cancel", {"escrow": "0xe5"})
}

test_award_bi_offers_dfabi_to_a_bank if allowed("node1", "/dvp/offer", {"tradeId": "0x02", "amount": "1", "buyerMeta": meta.node4})

# --- caps: exact = allow, +1 = deny ---

test_max_per_tx_exact_allowed_plus_one_denied if {
	allowed_with("node2", "/intent", intent("rd-transfer", "A", "node3", "7"), {"max_per_tx": {"RD": 7}}, {})
	not allowed_with("node2", "/intent", intent("rd-transfer", "A", "node3", "8"), {"max_per_tx": {"RD": 7}}, {})
	not allowed_with("node2", "/dvp/offer", {"tradeId": "0x01", "amount": "2", "buyerMeta": meta.node3}, {"max_per_tx": {"DFABI": 1}}, {})
	not allowed_with("node3", "/dvp/bid", {"tradeId": "0x01", "price": "1000001", "sellerMeta": meta.node2}, {"max_per_tx": {"RD": 1000000}}, {})
	not allowed_with("node3", "/intent", {"kind": "dvp-leg", "leg": "rd", "from": "B", "amount": "1000001", "escrow": "0xe5"}, {"max_per_tx": {"RD": 1000000}}, {})
}

test_mint_cap_exact_allowed_plus_one_denied if {
	allowed_with("node1", "/intent", intent("rd-mint", "BI", "node2", "5"), {"max_mint_per_tx": {"RD": 5}}, {})
	not allowed_with("node1", "/intent", intent("rd-mint", "BI", "node2", "6"), {"max_mint_per_tx": {"RD": 5}}, {})
}

test_bank_own_cap_denies if not allowed_with("node2", "/intent", intent("rd-transfer", "A", "node3", "8"), {}, {"max_per_tx": {"RD": 7}})

# --- who may do what ---

test_bank_cannot_mint_or_issue if {
	not allowed("node2", "/intent", intent("rd-mint", "A", "node3", "1"))
	not allowed("node2", "/intent", intent("bond-issue", "A", "node2", "1"))
}

test_dfabi_issue_only_to_bi if not allowed("node1", "/intent", intent("bond-issue", "BI", "node2", "1"))

test_escrow_only_at_bi_gateway if not allowed("node2", "/dvp/escrow", {"tradeId": "0x01", "bondAmount": "1", "rdAmount": "1000000"})

test_other_party_identity_denied if {
	not allowed("node2", "/intent", intent("rd-transfer", "B", "node3", "7"))
	not allowed("node3", "/intent", {"kind": "dvp-leg", "leg": "rd", "from": "A", "amount": "1", "escrow": "0xe5"})
}

test_to_self_and_unknown_meta_denied if {
	not allowed("node2", "/intent", intent("rd-transfer", "A", "node2", "7"))
	not allowed("node2", "/intent", {"kind": "rd-transfer", "from": "A", "to": {"metaAddress": "0x039999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999"}, "amount": "7"})
	not allowed("node2", "/dvp/offer", {"tradeId": "0x01", "amount": "1", "buyerMeta": meta.node2})
}

test_non_counterparty_denied if {
	not allowed_with("node2", "/intent", intent("rd-transfer", "A", "node3", "7"), {}, {"counterparties": ["bankC@node4"]})
	not allowed_with("node2", "/dvp/offer", {"tradeId": "0x01", "amount": "1", "buyerMeta": meta.node3}, {}, {"counterparties": ["bankC@node4"]})
}

test_frozen_party_denied if not allowed_with("node2", "/intent", intent("rd-transfer", "A", "node3", "7"), {"frozen": ["bankB@node3"]}, {})

test_closed_hours_denied if {
	closed := {"hours": {"RD": {"days": [1], "open": "00:00", "close": "24:00"}}}
	not allowed_with("node2", "/intent", intent("rd-transfer", "A", "node3", "7"), closed, {})
}

test_malformed_amount_denied if {
	not allowed("node2", "/intent", intent("rd-transfer", "A", "node3", "07"))
	not allowed("node2", "/intent", intent("rd-transfer", "A", "node3", "-1"))
	not allowed("node2", "/intent", intent("rd-transfer", "A", "node3", 7))
}

test_no_stealth_document_denies_writes_not_reads if {
	cfg := object.remove(bi_cfg({}), ["policy"])
	not bi.allow with input as door("node2", "/intent", intent("rd-transfer", "A", "node3", "7")) with data.bi.config as cfg with time.now_ns as now_ns
	bi.allow with input as {"attributes": {
		"contextExtensions": {"target": "stealth", "node": "node2"}, "source": {"principal": "CN=lensa"},
		"request": {"http": {"method": "GET", "path": "/holdings"}},
	}}
		with data.bi.config as cfg with time.now_ns as now_ns
}
