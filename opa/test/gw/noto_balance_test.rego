# BI's Noto balance controls (bi.balance): max_balance, min_balance, max_supply. The gateway asks BI's node (node1) through
# http.send, mocked here: ptx_call balanceOf for an account, pstate_queryContractStates for the supply.
package gw_test

import data.fixtures
import data.gw

node1_url := "http://paladin-node1.paladin.svc.cluster.local:8548"

coin_schema := "0x39aa9c8bb0d781b43c3da1beff4ab34043e45e007316ce77412c243868815a02"

locked_schema := "0xdd51fde11e013d11f5a0578490620f3ac4da535291f023a1099b46c39310ceec"

balances := {"bankA@node2": 500, "bankB@node3": 900, "cashIssuer@node1": 0}

rpc_ok(result) := {"status_code": 200, "body": {"jsonrpc": "2.0", "id": 1, "result": result}}

state_rows(amounts) := [{"data": {"amount": a, "owner": "0x01"}} | some a in amounts]

# Answers only the expected queries; anything else is undefined (and so denied by a governed rule).
mock_node1(req) := rpc_ok({"totalStates": "1", "totalBalance": sprintf("%d", [balances[p.data.account]]), "overflow": false}) if {
	base_query(req)
	req.body.method == "ptx_call"
	p := req.body.params[0]
	p.type == "private"
	p.domain == "noto"
	p.function == "balanceOf"
	p.to == n_rd
	p.from == "bi@node1"
}

# supply 1050: 1000 in coins, 50 locked
mock_node1(req) := rpc_ok(state_rows(["700", "300"])) if {
	base_query(req)
	req.body.method == "pstate_queryContractStates"
	req.body.params == ["noto", n_rd, coin_schema, {"limit": 1000}, "confirmed"]
}

mock_node1(req) := rpc_ok(state_rows(["50"])) if {
	base_query(req)
	req.body.method == "pstate_queryContractStates"
	req.body.params == ["noto", n_rd, locked_schema, {"limit": 1000}, "confirmed"]
}

base_query(req) if {
	req.url == node1_url
	req.method == "POST"
	req.timeout == "2s"
	req.cache == false
	req.raise_error == false
}

mock_full_page(req) := rpc_ok(state_rows([sprintf("%d", [1]) | some _ in numbers.range(1, 1000)])) if {
	base_query(req)
	req.body.method == "pstate_queryContractStates"
}

# One helper per mock: a function cannot be passed as an argument.
controlled(i, controls) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi_with("noto", controls)
		with data.bank.config as fixtures.bank_a
		with http.send as mock_node1
}

with_down(i, controls, reply) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi_with("noto", controls)
		with data.bank.config as fixtures.bank_a
		with http.send as reply
}

with_full_page(i, controls) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi_with("noto", controls)
		with data.bank.config as fixtures.bank_a
		with http.send as mock_full_page
}

down := {"status_code": 500, "body": {}}

# --- max_balance

test_max_balance_transfer_up_to_cap_allowed if controlled(send("node2", n_transfer("bankA@node2", "bankB@node3", "100")), {"max_balance": {"RD": 1000}})

test_max_balance_transfer_over_cap_denied if not controlled(send("node2", n_transfer("bankA@node2", "bankB@node3", "101")), {"max_balance": {"RD": 1000}})

test_max_balance_mint_over_cap_denied if not controlled(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "101", "data": "0x"})), {"max_balance": {"RD": 1000}})

test_max_balance_mint_within_cap_allowed if controlled(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "100", "data": "0x"})), {"max_balance": {"RD": 1000}})

test_max_balance_prepare_unlock_over_cap_denied if not controlled(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "101")), {"max_balance": {"RD": 1000}})

test_max_balance_prepare_unlock_within_cap_allowed if controlled(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "100")), {"max_balance": {"RD": 1000}})

# two outputs to the same account add up (900 + 60 + 60 > 1000)
test_max_balance_prepare_unlock_outputs_add_up_denied if {
	i := send("node2", noto(n_rd, "bankA@node2", "prepareUnlock", {
		"lockId": "0x01", "from": "bankA@node2",
		"recipients": [{"to": "bankB@node3", "amount": "60"}, {"to": "bankB@node3", "amount": "60"}],
	}))
	not controlled(i, {"max_balance": {"RD": 1000}})
}

