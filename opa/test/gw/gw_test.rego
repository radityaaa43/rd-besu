# End-to-end tests of gw/allow with the BI bundle and the bank bundle loaded together; the data come from test/fixtures.rego.
package gw_test

import data.fixtures
import data.gw

rd := "0xdef2e64a415fd95e5b2c9fa1d7bdbc1792c410a1"

dfabi := "0x2ecc2fe5ff44b850b99607599abc3f6a23e223dc"

zeto_factory := "0xeca568aaf1edd02004aa85562087f8057deb465f"

noto_factory := "0xf1f90c201e28d8e21944c4256d50e266b2b01fec"

group_a := "0xe3dbf2b63e3f32d5c841edb9d92d8e9c007d5c90564d440d17c6439dfeeb3273"

group_b := "0xba7f91bce893d12c04a95c56f0a76b5f8673434bbfaa44993d1e8a3bfeb85004"

# gw/allow with the fixture documents; tests that need other values pass them through object.union.
allowed(i) if gw.allow with input as i with data.bi.config as fixtures.bi with data.bank.config as fixtures.bank_a

door(target, node, body) := {
	"attributes": {"contextExtensions": {"target": target, "node": node}},
	"parsed_body": body,
}

rpc(node, method, params) := door("paladin", node, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})

send(node, tx) := rpc(node, "ptx_sendTransaction", [tx])

zeto(contract, from, fn, args) := {"type": "private", "domain": "zeto", "to": contract, "from": from, "function": fn, "data": args}

transfer(from, to, amount) := zeto(rd, from, "transfer", {"transfers": [{"to": to, "amount": amount, "data": "0x"}]})

public(to, fn) := {"type": "public", "to": to, "from": "bankA@node2", "function": fn, "data": {}}

besu(body) := door("besu", "node2", body)

call(method) := {"jsonrpc": "2.0", "id": 1, "method": method, "params": []}

# --- Paladin reads and unknown methods

test_read_allowed if allowed(rpc("node2", "ptx_getTransactionReceipt", ["id"]))

test_unlisted_method_denied if not allowed(rpc("node2", "keymgr_sign", []))

test_unknown_node_denied if not allowed(rpc("node9", "ptx_getTransactionReceipt", ["id"]))

test_missing_target_denied if not allowed({"parsed_body": call("ptx_getTransactionReceipt")})

test_no_body_denied if not allowed({"attributes": {"contextExtensions": {"target": "paladin", "node": "node2"}}})

test_paladin_batch_denied if not allowed(door("paladin", "node2", [call("ptx_getTransactionReceipt")]))

# --- Zeto transfer

test_transfer_allowed if allowed(send("node2", transfer("bankA@node2", "bankB@node3", 10)))

test_transfer_string_amount_allowed if allowed(send("node2", transfer("bankA@node2", "bankB@node3", "10")))

test_transfer_contract_case_insensitive if {
	tx := object.union(transfer("bankA@node2", "bankB@node3", 10), {"to": upper(rd)})
	allowed(send("node2", tx))
}

test_transfer_over_limit_denied if not allowed(send("node2", transfer("bankA@node2", "bankB@node3", 1000000001)))

test_transfer_limit_is_per_tx_sum if {
	tx := zeto(rd, "bankA@node2", "transfer", {"transfers": [
		{"to": "bankB@node3", "amount": 600000000},
		{"to": "bankC@node4", "amount": 600000000},
	]})
	not allowed(send("node2", tx))
}

test_transfer_to_outsider_denied if not allowed(send("node2", transfer("bankA@node2", "eve@node9", 10)))

test_transfer_from_other_identity_denied if not allowed(send("node2", transfer("bankB@node3", "bankC@node4", 10)))

test_transfer_empty_outputs_denied if {
	not allowed(send("node2", zeto(rd, "bankA@node2", "transfer", {"transfers": []})))
}

test_transfer_missing_outputs_denied if not allowed(send("node2", zeto(rd, "bankA@node2", "transfer", {})))

test_transfer_zero_amount_denied if not allowed(send("node2", transfer("bankA@node2", "bankB@node3", 0)))

test_transfer_bad_amount_denied if not allowed(send("node2", transfer("bankA@node2", "bankB@node3", "abc")))

test_transfer_unknown_contract_denied if {
	tx := object.union(transfer("bankA@node2", "bankB@node3", 10), {"to": "0x0000000000000000000000000000000000000001"})
	not allowed(send("node2", tx))
}

test_transfer_locked_denied if {
	tx := zeto(rd, "bankA@node2", "transferLocked", {"transfers": [{"to": "bankB@node3", "amount": 10}]})
	not allowed(send("node2", tx))
}

