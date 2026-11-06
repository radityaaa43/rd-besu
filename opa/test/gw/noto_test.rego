# gw/allow for Noto and Pente (bi.noto, bi.paladin, bank.paladin), shapes as paladin-sdk domains/noto.js sends them
# (no `domain` on writes) and as bond/src/lib/outright.ts uses them for a DvP and its rollback.
package gw_test

import data.fixtures
import data.gw

n_rd := "0xf4571ab32cbd61a7cfbf1d1647a39ec8744a7681"

n_dfabi := "0xf0735bed31247f52d54e6bc5ed6603c98aec8a63"

noto(contract, from, fn, args) := {"type": "private", "to": contract, "from": from, "function": fn, "data": args}

n_transfer(from, to, amount) := noto(n_rd, from, "transfer", {"to": to, "amount": amount, "data": "0x"})

n_lock(contract, from, amount) := noto(contract, from, "lock", {"amount": amount, "data": "0x"})

n_prepare(contract, from, to, amount) := noto(contract, from, "prepareUnlock", {
	"lockId": "0x01", "from": from, "recipients": [{"to": to, "amount": amount}], "unlockData": "0x", "data": "0x",
})

closed(token) := fixtures.bi_with("noto", {"hours": {token: {"days": [], "open": "00:00", "close": "24:00"}}})

frozen(id) := fixtures.bi_with("noto", {"frozen": [id]})

n_with_bi(i, bi) if gw.allow with input as i with data.bi.config as bi with data.bank.config as fixtures.bank_a

n_with_bank(i, bank) if gw.allow with input as i with data.bi.config as fixtures.bi with data.bank.config as bank

# --- BI: transfer and mint

test_noto_transfer_allowed if allowed(send("node2", n_transfer("investor1@node2", "investor2@node3", "10")))

test_noto_transfer_with_domain_allowed if allowed(send("node2", object.union(n_transfer("bankA@node2", "bankB@node3", "10"), {"domain": "noto"})))

test_noto_transfer_over_bi_cap_denied if not allowed(send("node2", noto(n_dfabi, "bankA@node2", "transfer", {"to": "bankB@node3", "amount": "1001"})))

test_noto_transfer_to_outsider_denied if not allowed(send("node2", n_transfer("bankA@node2", "eve@node9", "10")))

test_noto_transfer_from_other_node_denied if not allowed(send("node2", n_transfer("investor2@node3", "bankC@node4", "10")))

test_noto_transfer_zero_denied if not allowed(send("node2", n_transfer("bankA@node2", "bankB@node3", "0")))

test_noto_transfer_hours_closed_denied if not n_with_bi(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), closed("RD"))

test_noto_transfer_to_frozen_denied if not n_with_bi(send("node2", n_transfer("bankA@node2", "bankC@node4", "10")), frozen("bankC@node4"))

test_noto_transfer_from_frozen_denied if not n_with_bi(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), frozen("bankA@node2"))

test_noto_mint_by_bi_allowed if allowed(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "investor1@node2", "amount": "5000", "data": "0x"})))

test_noto_mint_by_bank_denied if not allowed(send("node2", noto(n_rd, "bankA@node2", "mint", {"to": "bankA@node2", "amount": "5", "data": "0x"})))

test_noto_unknown_contract_denied if not allowed(send("node2", object.union(noto("0x00000000000000000000000000000000000000cc", "bankA@node2", "transfer", {"to": "bankB@node3", "amount": "1"}), {"domain": "noto"})))

test_noto_deploy_denied if not allowed(send("node1", {"type": "private", "domain": "noto", "from": "bi@node1", "function": "", "data": {}}))

n_burn(contract, from, amount) := noto(contract, from, "burn", {"amount": amount, "data": "0x"})

test_noto_burn_by_bank_denied if not allowed(send("node2", n_burn(n_rd, "bankA@node2", "1")))

test_noto_burn_by_bi_allowed if allowed(send("node1", n_burn(n_rd, "cashIssuer@node1", "5000")))