# the rollback returns the lock to its owner: never blocked, whatever the cap
test_max_balance_rollback_allowed if controlled(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "4000")), {"max_balance": {"RD": 1}})

test_max_balance_other_token_not_applied if {
	i := send("node2", n_transfer("bankA@node2", "bankB@node3", "1000"))
	with_down(i, {"max_balance": {"DFABI": 1}}, down)
}

# --- min_balance (bankA holds 500)

test_min_balance_transfer_down_to_floor_allowed if controlled(send("node2", n_transfer("bankA@node2", "bankB@node3", "100")), {"min_balance": {"RD": 400}})

test_min_balance_transfer_below_floor_denied if not controlled(send("node2", n_transfer("bankA@node2", "bankB@node3", "101")), {"min_balance": {"RD": 400}})

test_min_balance_lock_below_floor_denied if not controlled(send("node2", n_lock(n_rd, "bankA@node2", "101")), {"min_balance": {"RD": 400}})

test_min_balance_lock_down_to_floor_allowed if controlled(send("node2", n_lock(n_rd, "bankA@node2", "100")), {"min_balance": {"RD": 400}})

# the lock already left the balance; prepareUnlock only needs what is left to stand at or above the floor
test_min_balance_prepare_unlock_above_floor_allowed if controlled(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "100")), {"min_balance": {"RD": 500}})

test_min_balance_prepare_unlock_below_floor_denied if not controlled(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "100")), {"min_balance": {"RD": 501}})

test_min_balance_rollback_allowed if controlled(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "100")), {"min_balance": {"RD": 501}})

# a mint has no sender
test_min_balance_mint_allowed if controlled(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "5", "data": "0x"})), {"min_balance": {"RD": 1000000}})

# --- max_supply (1050 now)

test_max_supply_mint_up_to_cap_allowed if controlled(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "50", "data": "0x"})), {"max_supply": {"RD": 1100}})

test_max_supply_mint_over_cap_denied if not controlled(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "51", "data": "0x"})), {"max_supply": {"RD": 1100}})

# a transfer moves existing value: supply is not asked (the mock is down)
test_max_supply_transfer_not_asked if with_down(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), {"max_supply": {"RD": 1}}, down)

test_max_supply_full_page_denied if {
	i := send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "1", "data": "0x"}))
	not with_full_page(i, {"max_supply": {"RD": 1000000}})
}

# --- no control set: node1 is not asked; set but no usable answer: denied

test_no_controls_no_query if {
	with_down(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), {}, down)
	with_down(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "10", "data": "0x"})), {}, down)
}

test_node1_non_200_denied if not with_down(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), {"max_balance": {"RD": 1000}}, down)

test_node1_unreachable_denied if {
	i := send("node2", n_transfer("bankA@node2", "bankB@node3", "10"))
	not with_down(i, {"min_balance": {"RD": 1}}, {"status_code": 0, "error": {"code": "eof", "message": "connection refused"}})
}

test_node1_rpc_error_denied if {
	i := send("node2", n_transfer("bankA@node2", "bankB@node3", "10"))
	not with_down(i, {"max_balance": {"RD": 1000}}, {"status_code": 200, "body": {"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "boom"}}})
}

test_node1_overflow_denied if {
	i := send("node2", n_transfer("bankA@node2", "bankB@node3", "10"))
	not with_down(i, {"max_balance": {"RD": 1000}}, rpc_ok({"totalStates": "1001", "totalBalance": "0", "overflow": true}))
}

test_node1_supply_down_denied if {
	i := send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "bankB@node3", "amount": "1", "data": "0x"}))
	not with_down(i, {"max_supply": {"RD": 1000000}}, down)
}

# --- scope: Noto only

test_zeto_not_governed if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	with_down(i, {"max_balance": {"RD": 1}, "min_balance": {"RD": 1000000}, "max_supply": {"RD": 1}}, down)
}

test_reads_not_governed if {
	i := rpc("node2", "ptx_queryTransactions", [{"limit": 1}])
	with_down(i, {"max_balance": {"RD": 1}}, down)
}