test_zeto_deploy_denied if not allowed(send("node2", zeto(null, "bankA@node2", "", {"tokenName": "RD"})))

# --- Zeto mint

test_mint_by_bi_allowed if {
	tx := zeto(rd, "bi@node1", "mint", {"mints": [{"to": "bankA@node2", "amount": 5000000000000}]})
	allowed(send("node1", tx))
}

test_mint_by_bank_denied if {
	tx := zeto(rd, "bankA@node2", "mint", {"mints": [{"to": "bankA@node2", "amount": 10}]})
	not allowed(send("node2", tx))
}

# --- Zeto DvP legs

lock(from, to, amount) := zeto(dfabi, from, "createLock", {"from": from, "recipients": [{"to": to, "amount": amount}], "data": "0x"})

test_create_lock_allowed if allowed(send("node2", lock("bankA@node2", "bankB@node3", 5)))

test_create_lock_over_limit_denied if not allowed(send("node2", lock("bankA@node2", "bankB@node3", 1001)))

test_spend_lock_prepare_allowed if {
	tx := zeto(dfabi, "bankA@node2", "spendLock", {"lockId": "0x01", "from": "bankA@node2", "data": "0x"})
	allowed(rpc("node2", "ptx_prepareTransaction", [tx]))
}

test_prepare_spend_lock_name_denied if {
	tx := zeto(dfabi, "bankA@node2", "prepareSpendLock", {"lockId": "0x01"})
	not allowed(rpc("node2", "ptx_prepareTransaction", [tx]))
}

test_delegate_lock_allowed if allowed(send("node2", zeto(rd, "bankA@node2", "delegateLock", {"lockId": "0x01"})))

test_cancel_lock_allowed if allowed(send("node2", zeto(rd, "bankA@node2", "cancelLock", {"lockId": "0x01"})))

# --- Operating hours (WIB)

# RD Mon-Fri 06:30-18:00, DFABI Mon-Fri 08:00-16:00. Thursday 2026-11-05: 03:00Z = 10:00 WIB (both open),
# 10:00Z = 17:00 WIB (RD open, DFABI closed), 11:00Z = 18:00 WIB (both closed).
office_bi := fixtures.bi_with("zeto", {"hours": {
	"RD": {"days": [1, 2, 3, 4, 5], "open": "06:30", "close": "18:00"},
	"DFABI": {"days": [1, 2, 3, 4, 5], "open": "08:00", "close": "16:00"},
}})

at_hours(i, rfc3339) if {
	gw.allow with input as i
		with data.bi.config as office_bi
		with data.bank.config as fixtures.bank_a
		with time.now_ns as time.parse_rfc3339_ns(rfc3339)
}

dfabi_transfer(from, to, amount) := zeto(dfabi, from, "transfer", {"transfers": [{"to": to, "amount": amount, "data": "0x"}]})

rd_lock(from, to, amount) := zeto(rd, from, "createLock", {"from": from, "recipients": [{"to": to, "amount": amount}], "data": "0x"})

test_transfer_in_hours_allowed if at_hours(send("node2", transfer("bankA@node2", "bankB@node3", 10)), "2026-11-05T03:00:00Z")

test_transfer_after_hours_denied if not at_hours(send("node2", transfer("bankA@node2", "bankB@node3", 10)), "2026-11-05T11:00:00Z")

test_transfer_closed_token_denied if not at_hours(send("node2", dfabi_transfer("bankA@node2", "bankB@node3", 10)), "2026-11-05T10:00:00Z")

test_mint_after_hours_denied if {
	tx := zeto(rd, "bi@node1", "mint", {"mints": [{"to": "bankA@node2", "amount": 10}]})
	not at_hours(send("node1", tx), "2026-11-05T11:00:00Z")
}

test_create_lock_both_open_allowed if at_hours(send("node2", rd_lock("bankA@node2", "bankB@node3", 5)), "2026-11-05T03:00:00Z")

# RD is open at 17:00 WIB but DFABI is not: a lock on RD still needs both.
test_create_lock_needs_both_open if not at_hours(send("node2", rd_lock("bankA@node2", "bankB@node3", 5)), "2026-11-05T10:00:00Z")

test_spend_lock_after_hours_allowed if {
	tx := zeto(dfabi, "bankA@node2", "spendLock", {"lockId": "0x01", "from": "bankA@node2", "data": "0x"})
	at_hours(rpc("node2", "ptx_prepareTransaction", [tx]), "2026-11-05T11:00:00Z")
}

