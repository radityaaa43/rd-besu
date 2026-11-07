# Iroha 3 rules (bi.platform.iroha3 + bank.platform.iroha3), both bundles together as gw dispatches target=iroha3.
# The txdec sidecar (decode, intent decode, intent lookup, usage) is mocked with `with http.send as ...`: the decoder's
# answer is the rawBody itself, a JSON text of a golden fixture (iroha3_golden), so a test builds a variant inline.
# Documents: the fixture BI document as the Iroha 3 one, and a bank document that deals with every party unless patched.
package iroha3_test

import data.bank.platform.iroha3 as bank
import data.bi.platform.iroha3 as bi
import data.fixtures
import data.gw
import data.iroha3_golden as g

# Thursday 2026-11-05 10:00 WIB; the day starts 2026-11-04T17:00:00Z.
now_ns := time.parse_rfc3339_ns("2026-11-05T03:00:00Z")

bi_cfg(patch) := object.union(fixtures.bi, {
	"iroha3": g.structure,
	"policy": {"iroha3": object.union(fixtures.bi_doc, patch)},
})

bank_doc := {"counterparties": ["bi@node1", "bankA@node2", "bankB@node3", "bankC@node4"]}

bank_cfg(patch) := {"policy": {"iroha3": object.union(bank_doc, patch)}}

door(node, method, path, ct, raw) := {"attributes": {
	"contextExtensions": {"target": "iroha3", "node": node},
	"request": {"http": {"method": method, "path": path, "headers": {"content-type": ct}, "rawBody": raw}},
}}

tx_in(node, view) := door(node, "POST", "/v1/pipeline/transactions", "application/x-norito", json.marshal(view))

reg_in(node, answer) := door(node, "POST", "/gw/intent", "application/json", json.marshal(answer))

get(node, path) := door(node, "GET", path, "", "")

post(node, path) := door(node, "POST", path, "application/json", "")

# --- the sidecar, mocked. Every request must have the contract's shape (url, method, headers, timeout, no cache, no raise).

sidecar := "http://127.0.0.1:8090"

shape(req, p) if {
	req.url == concat("", [sidecar, p])
	req.method == "POST"
	req.headers == {"content-type": "application/json"}
	req.timeout == "2s"
	req.cache == false
	req.raise_error == false
}

unprocessable := {"ok": false, "error": {"code": "decode_failed", "message": "x"}}

decode(req) := {"status_code": 200, "body": json.unmarshal(req.body.b64)} if {
	shape(req, "/decode")
	req.body.ct == "application/x-norito"
	req.body.b64 != "bad"
}

decode(req) := {"status_code": 422, "body": unprocessable} if {
	shape(req, "/decode")
	req.body.b64 == "bad"
}

intent_decode(req) := {"status_code": 200, "body": json.unmarshal(req.body.b64)} if {
	shape(req, "/intent/decode")
	req.body.b64 != "bad"
}

intent_decode(req) := {"status_code": 422, "body": unprocessable} if {
	shape(req, "/intent/decode")
	req.body.b64 == "bad"
}

lookup(req) := {"status_code": 200, "body": object.get(g.intents, req.body.intent_hash, {"status": "unknown"})} if shape(req, "/intent/lookup")

usage_today := {"RD": "900", "DFABI": "8"}

usage(req) := {"status_code": 200, "body": {"amount": usage_today[req.body.token], "complete": true}} if {
	shape(req, "/usage")
	req.body.since == "2026-11-04T17:00:00Z"
}

mock(req) := decode(req)

mock(req) := intent_decode(req)

mock(req) := lookup(req)

mock(req) := usage(req)

# usage store unreachable / bad body / journal incomplete
mock_usage_down(req) := decode(req)

mock_usage_down(req) := intent_decode(req)

mock_usage_down(req) := lookup(req)

mock_usage_down(req) := {"status_code": 0, "error": {"message": "connection refused"}} if shape(req, "/usage")

mock_usage_bad(req) := decode(req)

mock_usage_bad(req) := intent_decode(req)

mock_usage_bad(req) := lookup(req)

mock_usage_bad(req) := {"status_code": 200, "body": {"amount": 900, "complete": true}} if shape(req, "/usage")

mock_usage_incomplete(req) := decode(req)

mock_usage_incomplete(req) := intent_decode(req)

mock_usage_incomplete(req) := lookup(req)

mock_usage_incomplete(req) := {"status_code": 200, "body": {"amount": "0", "complete": false}} if shape(req, "/usage")

# the decoder answers 500 / nothing at all
mock_decode_500(req) := {"status_code": 500, "body": {"ok": true}} if shape(req, "/decode")

mock_decode_500(req) := {"status_code": 500, "body": {"ok": true}} if shape(req, "/intent/decode")

mock_decode_down(req) := {"status_code": 0, "error": {"message": "connection refused"}} if shape(req, "/decode")

mock_decode_down(req) := {"status_code": 0, "error": {"message": "connection refused"}} if shape(req, "/intent/decode")

mock_lookup_500(req) := decode(req)

mock_lookup_500(req) := {"status_code": 500, "body": {"status": "active", "buyer": "x"}} if shape(req, "/intent/lookup")

mock_lookup_down(req) := decode(req)

mock_lookup_down(req) := {"status_code": 0, "error": {"message": "connection refused"}} if shape(req, "/intent/lookup")