# No bank rule applies to a burn: it sends nothing out.
test_noto_burn_by_bi_ignores_bank_rules if {
	bank := fixtures.bank_with("noto", {"counterparties": [], "max_per_tx": {"RD": 1}, "daily_limit": {"RD": 1}})
	n_with_bank(send("node1", n_burn(n_rd, "cashIssuer@node1", "5000")), bank) with http.send as {"status_code": 500, "body": {}}
}

test_noto_burn_by_bi_zero_denied if not allowed(send("node1", n_burn(n_rd, "cashIssuer@node1", "0")))

test_noto_burn_by_bi_over_mint_cap_denied if {
	i := send("node1", n_burn(n_rd, "cashIssuer@node1", "101"))
	not n_with_bi(i, fixtures.bi_with("noto", {"max_mint_per_tx": {"RD": 100}}))
	n_with_bi(send("node1", n_burn(n_rd, "cashIssuer@node1", "100")), fixtures.bi_with("noto", {"max_mint_per_tx": {"RD": 100}}))
}

test_noto_burn_by_bi_hours_closed_denied if not n_with_bi(send("node1", n_burn(n_rd, "cashIssuer@node1", "5")), closed("RD"))

test_noto_burn_unknown_contract_denied if not allowed(send("node1", object.union(n_burn("0x00000000000000000000000000000000000000cc", "cashIssuer@node1", "5"), {"domain": "noto"})))

test_noto_burn_from_other_node_denied if not allowed(send("node1", n_burn(n_rd, "bankA@node2", "5")))

test_noto_transfer_from_and_burn_from_denied if {
	not allowed(send("node1", noto(n_rd, "cashIssuer@node1", "burnFrom", {"from": "bankA@node2", "amount": "5", "data": "0x"})))
	not allowed(send("node1", noto(n_rd, "cashIssuer@node1", "transferFrom", {"from": "bankA@node2", "to": "bankB@node3", "amount": "5", "data": "0x"})))
}

# --- BI: DvP leg (lock, prepareUnlock, delegateLock) and its rollback

test_noto_lock_allowed if allowed(send("node2", n_lock(n_dfabi, "investor1@node2", "100")))

test_noto_lock_over_cap_denied if not allowed(send("node2", n_lock(n_dfabi, "investor1@node2", "1001")))

test_noto_lock_other_token_closed_denied if not n_with_bi(send("node2", n_lock(n_dfabi, "bankA@node2", "1")), closed("RD"))

test_noto_prepare_unlock_allowed if allowed(rpc("node2", "ptx_sendTransaction", [n_prepare(n_dfabi, "investor1@node2", "investor2@node3", "100")]))

test_noto_prepare_unlock_prepare_method_allowed if allowed(rpc("node2", "ptx_prepareTransaction", [n_prepare(n_dfabi, "investor1@node2", "investor2@node3", "100")]))

test_noto_prepare_unlock_to_outsider_denied if not allowed(send("node2", n_prepare(n_rd, "bankA@node2", "eve@node9", "10")))

test_noto_prepare_unlock_to_frozen_denied if not n_with_bi(send("node2", n_prepare(n_rd, "bankA@node2", "bankC@node4", "10")), frozen("bankC@node4"))

# Rollback returns the lock to its owner: never blocked by hours or freezing.
test_noto_rollback_prepare_allowed_when_closed_and_frozen if {
	bi := object.union(closed("RD"), {"policy": {"noto": {"frozen": ["bankA@node2"]}}})
	n_with_bi(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "10")), bi)
}

test_noto_delegate_lock_allowed_when_closed if {
	tx := noto(n_rd, "bankA@node2", "delegateLock", {"lockId": "0x01", "delegate": "0x00000000000000000000000000000000000000bb", "data": "0x"})
	n_with_bi(send("node2", tx), closed("RD"))
}

# --- Pente: only the groups BI knows

test_pente_known_group_allowed if allowed(rpc("node1", "pgroup_sendTransaction", [{"domain": "pente", "group": "0x90c28c12c7333c548e02550f7c5a709267880ce87badd26e137ece965c739c68", "from": "bondIssuer@node1", "to": "0x900bb5b2043366f2bb3ee1e7c79a0eef793ae284", "input": {}}]))