test_delegate_and_cancel_lock_after_hours_allowed if {
	at_hours(send("node2", zeto(rd, "bankA@node2", "delegateLock", {"lockId": "0x01"})), "2026-11-05T11:00:00Z")
	at_hours(send("node2", zeto(rd, "bankA@node2", "cancelLock", {"lockId": "0x01"})), "2026-11-05T11:00:00Z")
}

test_atom_execute_after_hours_allowed if at_hours(send("node2", public("0x00000000000000000000000000000000000000bb", "execute")), "2026-11-05T11:00:00Z")

test_bank_hours_narrower_denied if {
	bank := fixtures.bank_with("zeto", {"hours": {"RD": {"days": [1, 2, 3, 4, 5], "open": "07:00", "close": "17:00"}}})
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	not gw.allow with input as i
		with data.bi.config as office_bi
		with data.bank.config as bank
		with time.now_ns as time.parse_rfc3339_ns("2026-11-05T10:30:00Z")
}

# The bank window narrows BI's, never widens it: BI closed at 18:00 WIB, bank still "open" until 19:00.
test_bank_hours_cannot_widen_bi if {
	bank := fixtures.bank_with("zeto", {"hours": {"RD": {"days": [1, 2, 3, 4, 5], "open": "07:00", "close": "19:00"}}})
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	not gw.allow with input as i
		with data.bi.config as office_bi
		with data.bank.config as bank
		with time.now_ns as time.parse_rfc3339_ns("2026-11-05T11:00:00Z")
}

# A bank with no hours for the token is limited by BI's alone.
test_bank_without_hours_follows_bi if at_hours(send("node2", transfer("bankA@node2", "bankB@node3", 10)), "2026-11-05T10:30:00Z")

# --- Atom (public txs)

test_zeto_atom_create_allowed if allowed(send("node2", public(zeto_factory, "create")))

test_noto_atom_create_allowed if allowed(send("node2", public(noto_factory, "create")))

test_atom_create_on_unknown_factory_denied if not allowed(send("node2", public("0x00000000000000000000000000000000000000aa", "create")))

test_atom_execute_allowed if allowed(send("node2", public("0x00000000000000000000000000000000000000bb", "execute")))

test_atom_cancel_allowed if allowed(send("node2", public("0x00000000000000000000000000000000000000bb", "cancel")))

test_execute_on_factory_denied if not allowed(send("node2", public(zeto_factory, "execute")))

test_public_deploy_denied if not allowed(send("node2", {"type": "public", "from": "bankA@node2", "function": "", "data": {}}))

test_public_other_function_denied if not allowed(send("node2", public("0x00000000000000000000000000000000000000bb", "transfer")))

# --- Private txs without `domain` (the Paladin SDK omits it on writes; Paladin resolves it from `to`)

# `domain` dropped: the shape the SDK really sends for Zeto and Noto writes.
sdk(tx) := object.remove(tx, ["domain"])

test_real_sdk_transfer_without_domain_allowed if {
	tx := {"type": "private", "function": "transfer", "to": rd, "from": "bankA@node2", "data": {"transfers": [{"to": "bankB@node3", "amount": 1, "data": "0x"}]}}
	allowed(send("node2", tx))
}

test_sdk_create_lock_without_domain_allowed if allowed(send("node2", sdk(lock("bankA@node2", "bankB@node3", 5))))

test_sdk_mint_without_domain_by_bi_allowed if {
	tx := zeto(rd, "bi@node1", "mint", {"mints": [{"to": "bankA@node2", "amount": 5000000000000}]})
	allowed(send("node1", sdk(tx)))
}

test_sdk_spend_lock_prepare_without_domain_allowed if {
	tx := zeto(dfabi, "bankA@node2", "spendLock", {"lockId": "0x01", "from": "bankA@node2", "data": "0x"})
	allowed(rpc("node2", "ptx_prepareTransaction", [sdk(tx)]))
}

test_sdk_transfer_without_domain_over_limit_denied if not allowed(send("node2", sdk(transfer("bankA@node2", "bankB@node3", 1000000001))))

test_sdk_transfer_without_domain_to_outsider_denied if not allowed(send("node2", sdk(transfer("bankA@node2", "eve@node9", 10))))

test_sdk_transfer_without_domain_from_other_identity_denied if not allowed(send("node2", sdk(transfer("bankB@node3", "bankC@node4", 10))))

test_sdk_mint_without_domain_by_bank_denied if {
	tx := zeto(rd, "bankA@node2", "mint", {"mints": [{"to": "bankA@node2", "amount": 10}]})
	not allowed(send("node2", sdk(tx)))
}