mock_lookup_wrong_hash(req) := decode(req)

mock_lookup_wrong_hash(req) := {"status_code": 200, "body": g.intent("active", g.b_acct, g.other_hash)} if shape(req, "/intent/lookup")

# nothing may be called
mock_none(_) := {"status_code": 0, "error": {"message": "no sidecar"}}

# --- both bundles must allow, as in gw

allowed_with(i, bi_patch, bank_patch) if {
	bi.allow with input as i with data.bi.config as bi_cfg(bi_patch) with time.now_ns as now_ns
	bank.allow with input as i with data.bi.config as bi_cfg(bi_patch)
		with data.bank.config as bank_cfg(bank_patch) with time.now_ns as now_ns
}

allowed(i) if allowed_with(i, {}, {}) with http.send as mock

bi_only(i) if bi.allow with input as i with data.bi.config as bi_cfg({}) with time.now_ns as now_ns with http.send as mock

bank_only(i) if {
	bank.allow with input as i with data.bi.config as bi_cfg({}) with data.bank.config as bank_cfg({})
		with time.now_ns as now_ns with http.send as mock
}

closed := {"RD": {"days": [1, 2, 3, 4, 5], "open": "11:00", "close": "15:00"}}

frozen_c := {"frozen": ["bankC@node4"]}

# a transaction of one instruction signed by `who`
one(who, i) := g.tx(who, [i])

rd_tr(q, from, to) := one(from, g.transfer(g.rd, q, from, to))

dfabi_tr(q, from, to) := one(from, g.transfer(g.dfabi, q, from, to))

# --- the golden fixtures, at the gateway of the party that signs

test_golden_allowed if {
	allowed(tx_in("node2", g.transfer_rd))
	allowed(tx_in("node2", g.transfer_dfabi))
	allowed(tx_in("node1", g.mint_rd))
	allowed(tx_in("node1", g.burn_rd))
	allowed(tx_in("node2", g.dvp_settlement))
	allowed(tx_in("node3", g.dvp_consent))
	allowed(reg_in("node3", g.dvp_registration))
}

test_golden_unknown_denied if {
	not allowed(tx_in("node2", g.unknown_kind))
	not bi_only(tx_in("node2", g.unknown_kind))
}

test_golden_at_the_wrong_gateway_denied if {
	not allowed(tx_in("node3", g.transfer_rd))
	not allowed(tx_in("node4", g.transfer_rd))
	not allowed(tx_in("node1", g.transfer_rd))
	not allowed(tx_in("node2", g.dvp_consent))
	not allowed(tx_in("node4", g.dvp_consent))
}

# --- reads: an explicit list, no sidecar call

test_reads_allowed if {
	every n in ["node1", "node2", "node3", "node4"] {
		every p in [
			"/health", "/status", "/v1/nexus/lifecycle", "/v1/node/capabilities",
			"/v1/pipeline/transactions/status", "/v1/pipeline/transactions/status?hash=3b1c",
			"/v1/accounts/acct-a-0002/transactions", "/v1/accounts/acct-a-0002/transactions?limit=5",
		] {
			allowed(get(n, p)) with http.send as mock_none
		}
		every p in ["/v1/fees/quote", "/v1/query", "/v1/pipeline/transactions/details", "/gw/usage"] {
			allowed(post(n, p)) with http.send as mock_none
		}
	}
}

test_other_gets_denied if {
	every p in [
		"/", "/metrics", "/v1/transactions/history", "/v1/pipeline/transactions", "/v1/pipeline/transaction-entrypoints",
		"/v1/pipeline/transactions/batch", "/v1/pipeline/transactions/", "/v1/sumeragi/status", "/v1/explorer/blocks",
		"/v1/events", "/v1/soracloud/state", "/v1/accounts/x/transactions/extra", "/v1/accounts//transactions",
		"/v1/accounts/a/b/transactions", "/health/../v1/events", "/healthz", "/status/x", "/gw/intent", "/gw/usage",
		"/intent/lookup", "/decode", "/usage",
	] {
		not allowed(get("node2", p))
	}
}

test_other_posts_denied if {
	every p in [
		"/", "/health", "/status", "/v1/pipeline/transaction-entrypoints", "/v1/pipeline/transactions/batch",
		"/v1/pipeline/transactions/status", "/v1/pipeline/transactions/", "/v1/pipeline/transactions/x", "/v1/accounts/x/transactions",
		"/v1/soracloud/deploy", "/v1/iso20022/pacs008", "/v1/fees/quote/x", "/v1/query/", "/gw/intent/lookup", "/gw/usage/x",
		"/gw/seed", "/intent/lookup", "/intent/decode", "/decode", "/usage",
	] {
		not allowed(post("node2", p))
	}
}

# a tx-shaped route is denied even with a clean Norito body the decoder would pass
test_tx_shaped_routes_denied if {
	every p in [
		"/v1/pipeline/transaction-entrypoints", "/v1/pipeline/transactions/batch", "/v1/pipeline/transactions/",
		"/v1/pipeline/transactions/x", "/v1/pipeline/transactionsx", "/v1/soranet/declare",
	] {
		not allowed(door("node2", "POST", p, "application/x-norito", json.marshal(g.transfer_rd)))
	}
}

