# BI's balance controls for Noto only. BI's node (the issuer, node1) is the Noto notary and sees every Noto state, so
# any gateway can ask it (http.send, ptx_call balanceOf from BI's identity) for any account's balance, and for the
# supply (sum of the confirmed coin and locked-coin states). OPA keeps no state, so every governed request asks node1.
# All three controls are optional, per token (absent = no check), and set by BI only:
#   max_balance: a recipient's balance after receiving stays <= cap (mint, transfer, prepareUnlock recipients);
#   min_balance: the sender's balance after sending stays >= floor (transfer, lock, prepareUnlock). A lock takes the
#     amount out of the balance at once, so prepareUnlock only sees what is left, and a prepareUnlock that returns the
#     lock to its owner (the DvP rollback) is exempt;
#   max_supply: total supply after a mint stays <= cap.
# Fails closed like the daily limit: a control is set and node1 gives no usable answer (no answer, non-200, overflow,
# a full page) means deny. Counted when the request is checked, no lock: two requests in the same instant can both pass,
# and a transaction still in flight is not counted.
package bi.balance

tx := input.parsed_body.params[0]

# BI's three controls live under data.bi.config.noto; repoint here if they move.
controls := object.get(data.bi.config, "noto", {})

max_balance := object.get(controls, "max_balance", {})

min_balance := object.get(controls, "min_balance", {})

max_supply := object.get(controls, "max_supply", {})

write if input.parsed_body.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}

token := data.bi.config.noto.contracts[lower(tx.to)]

# Every recipient is the sender itself: the lock goes back to its owner.
to_self if {
	count(tx.data.recipients) > 0
	every o in tx.data.recipients {
		o.to == tx.from
	}
}

default incoming := []

incoming := [{"to": tx.data.to, "amount": tx.data.amount}] if {
	write
	token
	tx.function in {"mint", "transfer"}
}

incoming := tx.data.recipients if {
	write
	token
	tx.function == "prepareUnlock"
	not to_self
}

# What leaves the sender's balance now. Undefined for a mint and for the rollback.
sent := to_number(tx.data.amount) if {
	write
	token
	tx.function in {"transfer", "lock"}
}

sent := 0 if {
	write
	token
	tx.function == "prepareUnlock"
	not to_self
}

received[a] := sum([to_number(o.amount) | some o in incoming; o.to == a]) if some a in {o.to | some o in incoming}

default allow := true

allow := false if {
	cap := max_balance[token]
	some a, amount in received
	not under_cap(a, amount, cap)
}

allow := false if {
	floor := min_balance[token]
	out := sent
	not above_floor(tx.from, out, floor)
}

allow := false if {
	cap := max_supply[token]
	write
	tx.function == "mint"
	not supply_ok(to_number(tx.data.amount), cap)
}

under_cap(a, amount, cap) if balance(a) + amount <= cap

above_floor(a, out, floor) if balance(a) - out >= floor

supply_ok(amount, cap) if supply + amount <= cap

supply := total(coin_schema) + total(locked_coin_schema)

# --- node1 queries

page := 1000

# Noto state schemas (ids are hashes of the type signature, the same on every Noto contract).
coin_schema := "0x39aa9c8bb0d781b43c3da1beff4ab34043e45e007316ce77412c243868815a02"

locked_coin_schema := "0xdd51fde11e013d11f5a0578490620f3ac4da535291f023a1099b46c39310ceec"

bi_node := [n | some n in data.bi.config.nodes; n.issuer == true][0]

balance_abi := [{
	"type": "function",
	"name": "balanceOf",
	"stateMutability": "view",
	"inputs": [{"name": "account", "type": "string", "internalType": "string"}],
	"outputs": [
		{"name": "totalStates", "type": "uint256", "internalType": "uint256"},
		{"name": "totalBalance", "type": "uint256", "internalType": "uint256"},
		{"name": "overflow", "type": "bool", "internalType": "bool"},
	],
}]

query(params, method) := {
	"method": "POST",
	"url": bi_node.paladin_url,
	"headers": {"content-type": "application/json"},
	"body": {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
	"timeout": "2s",
	"cache": false,
	"raise_error": false,
}

balance_query(a) := query(
	[{
		"type": "private",
		"domain": "noto",
		"function": "balanceOf",
		"to": lower(tx.to),
		"from": bi_node.identities[0],
		"data": {"account": a},
		"abi": balance_abi,
	}],
	"ptx_call",
)

states_query(schema) := query(["noto", lower(tx.to), schema, {"limit": page}, "confirmed"], "pstate_queryContractStates")

# Complete rules, so http.send runs once per value. Undefined when the answer cannot be trusted.
balance(a) := to_number(resp.body.result.totalBalance) if {
	resp := http.send(balance_query(a))
	resp.status_code == 200
	resp.body.result.overflow == false
}

total(schema) := sum([to_number(s.data.amount) | some s in rows]) if {
	resp := http.send(states_query(schema))
	resp.status_code == 200
	is_array(resp.body.result)
	count(resp.body.result) < page
	rows := resp.body.result
}