# No `to` and no `domain`: neither Zeto nor Noto, so denied.
test_private_without_to_and_domain_denied if not allowed(send("node2", {"type": "private", "from": "bankA@node2", "function": "", "data": {}}))

test_bank_counterparty_applies_without_domain if {
	bank := fixtures.bank_with("zeto", {"counterparties": ["bi@node1"]})
	not gw.allow with input as send("node2", sdk(transfer("bankA@node2", "bankB@node3", 10)))
		with data.bi.config as fixtures.bi
		with data.bank.config as bank
}

# --- BI reports

report(group, topic) := rpc("node2", "pgroup_sendMessage", [{"domain": "pente", "group": group, "topic": topic, "data": {}}])

test_report_own_group_allowed if allowed(report(group_a, "zeto-report-v1"))

test_report_other_group_denied if not allowed(report(group_b, "zeto-report-v1"))

test_report_wrong_topic_denied if not allowed(report(group_a, "chat"))

# --- The bank's own rules

test_bank_denies_transfer_to_self if not allowed(send("node2", transfer("bankA@node2", "bankA@node2", 10)))

test_bank_denies_non_counterparty if {
	bank := fixtures.bank_with("zeto", {"counterparties": ["bi@node1"]})
	not gw.allow with input as send("node2", transfer("bankA@node2", "bankB@node3", 10))
		with data.bi.config as fixtures.bi
		with data.bank.config as bank
}

# --- Freeze, mint cap and the bank's per-tx limit

with_bi(i, patch) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi_with("zeto", patch)
		with data.bank.config as fixtures.bank_a
}

with_cfg(i, bi_patch, bank_patch) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi_with("zeto", bi_patch)
		with data.bank.config as fixtures.bank_with("zeto", bank_patch)
}

test_transfer_to_frozen_denied if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 10))
	with_bi(i, {"frozen": []})
	not with_bi(i, {"frozen": ["bankB@node3"]})
}

test_create_lock_to_frozen_denied if {
	not with_bi(send("node2", lock("bankA@node2", "bankB@node3", 5)), {"frozen": ["bankB@node3"]})
}

test_frozen_sender_own_gateway_denied if {
	i := send("node4", transfer("bankC@node4", "bankB@node3", 10))
	gw.allow with input as i with data.bi.config as fixtures.bi with data.bank.config as {"policy": {"zeto": {"counterparties": ["bankB@node3"]}}}
	not gw.allow with input as i
		with data.bi.config as fixtures.bi_with("zeto", {"frozen": ["bankC@node4"]})
		with data.bank.config as {"policy": {"zeto": {"counterparties": ["bankB@node3"]}}}
}

test_frozen_sender_cancel_lock_allowed if {
	i := send("node4", zeto(rd, "bankC@node4", "cancelLock", {"lockId": "0x01"}))
	gw.allow with input as i
		with data.bi.config as fixtures.bi_with("zeto", {"frozen": ["bankC@node4"]})
		with data.bank.config as {"policy": {"zeto": {"counterparties": ["bankB@node3"]}}}
}

test_mint_over_cap_denied if {
	mint := {"mints": [{"to": "bankA@node2", "amount": 101}]}
	i := send("node1", zeto(rd, "bi@node1", "mint", mint))
	cap := {"max_mint_per_tx": {"RD": 100, "DFABI": 100}}
	not with_bi(i, cap)
	with_bi(send("node1", zeto(rd, "bi@node1", "mint", {"mints": [{"to": "bankA@node2", "amount": 100}]})), cap)
}

test_mint_to_frozen_denied if {
	i := send("node1", zeto(rd, "bi@node1", "mint", {"mints": [{"to": "bankA@node2", "amount": 10}]}))
	not with_bi(i, {"frozen": ["bankA@node2"]})
}

test_bank_per_tx_stricter_denied if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 600))
	allowed(i)
	not with_cfg(i, {}, {"max_per_tx": {"RD": 500}})
}

test_bank_per_tx_applies_to_create_lock if {
	i := send("node2", zeto(rd, "bankA@node2", "createLock", {"from": "bankA@node2", "recipients": [{"to": "bankB@node3", "amount": 600}], "data": "0x"}))
	allowed(i)
	not with_cfg(i, {}, {"max_per_tx": {"RD": 500}})
}

test_bank_per_tx_other_token_not_limited if {
	with_cfg(send("node2", lock("bankA@node2", "bankB@node3", 600)), {}, {"max_per_tx": {"RD": 500}})
}

test_bank_per_tx_looser_still_bi_capped if {
	i := send("node2", transfer("bankA@node2", "bankB@node3", 1500000000))
	not with_cfg(i, {}, {"max_per_tx": {"RD": 5000000000}})
}

