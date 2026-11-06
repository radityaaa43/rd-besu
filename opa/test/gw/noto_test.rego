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

closed(token) := object.union(fixtures.bi, {"hours": {token: {"days": [], "open": "00:00", "close": "24:00"}}})

frozen(id) := object.union(fixtures.bi, {"frozen": [id]})

with_bi(i, bi) if gw.allow with input as i with data.bi.config as bi with data.bank.config as fixtures.bank_a

with_bank(i, bank) if gw.allow with input as i with data.bi.config as fixtures.bi with data.bank.config as bank

# --- BI: transfer and mint

test_noto_transfer_allowed if allowed(send("node2", n_transfer("investor1@node2", "investor2@node3", "10")))

test_noto_transfer_with_domain_allowed if allowed(send("node2", object.union(n_transfer("bankA@node2", "bankB@node3", "10"), {"domain": "noto"})))

test_noto_transfer_over_bi_cap_denied if not allowed(send("node2", noto(n_dfabi, "bankA@node2", "transfer", {"to": "bankB@node3", "amount": "1001"})))

test_noto_transfer_to_outsider_denied if not allowed(send("node2", n_transfer("bankA@node2", "eve@node9", "10")))

test_noto_transfer_from_other_node_denied if not allowed(send("node2", n_transfer("investor2@node3", "bankC@node4", "10")))

test_noto_transfer_zero_denied if not allowed(send("node2", n_transfer("bankA@node2", "bankB@node3", "0")))

test_noto_transfer_hours_closed_denied if not with_bi(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), closed("RD"))

test_noto_transfer_to_frozen_denied if not with_bi(send("node2", n_transfer("bankA@node2", "bankC@node4", "10")), frozen("bankC@node4"))

test_noto_transfer_from_frozen_denied if not with_bi(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), frozen("bankA@node2"))

test_noto_mint_by_bi_allowed if allowed(send("node1", noto(n_rd, "cashIssuer@node1", "mint", {"to": "investor1@node2", "amount": "5000", "data": "0x"})))

test_noto_mint_by_bank_denied if not allowed(send("node2", noto(n_rd, "bankA@node2", "mint", {"to": "bankA@node2", "amount": "5", "data": "0x"})))

test_noto_unknown_contract_denied if not allowed(send("node2", object.union(noto("0x00000000000000000000000000000000000000cc", "bankA@node2", "transfer", {"to": "bankB@node3", "amount": "1"}), {"domain": "noto"})))

test_noto_deploy_denied if not allowed(send("node1", {"type": "private", "domain": "noto", "from": "bi@node1", "function": "", "data": {}}))

test_noto_burn_denied if not allowed(send("node2", noto(n_rd, "bankA@node2", "burn", {"amount": "1", "data": "0x"})))

# --- BI: DvP leg (lock, prepareUnlock, delegateLock) and its rollback

test_noto_lock_allowed if allowed(send("node2", n_lock(n_dfabi, "investor1@node2", "100")))

test_noto_lock_over_cap_denied if not allowed(send("node2", n_lock(n_dfabi, "investor1@node2", "1001")))

test_noto_lock_other_token_closed_denied if not with_bi(send("node2", n_lock(n_dfabi, "bankA@node2", "1")), closed("RD"))

test_noto_prepare_unlock_allowed if allowed(rpc("node2", "ptx_sendTransaction", [n_prepare(n_dfabi, "investor1@node2", "investor2@node3", "100")]))

test_noto_prepare_unlock_prepare_method_allowed if allowed(rpc("node2", "ptx_prepareTransaction", [n_prepare(n_dfabi, "investor1@node2", "investor2@node3", "100")]))

test_noto_prepare_unlock_to_outsider_denied if not allowed(send("node2", n_prepare(n_rd, "bankA@node2", "eve@node9", "10")))

test_noto_prepare_unlock_to_frozen_denied if not with_bi(send("node2", n_prepare(n_rd, "bankA@node2", "bankC@node4", "10")), frozen("bankC@node4"))

# Rollback returns the lock to its owner: never blocked by hours or freezing.
test_noto_rollback_prepare_allowed_when_closed_and_frozen if {
	bi := object.union(closed("RD"), {"frozen": ["bankA@node2"]})
	with_bi(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "10")), bi)
}