test_pente_unknown_group_denied if not allowed(rpc("node2", "pgroup_sendTransaction", [{"domain": "pente", "group": "0x01"}]))

# --- The bank's own rules

test_noto_bank_non_counterparty_denied if not n_with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), {"policy": {"noto": {"counterparties": ["bankC@node4"]}}})

test_noto_bank_prepare_non_counterparty_denied if not n_with_bank(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "10")), {"policy": {"noto": {"counterparties": ["bankC@node4"]}}})

test_noto_bank_rollback_to_self_allowed if n_with_bank(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "10")), {"policy": {"noto": {"counterparties": ["bankC@node4"]}}})

test_noto_bank_max_per_tx_denied if not n_with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "11")), fixtures.bank_with("noto", {"max_per_tx": {"RD": 10}}))

test_noto_bank_max_per_tx_within_allowed if n_with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), fixtures.bank_with("noto", {"max_per_tx": {"RD": 10}}))

test_noto_bank_hours_on_lock_denied if {
	bank := fixtures.bank_with("noto", {"hours": {"RD": {"days": [], "open": "00:00", "close": "24:00"}}})
	not n_with_bank(send("node2", n_lock(n_dfabi, "bankA@node2", "1")), bank)
}

# --- Daily limit on the Noto rail (its own limit and spend; node2's Paladin is asked for the noto domain only)

# 400m out on RD (transfer 300m + prepareUnlock 100m); the rollback, the lock, the other token and the mint do not count.
noto_rows := [
	{"function": "transfer(string,uint256,bytes)", "to": n_rd, "data": {"to": "bankB@node3", "amount": "300000000", "data": "0x"}},
	{"function": "prepareUnlock(bytes32,string,(string,uint256)[],bytes,bytes)", "to": n_rd, "from": "bankA@node2", "data": {"from": "bankA@node2", "recipients": [{"to": "bankB@node3", "amount": "100000000"}]}},
	{"function": "prepareUnlock(bytes32,string,(string,uint256)[],bytes,bytes)", "to": n_rd, "from": "bankA@node2", "data": {"from": "bankA@node2", "recipients": [{"to": "bankA@node2", "amount": "9000000000"}]}},
	{"function": "lock(uint256,bytes)", "to": n_rd, "data": {"amount": "9000000000"}},
	{"function": "transfer(string,uint256,bytes)", "to": n_dfabi, "data": {"to": "bankB@node3", "amount": "9000000000", "data": "0x"}},
	{"function": "mint(string,uint256,bytes)", "to": n_rd, "data": {"to": "bankA@node2", "amount": "9000000000", "data": "0x"}},
]

# Limit 500m, 400m used.
noto_daily(i) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("noto", {"daily_limit": {"RD": 500000000}})
		with time.now_ns as now_ns
}

test_noto_daily_within_allowed if noto_daily(send("node2", n_transfer("bankA@node2", "bankB@node3", "100000000"))) with http.send as mock_noto_used

test_noto_daily_over_denied if not noto_daily(send("node2", n_transfer("bankA@node2", "bankB@node3", "100000001"))) with http.send as mock_noto_used

test_noto_daily_prepare_over_denied if not noto_daily(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "100000001"))) with http.send as mock_noto_used

# Zeto spent 4.5bn today (used_rows), far over the Noto limit, and it does not count: only the noto domain is asked.
test_noto_daily_ignores_zeto_spend if {
	i := send("node2", n_transfer("bankA@node2", "bankB@node3", "100000000"))
	noto_daily(i) with http.send as mock_both
	not noto_daily(send("node2", n_transfer("bankA@node2", "bankB@node3", "100000001"))) with http.send as mock_both
}

# Fails closed on its own query, but a failing Zeto query does not matter to Noto.
test_noto_daily_own_query_down_denied if {
	i := send("node2", n_transfer("bankA@node2", "bankB@node3", "100000000"))
	not noto_daily(i) with http.send as mock_noto_down
	noto_daily(i) with http.send as mock_zeto_down
}