# --- Node-scoped identities: a bank is its node, so any identity on a node counts as that bank

test_stress_identity_transfer_allowed if allowed(send("node2", transfer("stress-n2-01@node2", "stress-n3-00@node3", 10)))

test_other_node_sender_denied if not allowed(send("node2", transfer("bankB@node3", "bankC@node4", 10)))

test_recipient_unknown_node_denied if {
	not allowed(send("node2", transfer("bankA@node2", "eve@node9", 10)))
	not allowed(send("node2", transfer("bankA@node2", "node3", 10)))
}

test_frozen_node_blocks_all_identities if {
	i := send("node2", transfer("bankA@node2", "stress-n4-00@node4", 10))
	allowed(i)
	not with_bi(i, {"frozen": ["bankC@node4"]})
}

test_frozen_own_node_any_identity_denied if {
	i := send("node4", transfer("stress-n4-00@node4", "bankB@node3", 10))
	bank := {"policy": {"zeto": {"counterparties": ["bankB@node3"]}}}
	gw.allow with input as i with data.bi.config as fixtures.bi with data.bank.config as bank
	not gw.allow with input as i
		with data.bi.config as fixtures.bi_with("zeto", {"frozen": ["bankC@node4"]})
		with data.bank.config as bank
}

test_counterparty_by_node if {
	bank := {"policy": {"zeto": {"counterparties": ["bi@node1", "bankB@node3"]}}}
	gw.allow with input as send("node2", transfer("bankA@node2", "stress-n3-02@node3", 10))
		with data.bi.config as fixtures.bi
		with data.bank.config as bank
	not gw.allow with input as send("node2", transfer("bankA@node2", "bankC@node4", 10))
		with data.bi.config as fixtures.bi
		with data.bank.config as bank
}

test_identity_with_two_at_denied if {
	not allowed(send("node2", transfer("x@node3@node2", "bankB@node3", 10)))
	not allowed(send("node2", transfer("bankA@node2", "y@node2@node3", 10)))
}

test_identity_empty_part_denied if {
	not allowed(send("node2", transfer("@node2", "bankB@node3", 10)))
	not allowed(send("node2", transfer("bankA@", "bankB@node3", 10)))
	not allowed(send("node2", transfer("bankA@node2", "@node3", 10)))
	not allowed(send("node2", transfer("bankA@node2", "bankB@", 10)))
}

test_frozen_own_node_cancel_lock_allowed if {
	i := send("node4", zeto(rd, "stress-n4-00@node4", "cancelLock", {"lockId": "0x01"}))
	gw.allow with input as i
		with data.bi.config as fixtures.bi_with("zeto", {"frozen": ["bankC@node4"]})
		with data.bank.config as {"policy": {"zeto": {"counterparties": ["bankB@node3"]}}}
}

# --- Besu door

test_besu_single_read_allowed if allowed(besu(call("eth_blockNumber")))

test_besu_batch_allowed if allowed(besu([call("eth_chainId"), call("eth_getTransactionReceipt")]))

test_besu_send_raw_allowed if allowed(besu(call("eth_sendRawTransaction")))

test_besu_batch_with_admin_denied if not allowed(besu([call("eth_blockNumber"), call("admin_peers")]))

test_besu_empty_batch_denied if not allowed(besu([]))

test_besu_qbft_vote_denied if not allowed(besu(call("qbft_proposeValidatorVote")))

test_besu_debug_denied if not allowed(besu(call("debug_traceTransaction")))

# Lensa reaches Besu through bank-gw-1's door (one URL for every party): everything ethers' JsonRpcProvider sends for the
# Stealth adapter (reads, fee data, eth_sendRawTransaction, receipt polling, deploy) plus the trace and health probes.
lensa_besu_methods := [
	"eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs", "eth_getTransactionByHash",
	"eth_getTransactionReceipt", "eth_getTransactionCount", "eth_getBalance", "eth_getCode", "eth_call", "eth_estimateGas",
	"eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_sendRawTransaction",
]

test_besu_lensa_calls_allowed_on_every_gateway if {
	every node in ["node1", "node2", "node3", "node4"] {
		every m in lensa_besu_methods {
			allowed(door("besu", node, call(m)))
		}
		allowed(door("besu", node, [call(m) | some m in lensa_besu_methods]))
	}
}

test_besu_subscribe_and_filters_denied if {
	every m in ["eth_subscribe", "eth_newFilter", "eth_getFilterChanges", "eth_sendTransaction", "eth_accounts", "txpool_content"] {
		not allowed(door("besu", "node1", call(m)))
	}
}