test_noto_delegate_lock_allowed_when_closed if {
	tx := noto(n_rd, "bankA@node2", "delegateLock", {"lockId": "0x01", "delegate": "0x00000000000000000000000000000000000000bb", "data": "0x"})
	with_bi(send("node2", tx), closed("RD"))
}

# --- Pente: only the groups BI knows

test_pente_known_group_allowed if allowed(rpc("node1", "pgroup_sendTransaction", [{"domain": "pente", "group": "0x90c28c12c7333c548e02550f7c5a709267880ce87badd26e137ece965c739c68", "from": "bondIssuer@node1", "to": "0x900bb5b2043366f2bb3ee1e7c79a0eef793ae284", "input": {}}]))

test_pente_unknown_group_denied if not allowed(rpc("node2", "pgroup_sendTransaction", [{"domain": "pente", "group": "0x01"}]))

# --- The bank's own rules

test_noto_bank_non_counterparty_denied if not with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), {"counterparties": ["bankC@node4"]})

test_noto_bank_prepare_non_counterparty_denied if not with_bank(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "10")), {"counterparties": ["bankC@node4"]})

test_noto_bank_rollback_to_self_allowed if with_bank(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "10")), {"counterparties": ["bankC@node4"]})

test_noto_bank_max_per_tx_denied if not with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "11")), object.union(fixtures.bank_a, {"max_per_tx": {"RD": 10}}))

test_noto_bank_max_per_tx_within_allowed if with_bank(send("node2", n_transfer("bankA@node2", "bankB@node3", "10")), object.union(fixtures.bank_a, {"max_per_tx": {"RD": 10}}))

test_noto_bank_hours_on_lock_denied if {
	bank := object.union(fixtures.bank_a, {"hours": {"RD": {"days": [], "open": "00:00", "close": "24:00"}}})
	not with_bank(send("node2", n_lock(n_dfabi, "bankA@node2", "1")), bank)
}

# --- Daily limit on the Noto rail (asks node2's Paladin for today's Noto txs)

noto_query(req) if {
	req.url == "http://paladin-node2.paladin.svc.cluster.local:8548"
	q := req.body.params[0]
	q.eq == [{"field": "domain", "value": "noto"}]
	q.greaterThan == [{"field": "created", "value": "2026-11-04T17:00:00Z"}]
}

# 300 out (transfer 200 + prepareUnlock 100); the rollback, the lock, the other token and the mint do not count.
noto_rows := [
	{"function": "transfer(string,uint256,bytes)", "to": n_rd, "data": {"to": "bankB@node3", "amount": "200", "data": "0x"}},
	{"function": "prepareUnlock(bytes32,string,(string,uint256)[],bytes,bytes)", "to": n_rd, "from": "bankA@node2", "data": {"from": "bankA@node2", "recipients": [{"to": "bankB@node3", "amount": "100"}]}},
	{"function": "prepareUnlock(bytes32,string,(string,uint256)[],bytes,bytes)", "to": n_rd, "from": "bankA@node2", "data": {"from": "bankA@node2", "recipients": [{"to": "bankA@node2", "amount": "900"}]}},
	{"function": "lock(uint256,bytes)", "to": n_rd, "data": {"amount": "900"}},
	{"function": "transfer(string,uint256,bytes)", "to": n_dfabi, "data": {"to": "bankB@node3", "amount": "900", "data": "0x"}},
	{"function": "mint(string,uint256,bytes)", "to": n_rd, "data": {"to": "bankA@node2", "amount": "900", "data": "0x"}},
]

mock_noto(req) := paladin_reply(noto_rows) if noto_query(req)

noto_daily(i) if {
	gw.allow with input as i
		with data.bi.config as fixtures.bi
		with data.bank.config as object.union(fixtures.bank_a, {"daily_limit": {"RD": 400}})
		with time.now_ns as now_ns
		with http.send as mock_noto
}

test_noto_daily_within_allowed if noto_daily(send("node2", n_transfer("bankA@node2", "bankB@node3", "100")))

test_noto_daily_over_denied if not noto_daily(send("node2", n_transfer("bankA@node2", "bankB@node3", "101")))

test_noto_daily_prepare_over_denied if not noto_daily(send("node2", n_prepare(n_rd, "bankA@node2", "bankB@node3", "101")))

test_noto_daily_rollback_not_gated if noto_daily(send("node2", n_prepare(n_rd, "bankA@node2", "bankA@node2", "5000")))