test_wrong_method_on_tx_routes_denied if {
	not allowed(door("node2", "GET", "/v1/pipeline/transactions", "application/x-norito", json.marshal(g.transfer_rd)))
	not allowed(door("node2", "PUT", "/v1/pipeline/transactions", "application/x-norito", json.marshal(g.transfer_rd)))
	not allowed(door("node3", "GET", "/gw/intent", "application/json", json.marshal(g.dvp_registration)))
	not allowed(door("node2", "DELETE", "/health", "", ""))
}

# the query string does not turn the transaction route into another path or hide it
test_tx_route_with_query_string if allowed(door("node2", "POST", "/v1/pipeline/transactions?x=1", "application/x-norito", json.marshal(g.transfer_rd)))

# --- body and decoder: fail closed

test_json_body_on_tx_route_denied if {
	i := door("node2", "POST", "/v1/pipeline/transactions", "application/json", json.marshal(g.transfer_rd))
	not allowed(i)
	not allowed(door("node2", "POST", "/v1/pipeline/transactions", "application/json; charset=utf-8", json.marshal(g.transfer_rd)))
	not allowed(door("node2", "POST", "/v1/pipeline/transactions", "application/x-norito; v=1", json.marshal(g.transfer_rd)))
	not allowed(door("node2", "POST", "/v1/pipeline/transactions", "", json.marshal(g.transfer_rd)))
}

# the header check holds on its own: a decoder that wrongly answers 200 for a JSON content type still gets no allow
mock_any_ct(req) := {"status_code": 200, "body": json.unmarshal(req.body.b64)} if shape(req, "/decode")

test_json_header_denied_without_the_decoder_help if {
	json_ct := door("node2", "POST", "/v1/pipeline/transactions", "application/json", json.marshal(g.transfer_rd))
	not allowed_with(json_ct, {}, {}) with http.send as mock_any_ct
	allowed_with(tx_in("node2", g.transfer_rd), {}, {}) with http.send as mock_any_ct
}

# the sidecar says the body was JSON although the header said Norito
test_decoder_says_json_denied if not allowed(tx_in("node2", object.union(g.transfer_rd, {"encoding": "json"})))

test_decoder_not_200_denied if {
	i := tx_in("node2", g.transfer_rd)
	not allowed_with(i, {}, {}) with http.send as mock_decode_500
	not allowed_with(i, {}, {}) with http.send as mock_decode_down
	not allowed(tx_in("node2", "bad"))
	not allowed(door("node2", "POST", "/v1/pipeline/transactions", "application/x-norito", "bad"))
	not bi_only(door("node2", "POST", "/v1/pipeline/transactions", "application/x-norito", "bad"))
	not bank_only(door("node2", "POST", "/v1/pipeline/transactions", "application/x-norito", "bad"))
}

# the bank bundle denies on its own when the decoder fails: BI's package alone is not what protects here
test_bank_denies_when_decoder_fails if {
	i := tx_in("node2", g.transfer_rd)
	not bank.allow with input as i with data.bi.config as bi_cfg({}) with data.bank.config as bank_cfg({})
		with time.now_ns as now_ns with http.send as mock_decode_500
	not bank.allow with input as i with data.bi.config as bi_cfg({}) with data.bank.config as bank_cfg({})
		with time.now_ns as now_ns with http.send as mock_decode_down
}

test_decoder_ok_false_with_200_denied if {
	not allowed(tx_in("node2", {"ok": false, "error": {"code": "non_canonical", "message": "x"}}))
	not allowed(tx_in("node2", {}))
	not allowed(tx_in("node2", {"ok": true}))
}

test_decoder_missing_fields_denied if {
	every f in ["encoding", "executable", "signature_ok", "has_multisig", "instructions", "authority"] {
		not allowed(tx_in("node2", object.remove(g.transfer_rd, [f])))
	}
	every f in ["kind", "asset_definition", "quantity", "scale", "from", "to", "scope", "dataspace"] {
		not allowed(tx_in("node2", one(g.a_acct, object.remove(g.transfer(g.rd, "1", g.a_acct, g.b_acct), [f]))))
	}
}

test_exec_kinds_denied if {
	every e in ["contract_call", "ivm", "ivm_proved"] {
		not allowed(tx_in("node2", object.union(g.transfer_rd, {"executable": e, "instructions": []})))
		not allowed(tx_in("node2", object.union(g.transfer_rd, {"executable": e})))
	}
	not allowed(tx_in("node2", object.union(g.transfer_rd, {"executable": "batch"})))
}

test_unknown_and_other_instructions_denied if {
	every i in [
		{"kind": "unknown", "raw_kind": "iroha.log"},
		{"kind": "unknown", "raw_kind": "contract_call"},
		{"kind": "register", "object": "account"},
		{"kind": "set_key_value", "target": "account"},
		{"kind": "other"},
		{"kind": "grant", "grant_kind": "role", "permission": null, "payload": null, "to": g.a_acct, "consent": null},
		{"kind": "grant", "grant_kind": "permission", "permission": "CanMint", "payload": null, "to": g.a_acct, "consent": null},
	] {
		not allowed(tx_in("node1", one(g.bi_acct, i)))
		not allowed(tx_in("node2", one(g.a_acct, i)))
	}
}

