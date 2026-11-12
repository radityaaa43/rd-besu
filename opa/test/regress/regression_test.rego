# REGRESSION TEMPLATE for every bundle publish (S17 lesson, 2026-11-12: the first bundle shipped without the Kebijakan documents and passed a regression
# that only tested reads and denies). It runs against a CANDIDATE bundle set: `opa/tools/regress.sh <bi.tar.gz> <bank-a.tar.gz> <bank-b.tar.gz> <bank-c.tar.gz>`
# loads the candidate documents as data.candidate; without a candidate it runs against test/fixtures.rego (so CI keeps the template itself honest).
# In-hours WRITE per function with the party's OWN identity = allow; another party's identity = deny; boundaries exact; counterparty allow/deny;
# the report group = allow. Outsider-C-sealed and the live 4/4 read are LIVE checks: opa/tools/PUBLISH-REGRESSION.md.
package regress_test

import data.fabricx_pki as pki
import data.fixtures
import data.gw

# With a candidate loaded there is NO fallback to the fixtures: a missing document must fail the tests, not be papered over.
has_candidate if data.candidate

bi_cfg := data.candidate.bi if has_candidate

bi_cfg := fixtures.bi if not has_candidate

bank_cfg(n) := data.candidate.bank[n] if has_candidate

bank_cfg(_) := fixtures.bank_a if not has_candidate

# Thursday 2026-11-12 05:00Z = 12:00 WIB, inside any normal operating hours.
at_noon(i, bank) if {
	gw.allow with input as i with data.bi.config as caller_cfg with data.bank.config as bank_cfg(bank) with time.now_ns as time.parse_rfc3339_ns("2026-11-12T05:00:00Z")
}

rd := [c | some c, t in bi_cfg.zeto.contracts; t == "RD"][0]

dfabi := [c | some c, t in bi_cfg.zeto.contracts; t == "DFABI"][0]

# c7: the candidate's own caller_binding stays in force; its lensa_ca (real PEMs) is replaced by the TEST CAs and every request carries the matching test Lensa leaf,
# so the template exercises the binding path without a live certificate. The caller rule itself is pinned in test/caller.
caller_cfg := object.union(bi_cfg, {"lensa_ca": {"node1": pki.ca_lensa1, "node2": pki.ca_lensa2, "node3": pki.ca_lensa3, "node4": pki.ca_lensa4}})

leaf_of := {"node1": pki.lensa_leaf1, "node2": pki.lensa_leaf2, "node3": pki.lensa_leaf3, "node4": pki.lensa_leaf4}

xfcc(pem) := sprintf("Hash=00;Cert=\"%s\";Subject=\"x\"", [urlquery.encode(pem)])

door(node, body) := {"attributes": {"contextExtensions": {"target": "paladin", "node": node}, "request": {"http": {"headers": {"x-forwarded-client-cert": xfcc(leaf_of[node])}}}}, "parsed_body": body}

rpc(node, method, params) := door(node, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})

send(node, tx) := rpc(node, "ptx_sendTransaction", [tx])

zeto(c, from, fn, args) := {"type": "private", "domain": "zeto", "to": c, "from": from, "function": fn, "data": args}

banks := {"bank-a": {"node": "node2", "id": "bankA@node2"}, "bank-b": {"node": "node3", "id": "bankB@node3"}, "bank-c": {"node": "node4", "id": "bankC@node4"}}

# a counterparty of this bank taken from ITS OWN document, other than BI (the recipient of its writes)
peer(b) := [c | some c in bank_cfg(b).policy.zeto.counterparties; c != "bi@node1"][0]

# another bank's identity (never its own)
other_id(b) := [v.id | some o, v in banks; o != b][0]

amount_cap(token) := bi_cfg_policy.max_per_tx[token]

bi_cfg_policy := data.candidate.bi.policy.zeto if has_candidate

bi_cfg_policy := fixtures.bi_doc if not has_candidate

test_every_bank_writes_in_hours_with_its_own_identity if {
	every b, v in banks {
		to := peer(b)
		at_noon(send(v.node, zeto(rd, v.id, "transfer", {"transfers": [{"to": to, "amount": 1, "data": "0x"}]})), b)
		at_noon(send(v.node, zeto(rd, v.id, "createLock", {"from": v.id, "recipients": [{"to": to, "amount": 1}], "data": "0x"})), b)
		at_noon(rpc(v.node, "ptx_prepareTransaction", [zeto(rd, v.id, "spendLock", {"lockId": "0x01", "from": v.id, "data": "0x"})]), b)
		at_noon(send(v.node, {"type": "public", "to": rd, "from": v.id, "function": "delegateLock", "data": {}}), b)
		at_noon(send(v.node, zeto(rd, v.id, "cancelLock", {"lockId": "0x01", "from": v.id, "data": "0x"})), b)
	}
}

test_bi_mints_in_hours_and_no_bank_does if {
	at_noon(send("node1", zeto(rd, "bi@node1", "mint", {"mints": [{"to": "bankA@node2", "amount": 1}]})), "bank-a")
	every b, v in banks {
		not at_noon(send(v.node, zeto(rd, v.id, "mint", {"mints": [{"to": v.id, "amount": 1}]})), b)
	}
}

test_another_identity_on_the_gateway_denied if {
	every b, v in banks {
		other := other_id(b)
		not at_noon(send(v.node, zeto(rd, other, "transfer", {"transfers": [{"to": v.id, "amount": 1, "data": "0x"}]})), b)
	}
}

test_amount_boundary_is_exact if {
	cap := amount_cap("RD")
	at_noon(send("node2", zeto(rd, "bankA@node2", "transfer", {"transfers": [{"to": "bankB@node3", "amount": cap, "data": "0x"}]})), "bank-a")
	not at_noon(send("node2", zeto(rd, "bankA@node2", "transfer", {"transfers": [{"to": "bankB@node3", "amount": cap + 1, "data": "0x"}]})), "bank-a")
}

test_non_participant_recipient_denied if {
	not at_noon(send("node2", zeto(rd, "bankA@node2", "transfer", {"transfers": [{"to": "bankZ@node9", "amount": 1, "data": "0x"}]})), "bank-a")
}

test_unknown_function_and_unknown_contract_denied if {
	not at_noon(send("node2", zeto(rd, "bankA@node2", "burnEverything", {})), "bank-a")
	not at_noon(send("node2", zeto("0x00000000000000000000000000000000deadbeef", "bankA@node2", "transfer", {"transfers": [{"to": "bankB@node3", "amount": 1, "data": "0x"}]})), "bank-a")
}

test_report_group_of_each_bank_allowed_and_the_wrong_one_denied if {
	every b, v in banks {
		g := bi_cfg.nodes[v.node].report_group
		at_noon(rpc(v.node, "pgroup_sendMessage", [{"domain": "pente", "group": g, "topic": "zeto-report-v1", "data": {}}]), b)
		other := bi_cfg.nodes[banks[peer_bank(b)].node].report_group
		not at_noon(rpc(v.node, "pgroup_sendMessage", [{"domain": "pente", "group": other, "topic": "zeto-report-v1", "data": {}}]), b)
	}
}

peer_bank(b) := [o | some o, _ in banks; o != b][0]

# The documents must be there at all (the S17 bundle had none: every write was "closed").
test_the_documents_exist if {
	bi_cfg_policy.hours.RD
	bi_cfg_policy.hours.DFABI
	bi_cfg_policy.max_per_tx.RD
}
