# Daily limit of the bank bundle, per platform: a request is counted against its own platform's document and spend only.
# The gateway asks its own Paladin node (http.send, mocked here) for today's outgoing total, for the request's domain only.
package gw_test

import data.fixtures
import data.gw

# --- Daily limit (asks the bank's own Paladin node through http.send, mocked here)

# Thursday 2026-11-05 10:00 WIB; the day starts 2026-11-04T17:00:00Z.
now_ns := time.parse_rfc3339_ns("2026-11-05T03:00:00Z")

paladin_reply(rows) := {"status_code": 200, "body": {"jsonrpc": "2.0", "id": 1, "result": rows}}

row(fn, contract, amounts) := {"function": fn, "to": contract, "data": {"transfers": [{"to": "bankB@node3", "amount": a, "data": "0x"} | some a in amounts]}}

lock_row(contract, amounts) := {
	"function": "createLock(string,(string,uint256,bytes)[],bytes,bytes)", "to": contract,
	"data": {"from": "bankA@node2", "recipients": [{"to": "bankB@node3", "amount": a} | some a in amounts], "data": "0x"},
}

xfer := "transfer((string,uint256,bytes)[])"

# Answers only the expected queries (node2's Paladin, the day start, the request's domain, no `from` filter); anything else is undefined.
expected_query(req, domain) if {
	req.url == "http://paladin-node2.paladin.svc.cluster.local:8548"
	req.method == "POST"
	req.timeout == "2s"
	req.cache == false
	req.raise_error == false
	req.body.method == "ptx_queryTransactionsFull"
	q := req.body.params[0]
	q.limit == 1000
	q.eq == [{"field": "domain", "value": domain}]
	q.greaterThan == [{"field": "created", "value": "2026-11-04T17:00:00Z"}]
}

# One mock per row set, applied at the call site (`with http.send as mock_used`). A mock answers only the domains it
# names; the other domain is undefined, so a request that asked for it would be denied.
mock_used(req) := paladin_reply(used_rows) if expected_query(req, "zeto")

mock_noto_used(req) := paladin_reply(noto_rows) if expected_query(req, "noto")

# Zeto spend as above and 400m out on Noto (noto_rows in noto_test.rego), each on its own domain.
mock_both(req) := mock_used(req)

mock_both(req) := mock_noto_used(req)

mock_noto_down(req) := paladin_reply(used_rows) if expected_query(req, "zeto")

mock_noto_down(req) := {"status_code": 500, "body": {"result": []}} if expected_query(req, "noto")

mock_zeto_down(req) := {"status_code": 0, "error": {"code": "eof", "message": "connection refused"}} if expected_query(req, "zeto")

mock_zeto_down(req) := paladin_reply(noto_rows) if expected_query(req, "noto")

full_page := [row(xfer, rd, ["1"]) | some _ in numbers.range(1, 1000)]

mock_page(req) := paladin_reply(full_page) if expected_query(req, "zeto")

mock_almost_page(req) := paladin_reply([row(xfer, rd, ["1"]) | some _ in numbers.range(1, 999)]) if expected_query(req, "zeto")

with_daily(i, limit) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("zeto", {"daily_limit": {"RD": limit}})
		with time.now_ns as now_ns
}

# 4.5bn used (transfers and a lock on RD) + 600m request > 5bn
used_rows := [
	row(xfer, rd, ["3000000000", "1000000000"]),
	lock_row(rd, ["500000000"]),
	row(xfer, dfabi, ["900"]), # the other token
	{"function": "spendLock(bytes32,string,bytes)", "to": rd, "data": {"lockId": "0x01"}}, # not value out
	{"function": "mint((string,uint256,bytes)[])", "to": rd, "data": {"mints": [{"to": "bankA@node2", "amount": "7000000000"}]}},
]

test_daily_limit_sum_denied if not with_daily(send("node2", transfer("bankA@node2", "bankB@node3", 600000000)), 5000000000) with http.send as mock_used

# The SDK sends no `domain`; the contract address still marks the tx as Zeto.
test_daily_limit_applies_without_domain if {
	i := send("node2", object.remove(transfer("bankA@node2", "bankB@node3", 600000000), ["domain"]))
	not with_daily(i, 5000000000) with http.send as mock_used
}

test_daily_limit_within_allowed_without_domain if {
	i := send("node2", object.remove(transfer("bankA@node2", "bankB@node3", 500000000), ["domain"]))
	with_daily(i, 5000000000) with http.send as mock_used
}

test_daily_limit_within_allowed if with_daily(send("node2", transfer("bankA@node2", "bankB@node3", 500000000)), 5000000000) with http.send as mock_used

test_daily_limit_applies_to_create_lock if {
	i := send("node2", rd_lock("bankA@node2", "bankB@node3", 600000000))
	not with_daily(i, 5000000000) with http.send as mock_used
}

test_daily_limit_paladin_down_denied if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	not gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("zeto", {"daily_limit": {"RD": 5000000000}})
		with http.send as {"status_code": 0, "error": {"code": "eof", "message": "connection refused"}}
		with time.now_ns as now_ns
}

test_daily_limit_non_200_denied if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	not gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("zeto", {"daily_limit": {"RD": 5000000000}})
		with http.send as {"status_code": 500, "body": {"result": []}}
		with time.now_ns as now_ns
}

test_daily_limit_rpc_error_denied if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	not gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("zeto", {"daily_limit": {"RD": 5000000000}})
		with http.send as {"status_code": 200, "body": {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "boom"}}}
		with time.now_ns as now_ns
}

test_daily_limit_full_page_denied if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	not with_daily(i, 5000000000) with http.send as mock_page
	with_daily(i, 5000000000) with http.send as mock_almost_page
}

# A Zeto request asks only the Zeto domain: a Noto query failing does not matter, its own failing denies.
test_daily_limit_zeto_independent_of_noto_query if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	with_daily(i, 5000000000) with http.send as mock_noto_down
	not with_daily(i, 5000000000) with http.send as mock_zeto_down
}

# Zeto counts only Zeto spend: 4.5bn on Zeto + 400m on Noto would be 4.9bn, but the 200m request sees 4.5bn.
test_daily_limit_counts_only_zeto if {
	with_daily(send("node2", transfer("bankA@node2", "bankB@node3", 200000000)), 5000000000) with http.send as mock_both
	not with_daily(send("node2", transfer("bankA@node2", "bankB@node3", 600000000)), 5000000000) with http.send as mock_both
}

# A limit in the Noto document does not apply to Zeto (and the other way round): Paladin is not asked.
test_daily_limit_other_platform_not_applied if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("noto", {"daily_limit": {"RD": 1}})
		with http.send as {"status_code": 500, "body": {}}
		with time.now_ns as now_ns
}

# The bank has no daily limit for RD: Paladin is not asked (the mock would fail the request if it were).
test_no_daily_limit_no_query if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_a
		with http.send as {"status_code": 500, "body": {}}
		with time.now_ns as now_ns
	gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("zeto", {"daily_limit": {"DFABI": 5}})
		with http.send as {"status_code": 500, "body": {}}
		with time.now_ns as now_ns
}