test_batches_and_unsigned_denied if {
	t := g.transfer(g.rd, "1", g.a_acct, g.b_acct)
	not allowed(tx_in("node2", g.tx(g.a_acct, [t, t])))
	not allowed(tx_in("node2", g.tx(g.a_acct, [])))
	not allowed(tx_in("node2", object.union(g.transfer_rd, {"signature_ok": false})))
	not allowed(tx_in("node2", object.union(g.transfer_rd, {"has_multisig": true})))
}

# --- transfer: BI

test_transfer_cap if {
	allowed(tx_in("node2", rd_tr("1000000000", g.a_acct, g.b_acct)))
	not allowed(tx_in("node2", rd_tr("1000000001", g.a_acct, g.b_acct)))
	allowed(tx_in("node2", dfabi_tr("1000", g.a_acct, g.b_acct)))
	not allowed(tx_in("node2", dfabi_tr("1001", g.a_acct, g.b_acct)))
}

test_transfer_parties if {
	allowed(tx_in("node2", rd_tr("5", g.a_acct, g.bi_acct)))
	not allowed(tx_in("node2", rd_tr("5", g.a_acct, g.a_acct)))
	not allowed(tx_in("node2", rd_tr("5", g.a_acct, "acct-unknown")))

	# the authority is not the debited account
	not allowed(tx_in("node2", one(g.a_acct, g.transfer(g.rd, "5", g.b_acct, g.c_acct))))
	not allowed(tx_in("node3", one(g.a_acct, g.transfer(g.rd, "5", g.b_acct, g.c_acct))))
	not allowed(tx_in("node2", one(g.bi_acct, g.transfer(g.rd, "5", g.a_acct, g.b_acct))))
}

test_transfer_malformed_quantities if {
	every q in ["0", "01", "1.5", "-1", "1e3", " 1", "", "12345678901234567", "abc"] {
		not allowed(tx_in("node2", rd_tr(q, g.a_acct, g.b_acct)))
	}
	not allowed(tx_in("node2", one(g.a_acct, object.union(g.transfer(g.rd, "5", g.a_acct, g.b_acct), {"quantity": 5}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(g.transfer(g.rd, "5", g.a_acct, g.b_acct), {"scale": 2}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(g.transfer(g.rd, "5", g.a_acct, g.b_acct), {"scale": null}))))
}

test_transfer_frozen if {
	not allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.c_acct)), frozen_c, {}) with http.send as mock
	not allowed_with(tx_in("node4", rd_tr("1", g.c_acct, g.a_acct)), frozen_c, {}) with http.send as mock
	allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.b_acct)), frozen_c, {}) with http.send as mock
}

# Frozen in another platform's document only: Iroha 3 is not affected.
test_transfer_frozen_other_platform if {
	cfg := object.union(bi_cfg({}), {"policy": {"zeto": frozen_c}})
	bi.allow with input as tx_in("node2", rd_tr("1", g.a_acct, g.c_acct)) with data.bi.config as cfg
		with time.now_ns as now_ns with http.send as mock
}

test_transfer_hours_and_holidays if {
	not allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.b_acct)), {"hours": closed}, {}) with http.send as mock
	allowed_with(tx_in("node2", dfabi_tr("1", g.a_acct, g.b_acct)), {"hours": closed}, {}) with http.send as mock
	not allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.b_acct)), {"holidays": [{"date": "2026-11-05", "name": "x"}]}, {}) with http.send as mock
	allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.b_acct)), {"holidays": [{"date": "2026-11-06", "name": "x"}]}, {}) with http.send as mock
}

test_no_iroha3_document_or_data_denies_writes if {
	i := tx_in("node2", g.transfer_rd)
	cfg := object.remove(bi_cfg({}), ["policy"])
	not bi.allow with input as i with data.bi.config as cfg with http.send as mock
	not bi.allow with input as i with data.bi.config as object.union(cfg, {"policy": {"zeto": fixtures.bi_doc}}) with http.send as mock
	not bi.allow with input as i with data.bi.config as object.remove(bi_cfg({}), ["iroha3"]) with time.now_ns as now_ns with http.send as mock
}

# --- asset scope and definition: the exact id of the token in data, in dataspace 1

