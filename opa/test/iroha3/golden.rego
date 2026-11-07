# Golden decoder outputs for the Iroha 3 rules: what the txdec sidecar answers (apps/rd-dfabi/schema/decode-tx.response.json),
# with SYNTHETIC ids only. Each is shaped exactly as the schema (contract_test.rego validates them against it). The tests
# hand these to the rules through a mocked http.send; nothing here is a live account or asset id.
package iroha3_golden

bi_acct := "acct-bi-0001"

a_acct := "acct-a-0002"

b_acct := "acct-b-0003"

c_acct := "acct-c-0004"

# The X-Iroha-Account value (canonical hex in Torii) of each party's account and of the operator.
bi_signer := "0xbi0001"

a_signer := "0xa00002"

b_signer := "0xb00003"

c_signer := "0xc00004"

op_signer := "0xop0005"

rd := "defRD-synthetic-0001"

dfabi := "defDFABI-synthetic-0002"

# Same display name as RD, another definition id: not the RD of the data.
rd_lookalike := "defRD-synthetic-0666"

# data.bi.config.iroha3 of the tests
structure := {
	"dataspace": 1,
	"assets": {"RD": rd, "DFABI": dfabi},
	"accounts": {
		bi_acct: "node1",
		a_acct: "node2",
		b_acct: "node3",
		c_acct: "node4",
	},
	"signers": {
		bi_signer: "node1",
		a_signer: "node2",
		b_signer: "node3",
		c_signer: "node4",
	},
	"operator": op_signer,
}

# A TxView (the decoder's answer for a clean Norito transaction) around the given instructions.
tx(authority, instructions) := {
	"ok": true,
	"encoding": "norito",
	"tx_hash": "3b1c0f9d6e5a47c8b2a1d0e9f8c7b6a5948372615f4e3d2c1b0a9988776655aa",
	"signature_ok": true,
	"authority": authority,
	"chain_id": "hash:00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF#AB",
	"creation_time_ms": 1793860000000,
	"time_to_live_ms": 100000,
	"nonce": null,
	"admission_intent": "ordinary",
	"fee_payer": "authority",
	"executable": "instructions",
	"has_attachments": false,
	"has_multisig": false,
	"instructions": instructions,
}

move(kind, def, quantity, from, to) := {
	"kind": kind,
	"asset_definition": def,
	"quantity": quantity,
	"scale": 0,
	"from": from,
	"to": to,
	"scope": "dataspace:1",
	"dataspace": 1,
}

mint(def, quantity, to) := move("mint", def, quantity, null, to)

burn(def, quantity, from) := move("burn", def, quantity, from, null)

transfer(def, quantity, from, to) := move("transfer", def, quantity, from, to)

leg(def, quantity, from, to) := {
	"asset_definition": def,
	"quantity": quantity,
	"scale": 0,
	"from": from,
	"to": to,
}

# The seller gives DFABI, the buyer pays RD.
dvp(seller, buyer) := {
	"kind": "dvp",
	"settlement_id": "dvp_test_1",
	"delivery": leg(dfabi, "5", seller, buyer),
	"payment": leg(rd, "500", buyer, seller),
	"order": "delivery_then_payment",
	"atomicity": "all_or_nothing",
	"intent_hash": "hash:AC71FE0000000000000000000000000000000000000000000000000000000001#7D",
}

# The buyer's CanExecuteSettlement grant for an intent hash.
consent(to, h) := {
	"kind": "grant",
	"grant_kind": "permission",
	"permission": "CanExecuteSettlement",
	"payload": {"debited_asset": "asset-synthetic-0001", "intent_hash": h, "settlement_id": "dvp_test_1"},
	"to": to,
	"consent": {"debited_asset": "asset-synthetic-0001", "intent_hash": h, "settlement_id": "dvp_test_1"},
}

active_hash := "hash:AC71FE0000000000000000000000000000000000000000000000000000000001#7D"

expired_hash := "hash:E5D1000000000000000000000000000000000000000000000000000000000002#11"

consumed_hash := "hash:C0D5000000000000000000000000000000000000000000000000000000000003#22"

other_hash := "hash:0A1E000000000000000000000000000000000000000000000000000000000004#33"

unregistered_hash := "hash:DEAD000000000000000000000000000000000000000000000000000000000005#44"

intent(status, buyer, h) := {"status": status, "buyer": buyer, "intent_hash": h, "expires_at": 1793860120000}

# What the store answers (POST /intent/lookup). A hash it never saw answers {"status": "unknown"} (see iroha3_test).
intents := {
	active_hash: intent("active", b_acct, active_hash),
	expired_hash: intent("expired", b_acct, expired_hash),
	consumed_hash: intent("consumed", b_acct, consumed_hash),
	other_hash: intent("active", c_acct, other_hash),
}

# --- the named golden fixtures

transfer_rd := tx(a_acct, [transfer(rd, "1000", a_acct, b_acct)])

transfer_dfabi := tx(a_acct, [transfer(dfabi, "10", a_acct, b_acct)])

mint_rd := tx(bi_acct, [mint(rd, "5000", a_acct)])

burn_rd := tx(bi_acct, [burn(rd, "70", bi_acct)])

dvp_settlement := tx(a_acct, [dvp(a_acct, b_acct)])

dvp_consent := tx(b_acct, [consent(a_acct, active_hash)])

# A DvP registration (POST /gw/intent): the sidecar's answer for the rendered box
dvp_registration := {"ok": true, "instruction": dvp(a_acct, b_acct)}

unknown_kind := tx(a_acct, [{"kind": "unknown", "raw_kind": "iroha.log"}])