test_noto_daily_rollback_not_gated if noto_daily(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "5000000000"))) with http.send as mock_both

# A limit in the Zeto document does not apply to Noto: Paladin is not asked.
test_noto_daily_zeto_limit_not_applied if {
	gw.allow with input as send("node2", n_transfer("bankA@node2", "bankB@node3", "10"))
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_with("zeto", {"daily_limit": {"RD": 1}})
		with http.send as {"status_code": 500, "body": {}}
		with time.now_ns as now_ns
}

# --- The two platforms are independent

# A freeze in the Noto document blocks Noto and leaves Zeto alone.
test_noto_freeze_does_not_block_zeto if {
	zt := send("node2", transfer("bankA@node2", "bankC@node4", 10))
	nt := send("node2", n_transfer("bankA@node2", "bankC@node4", "10"))
	bi := frozen("bankC@node4")
	n_with_bi(zt, bi)
	not n_with_bi(nt, bi)
}

# A freeze in the Zeto document blocks Zeto and leaves Noto alone.
test_zeto_freeze_does_not_block_noto if {
	zt := send("node2", transfer("bankA@node2", "bankC@node4", 10))
	nt := send("node2", n_transfer("bankA@node2", "bankC@node4", "10"))
	bi := fixtures.bi_with("zeto", {"frozen": ["bankC@node4"]})
	n_with_bi(nt, bi)
	not n_with_bi(zt, bi)
}

# Zeto hours closed (RD) do not close Noto RD, and Noto closed does not close Zeto.
test_zeto_hours_closed_does_not_block_noto if {
	zeto_closed := fixtures.bi_with("zeto", {"hours": {"RD": {"days": [], "open": "00:00", "close": "24:00"}}})
	n_with_bi(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), zeto_closed)
	not n_with_bi(send("node2", transfer("bankA@node2", "bankB@node3", 10)), zeto_closed)
	n_with_bi(send("node2", transfer("bankA@node2", "bankB@node3", 10)), closed("RD"))
}

# Caps are per platform too.
test_zeto_cap_does_not_limit_noto if {
	bi := fixtures.bi_with("zeto", {"max_per_tx": {"RD": 5}})
	n_with_bi(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), bi)
	not n_with_bi(send("node2", transfer("bankA@node2", "bankB@node3", 10)), bi)
}

# Holidays too: a holiday in the Zeto document (2026-11-05) closes Zeto only.
test_zeto_holiday_does_not_close_noto if {
	bi := fixtures.bi_with("zeto", {"holidays": [{"date": "2026-11-05", "name": "Libur"}]})
	n_with_bi(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), bi) with time.now_ns as now_ns
	not n_with_bi(send("node2", transfer("bankA@node2", "bankB@node3", 10)), bi) with time.now_ns as now_ns
}

# Removing a counterparty from the bank's Zeto document leaves Noto alone, and the other way round.
test_zeto_counterparty_removal_does_not_block_noto if {
	bank := fixtures.bank_with("zeto", {"counterparties": ["bi@node1", "bankC@node4"]})
	n_with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), bank)
	not n_with_bank(send("node2", transfer("bankA@node2", "bankB@node3", 10)), bank)
}

test_noto_counterparty_removal_does_not_block_zeto if {
	bank := fixtures.bank_with("noto", {"counterparties": ["bi@node1", "bankC@node4"]})
	n_with_bank(send("node2", transfer("bankA@node2", "bankB@node3", 10)), bank)
	not n_with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), bank)
}

# The bank's per-tx limit and hours are per platform as well.
test_bank_noto_limit_does_not_limit_zeto if {
	bank := fixtures.bank_with("noto", {"max_per_tx": {"RD": 5}, "hours": {"RD": {"days": [], "open": "00:00", "close": "24:00"}}})
	n_with_bank(send("node2", transfer("bankA@node2", "bankB@node3", 10)), bank)
	not n_with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), bank)
}