test_asset_scope if {
	t := g.transfer(g.rd, "5", g.a_acct, g.b_acct)
	allowed(tx_in("node2", one(g.a_acct, t)))
	not allowed(tx_in("node2", one(g.a_acct, object.union(t, {"scope": "global", "dataspace": null}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(t, {"scope": "dataspace:2", "dataspace": 2}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(t, {"scope": "dataspace:0", "dataspace": 0}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(t, {"scope": "dataspace:1", "dataspace": 2}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(t, {"scope": "dataspace:2", "dataspace": 1}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(t, {"scope": "global", "dataspace": 1}))))
}

test_asset_scope_dfabi_mint_burn if {
	not allowed(tx_in("node1", one(g.bi_acct, object.union(g.mint(g.dfabi, "5", g.a_acct), {"scope": "global", "dataspace": null}))))
	not allowed(tx_in("node1", one(g.bi_acct, object.union(g.mint(g.dfabi, "5", g.a_acct), {"scope": "dataspace:2", "dataspace": 2}))))
	not allowed(tx_in("node1", one(g.bi_acct, object.union(g.burn(g.dfabi, "5", g.bi_acct), {"scope": "global", "dataspace": null}))))
	not allowed(tx_in("node1", one(g.bi_acct, object.union(g.burn(g.rd, "5", g.bi_acct), {"scope": "dataspace:2", "dataspace": 2}))))
}

test_asset_lookalike_definition_denied if {
	not allowed(tx_in("node2", one(g.a_acct, g.transfer(g.rd_lookalike, "5", g.a_acct, g.b_acct))))
	not allowed(tx_in("node1", one(g.bi_acct, g.mint(g.rd_lookalike, "5", g.a_acct))))
	not allowed(tx_in("node1", one(g.bi_acct, g.burn(g.rd_lookalike, "5", g.bi_acct))))
	not allowed(tx_in("node2", one(g.a_acct, g.transfer("RD", "5", g.a_acct, g.b_acct))))
	not allowed(tx_in("node2", one(g.a_acct, g.transfer("", "5", g.a_acct, g.b_acct))))
}

# the data decides which id is the token: change it and the old id is a look-alike
test_asset_definition_comes_from_data if {
	i := tx_in("node2", g.transfer_rd)
	other := object.union(g.structure, {"assets": {"RD": g.rd_lookalike}})
	not bi.allow with input as i with data.bi.config as object.union(bi_cfg({}), {"iroha3": other})
		with time.now_ns as now_ns with http.send as mock
	not bank.allow with input as i with data.bi.config as object.union(bi_cfg({}), {"iroha3": other})
		with data.bank.config as bank_cfg({}) with time.now_ns as now_ns with http.send as mock
}

# the bank bundle does not let a look-alike or an unknown account pass either, whatever BI says
test_bank_denies_unknown_asset_and_account if {
	not bank_only(tx_in("node2", one(g.a_acct, g.transfer(g.rd_lookalike, "5", g.a_acct, g.b_acct))))
	not bank_only(tx_in("node2", one(g.a_acct, g.transfer(g.rd, "5", g.a_acct, "acct-unknown"))))
	bank_only(tx_in("node2", one(g.a_acct, g.transfer(g.rd, "5", g.a_acct, g.b_acct))))
}

# --- mint and burn: BI only

test_mint if {
	allowed(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "1000000000000000", g.a_acct))))
	not allowed(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "1000000000000001", g.a_acct))))
	allowed(tx_in("node1", one(g.bi_acct, g.mint(g.dfabi, "7", g.b_acct))))

	# BI tops itself up
	allowed(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "7", g.bi_acct))))
	not allowed(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "7", "acct-unknown"))))
}

test_mint_by_a_bank_denied if {
	every n, who in {"node2": g.a_acct, "node3": g.b_acct, "node4": g.c_acct} {
		not allowed(tx_in(n, one(who, g.mint(g.rd, "1", who))))
		not allowed(tx_in(n, one(who, g.mint(g.rd, "1", g.a_acct))))
		not allowed(tx_in(n, one(g.bi_acct, g.mint(g.rd, "1", who))))
	}
	not allowed(tx_in("node1", one(g.a_acct, g.mint(g.rd, "1", g.a_acct))))
}

test_mint_frozen_hours if {
	not allowed_with(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "1", g.c_acct))), frozen_c, {}) with http.send as mock
	allowed_with(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "1", g.b_acct))), frozen_c, {}) with http.send as mock
	not allowed_with(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "1", g.b_acct))), {"hours": closed}, {}) with http.send as mock
	not allowed_with(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "1", g.b_acct))), {"max_mint_per_tx": {"RD": 0}}, {}) with http.send as mock
}

test_mint_bank_document_of_bi if {
	not allowed_with(tx_in("node1", g.mint_rd), {}, {"counterparties": ["bankB@node3"]}) with http.send as mock
	not allowed_with(tx_in("node1", g.mint_rd), {}, {"max_per_tx": {"RD": 4999}}) with http.send as mock
	allowed_with(tx_in("node1", g.mint_rd), {}, {"max_per_tx": {"RD": 5000}}) with http.send as mock
	not allowed_with(tx_in("node1", g.mint_rd), {}, {"hours": closed}) with http.send as mock

	# a top-up of BI itself needs no counterparty entry
	allowed_with(tx_in("node1", one(g.bi_acct, g.mint(g.rd, "7", g.bi_acct))), {}, {"counterparties": ["bankB@node3"]}) with http.send as mock
}

test_burn if {
	allowed(tx_in("node1", g.burn_rd))
	not allowed(tx_in("node1", one(g.bi_acct, g.burn(g.rd, "1000000000000001", g.bi_acct))))
	not allowed(tx_in("node1", one(g.bi_acct, g.burn(g.rd, "0", g.bi_acct))))

	# BI burning someone else's holding
	not allowed(tx_in("node1", one(g.bi_acct, g.burn(g.rd, "5", g.a_acct))))
}

test_burn_by_a_bank_denied if {
	every n, who in {"node2": g.a_acct, "node3": g.b_acct, "node4": g.c_acct} {
		not allowed(tx_in(n, one(who, g.burn(g.rd, "5", who))))
		not allowed(tx_in(n, one(g.bi_acct, g.burn(g.rd, "5", g.bi_acct))))
	}
	not allowed(tx_in("node1", one(g.a_acct, g.burn(g.rd, "5", g.a_acct))))
}

# --- the bank's own document

test_bank_counterparties if {
	not allowed_with(tx_in("node2", g.transfer_rd), {}, {"counterparties": ["bi@node1", "bankC@node4"]}) with http.send as mock
	allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.c_acct)), {}, {"counterparties": ["bi@node1", "bankC@node4"]}) with http.send as mock
	not allowed_with(tx_in("node2", g.transfer_rd), {}, {"counterparties": []}) with http.send as mock
}

test_bank_cap_and_hours if {
	not allowed_with(tx_in("node2", rd_tr("11", g.a_acct, g.b_acct)), {}, {"max_per_tx": {"RD": 10}}) with http.send as mock
	allowed_with(tx_in("node2", rd_tr("10", g.a_acct, g.b_acct)), {}, {"max_per_tx": {"RD": 10}}) with http.send as mock
	not allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.b_acct)), {}, {"hours": closed}) with http.send as mock
	allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.b_acct)), {}, {"hours": {"DFABI": closed.RD}}) with http.send as mock
}

# after the bank's closing time (open <= now, now >= close)
test_bank_hours_after_close if {
	not allowed_with(tx_in("node2", g.transfer_rd), {}, {"hours": {"RD": {"days": [1, 2, 3, 4, 5, 6, 7], "open": "08:00", "close": "09:00"}}}) with http.send as mock
}

# the bank bundle checks the quantity itself, whatever BI says
test_bank_denies_malformed_quantity if {
	every q in ["abc", "0", "1.5", "12345678901234567"] {
		not bank_only(tx_in("node2", rd_tr(q, g.a_acct, g.b_acct)))
	}
	not bank_only(tx_in("node2", one(g.a_acct, object.union(g.transfer(g.rd, "5", g.a_acct, g.b_acct), {"scale": 2}))))
	not bank_only(tx_in("node2", one(g.a_acct, object.union(g.transfer(g.rd, "5", g.a_acct, g.b_acct), {"quantity": 5}))))
}

# --- DvP at the seller's gateway

test_dvp if {
	allowed(tx_in("node2", g.dvp_settlement))
	allowed(tx_in("node3", one(g.b_acct, g.dvp(g.b_acct, g.c_acct))))

	# the seller's gateway only
	not allowed(tx_in("node3", g.dvp_settlement))
	not allowed(tx_in("node1", g.dvp_settlement))
	not allowed(tx_in("node2", one(g.b_acct, g.dvp(g.a_acct, g.b_acct))))
	not allowed(tx_in("node2", one(g.a_acct, g.dvp(g.b_acct, g.a_acct))))
}

test_dvp_shape if {
	d := g.dvp(g.a_acct, g.b_acct)
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"atomicity": "commit_first_leg"}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"atomicity": "commit_second_leg"}))))

	# payment goes to someone other than the seller / comes from someone other than the receiver
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"payment": g.leg(g.rd, "500", g.b_acct, g.c_acct)}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"payment": g.leg(g.rd, "500", g.c_acct, g.a_acct)}))))

	# the same token on both legs, an unknown or look-alike definition
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"payment": g.leg(g.dfabi, "500", g.b_acct, g.a_acct)}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"payment": g.leg(g.rd_lookalike, "500", g.b_acct, g.a_acct)}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"delivery": g.leg(g.rd_lookalike, "5", g.a_acct, g.b_acct)}))))

	# a party that is the seller and the buyer; an account not in data
	not allowed(tx_in("node2", one(g.a_acct, g.dvp(g.a_acct, g.a_acct))))
	not allowed(tx_in("node2", one(g.a_acct, g.dvp(g.a_acct, "acct-unknown"))))
	not allowed(tx_in("node2", one(g.a_acct, object.remove(d, ["atomicity"]))))
}

test_dvp_legs if {
	d := g.dvp(g.a_acct, g.b_acct)
	allowed(tx_in("node2", one(g.a_acct, object.union(d, {"delivery": g.leg(g.dfabi, "1000", g.a_acct, g.b_acct)}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"delivery": g.leg(g.dfabi, "1001", g.a_acct, g.b_acct)}))))
	allowed(tx_in("node2", one(g.a_acct, object.union(d, {"payment": g.leg(g.rd, "1000000000", g.b_acct, g.a_acct)}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"payment": g.leg(g.rd, "1000000001", g.b_acct, g.a_acct)}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"payment": g.leg(g.rd, "0", g.b_acct, g.a_acct)}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(d, {"delivery": object.union(g.leg(g.dfabi, "5", g.a_acct, g.b_acct), {"scale": 1})}))))
	not allowed(tx_in("node2", one(g.a_acct, object.union(object.remove(d, ["delivery"]), {"delivery": object.remove(g.leg(g.dfabi, "5", g.a_acct, g.b_acct), ["quantity"])}))))
}

test_dvp_frozen_hours_bank if {
	i := tx_in("node2", g.dvp_settlement)
	not allowed_with(tx_in("node2", one(g.a_acct, g.dvp(g.a_acct, g.c_acct))), frozen_c, {}) with http.send as mock
	not allowed_with(i, {"hours": {"DFABI": closed.RD}}, {}) with http.send as mock
	not allowed_with(i, {"hours": closed}, {}) with http.send as mock
	not allowed_with(i, {"holidays": [{"date": "2026-11-05", "name": "x"}]}, {}) with http.send as mock

	# the seller's bank: counterparty, its cap on what it gives, hours of both tokens
	not allowed_with(i, {}, {"counterparties": ["bankC@node4"]}) with http.send as mock
	not allowed_with(i, {}, {"max_per_tx": {"DFABI": 4}}) with http.send as mock
	allowed_with(i, {}, {"max_per_tx": {"DFABI": 5}}) with http.send as mock
	not allowed_with(i, {}, {"hours": {"RD": closed.RD}}) with http.send as mock
}

# --- DvP registration (POST /gw/intent): the buyer's own gateway, a write into the store

test_intent_registration if {
	allowed(reg_in("node3", g.dvp_registration))

	# the buyer is not this gateway's party
	not allowed(reg_in("node2", g.dvp_registration))
	not allowed(reg_in("node4", g.dvp_registration))
	not allowed(reg_in("node1", g.dvp_registration))
	not allowed(reg_in("node3", {"ok": true, "instruction": g.dvp(g.b_acct, g.a_acct)}))
	not allowed(reg_in("node3", {"ok": true, "instruction": g.dvp(g.a_acct, g.c_acct)}))
}

test_intent_registration_shape if {
	d := g.dvp(g.a_acct, g.b_acct)
	not allowed(reg_in("node3", {"ok": false, "error": {"code": "decode_failed", "message": "x"}}))
	not allowed(reg_in("node3", {"ok": true}))
	not allowed(reg_in("node3", {"ok": true, "instruction": g.transfer(g.rd, "5", g.b_acct, g.a_acct)}))
	not allowed(reg_in("node3", {"ok": true, "instruction": object.union(d, {"atomicity": "commit_first_leg"})}))
	not allowed(reg_in("node3", {"ok": true, "instruction": object.union(d, {"payment": g.leg(g.rd, "1000000001", g.b_acct, g.a_acct)})}))
	not allowed(door("node3", "POST", "/gw/intent", "application/json", "bad"))
	not allowed_with(reg_in("node3", g.dvp_registration), {}, {}) with http.send as mock_decode_500
	not allowed_with(reg_in("node3", g.dvp_registration), {}, {}) with http.send as mock_decode_down
}

test_intent_registration_buyer_checks if {
	i := reg_in("node3", g.dvp_registration)
	not allowed_with(i, {"frozen": ["bankB@node3"]}, {}) with http.send as mock
	not allowed_with(i, {"frozen": ["bankA@node2"]}, {}) with http.send as mock
	not allowed_with(i, {"hours": closed}, {}) with http.send as mock
	not allowed_with(i, {}, {"counterparties": ["bankC@node4"]}) with http.send as mock
	not allowed_with(i, {}, {"max_per_tx": {"RD": 499}}) with http.send as mock
	allowed_with(i, {}, {"max_per_tx": {"RD": 500}}) with http.send as mock
	not allowed_with(i, {}, {"hours": {"DFABI": closed.RD}}) with http.send as mock
}

# --- the consent: only for an intent the store holds as active for the signer

test_consent_active_intent_allowed if {
	allowed(tx_in("node3", g.dvp_consent))
	allowed(tx_in("node3", one(g.b_acct, g.consent(g.c_acct, g.active_hash))))
}

test_consent_without_registered_intent_denied if {
	not allowed(tx_in("node3", one(g.b_acct, g.consent(g.a_acct, g.unregistered_hash))))
	not bi_only(tx_in("node3", one(g.b_acct, g.consent(g.a_acct, g.unregistered_hash))))
}

test_consent_expired_denied if not allowed(tx_in("node3", one(g.b_acct, g.consent(g.a_acct, g.expired_hash))))

test_consent_consumed_denied if not allowed(tx_in("node3", one(g.b_acct, g.consent(g.a_acct, g.consumed_hash))))

# registered for another party's buyer
test_consent_other_buyer_denied if {
	not allowed(tx_in("node3", one(g.b_acct, g.consent(g.a_acct, g.other_hash))))
	allowed(tx_in("node4", one(g.c_acct, g.consent(g.a_acct, g.other_hash))))
	not allowed(tx_in("node2", one(g.a_acct, g.consent(g.a_acct, g.active_hash))))
}

# at a gateway that is not the signer's
test_consent_wrong_gateway_denied if {
	not allowed(tx_in("node2", g.dvp_consent))
	not allowed(tx_in("node1", g.dvp_consent))
	not allowed(tx_in("node4", g.dvp_consent))
}

test_consent_store_fails_closed if {
	i := tx_in("node3", g.dvp_consent)
	not allowed_with(i, {}, {}) with http.send as mock_lookup_500
	not allowed_with(i, {}, {}) with http.send as mock_lookup_down
}

test_consent_shape if {
	c := g.consent(g.a_acct, g.active_hash)
	not allowed(tx_in("node3", one(g.b_acct, object.union(c, {"consent": null}))))
	not allowed(tx_in("node3", one(g.b_acct, object.remove(c, ["consent"]))))
	not allowed(tx_in("node3", one(g.b_acct, object.union(c, {"permission": "CanTransferAsset"}))))
	not allowed(tx_in("node3", one(g.b_acct, object.union(c, {"grant_kind": "role"}))))
	not allowed(tx_in("node3", one(g.b_acct, object.union(object.remove(c, ["consent"]), {"consent": {"debited_asset": "x", "settlement_id": "y"}}))))
	not allowed(tx_in("node3", object.union(g.dvp_consent, {"encoding": "json"})))
}

test_consent_buyer_frozen_denied if {
	not allowed_with(tx_in("node3", g.dvp_consent), {"frozen": ["bankB@node3"]}, {}) with http.send as mock
	allowed_with(tx_in("node3", g.dvp_consent), frozen_c, {}) with http.send as mock
}

# the store answers an intent_hash other than the one asked
test_consent_store_hash_mismatch_denied if {
	not allowed_with(tx_in("node3", g.dvp_consent), {}, {}) with http.send as mock_lookup_wrong_hash
}

# --- daily limit: the gateway's own decode journal (usage mocked: RD 900, DFABI 8 so far today)

limit := {"daily_limit": {"RD": 1000}}

test_daily_limit_transfer if {
	allowed_with(tx_in("node2", rd_tr("100", g.a_acct, g.b_acct)), {}, limit) with http.send as mock
	not allowed_with(tx_in("node2", rd_tr("101", g.a_acct, g.b_acct)), {}, limit) with http.send as mock
	allowed_with(tx_in("node2", dfabi_tr("4", g.a_acct, g.b_acct)), {}, {"daily_limit": {"DFABI": 12}}) with http.send as mock
	not allowed_with(tx_in("node2", dfabi_tr("5", g.a_acct, g.b_acct)), {}, {"daily_limit": {"DFABI": 12}}) with http.send as mock
}

test_daily_limit_dvp_legs if {
	# the seller's delivery leg (DFABI 5) at the seller's gateway
	not allowed_with(tx_in("node2", g.dvp_settlement), {}, {"daily_limit": {"DFABI": 12}}) with http.send as mock
	allowed_with(tx_in("node2", g.dvp_settlement), {}, {"daily_limit": {"DFABI": 13}}) with http.send as mock

	# the RD limit does not touch the seller's delivery
	allowed_with(tx_in("node2", g.dvp_settlement), {}, limit) with http.send as mock

	# the buyer's payment leg (RD 500) when the intent is registered at the buyer's gateway
	not allowed_with(reg_in("node3", g.dvp_registration), {}, limit) with http.send as mock
	allowed_with(reg_in("node3", g.dvp_registration), {}, {"daily_limit": {"RD": 1400}}) with http.send as mock
}

test_daily_limit_fails_closed if {
	i := tx_in("node2", rd_tr("1", g.a_acct, g.b_acct))
	not allowed_with(i, {}, limit) with http.send as mock_usage_down
	not allowed_with(i, {}, limit) with http.send as mock_usage_bad
	not allowed_with(i, {}, limit) with http.send as mock_usage_incomplete
	not allowed_with(reg_in("node3", g.dvp_registration), {}, limit) with http.send as mock_usage_down
	not allowed_with(tx_in("node2", g.dvp_settlement), {}, {"daily_limit": {"DFABI": 100}}) with http.send as mock_usage_incomplete
}

# No limit for the token: no query at all (the mocks answer nothing for it, so a query would deny).
test_daily_limit_other_token_no_query if {
	allowed_with(tx_in("node2", dfabi_tr("1", g.a_acct, g.b_acct)), {}, limit) with http.send as mock_usage_down
	allowed_with(tx_in("node2", g.dvp_settlement), {}, limit) with http.send as mock_usage_down
	allowed_with(tx_in("node2", rd_tr("1", g.a_acct, g.b_acct)), {}, {}) with http.send as mock_usage_down
}

# Mint and burn are not counted, and the consent was counted at the registration.
test_daily_limit_not_for_mint_burn_consent if {
	allowed_with(tx_in("node1", g.mint_rd), {}, limit) with http.send as mock_usage_down
	allowed_with(tx_in("node1", g.burn_rd), {}, limit) with http.send as mock_usage_down
	allowed_with(tx_in("node3", g.dvp_consent), {}, limit) with http.send as mock_usage_down
}

# --- through gw.allow (noto's dispatch): target only from Envoy's context_extensions

test_gw_dispatch if {
	i := tx_in("node2", g.transfer_rd)
	gw.allow with input as i with data.bi.config as bi_cfg({}) with data.bank.config as bank_cfg({}) with time.now_ns as now_ns with http.send as mock
	not gw.allow with input as i with data.bi.config as bi_cfg({"frozen": ["bankB@node3"]})
		with data.bank.config as bank_cfg({}) with time.now_ns as now_ns with http.send as mock
	not gw.allow with input as i with data.bi.config as bi_cfg({})
		with data.bank.config as bank_cfg({"counterparties": ["bi@node1"]}) with time.now_ns as now_ns with http.send as mock

	# an Iroha 3 request on the Paladin door is not an Iroha 3 request
	p := object.union(i, {"attributes": {"contextExtensions": {"target": "paladin"}}})
	not gw.allow with input as p with data.bi.config as bi_cfg({}) with data.bank.config as bank_cfg({}) with time.now_ns as now_ns with http.send as mock
}

# the answer is a plain boolean: nothing the decoder said can reach the decision log through it
test_result_is_boolean if {
	r := gw.allow with input as tx_in("node2", g.transfer_rd) with data.bi.config as bi_cfg({})
		with data.bank.config as bank_cfg({}) with time.now_ns as now_ns with http.send as mock
	r == true
}
