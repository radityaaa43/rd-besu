# Bank A's own rules, on top of BI's, for Zeto and Noto alike: outputs (transfers and DvP locks) go only to its counterparties
# (compared by node, so every identity on a counterparty's node counts),
# when the bank sets hours for a token, mint/transfer/createLock only fall inside them, and when it sets
# max_per_tx for a token, the sum of a transfer's or lock's outputs stays under it (BI's cap applies too).
# When it sets daily_limit for a token, today's outgoing total (from its own Paladin node) plus the request stays
# under it.
package bank.paladin

import data.bank.ident

tx := input.parsed_body.params[0]

# Zeto by domain or by BI's contract map (the SDK omits `domain` on writes).
# The map is read as data, not through a BI function, so this bundle builds alone.
is_zeto if tx.domain == "zeto"

is_zeto if data.bi.config.zeto.contracts[lower(tx.to)]

write if input.parsed_body.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}

# Noto by BI's contract map (Zeto first, as in bi.paladin). A DvP leg sends value at prepareUnlock; one that only
# returns the lock to its owner (rollback) sends nothing out.
noto_token := data.bi.config.noto.contracts[lower(tx.to)] if not is_zeto

noto_outs := [{"to": tx.data.to, "amount": tx.data.amount}] if {
	write
	noto_token
	tx.function == "transfer"
}

noto_outs := tx.data.recipients if {
	write
	noto_token
	tx.function == "prepareUnlock"
	not returns_lock(tx)
}

returns_lock(t) if {
	count(t.data.recipients) > 0
	every o in t.data.recipients {
		o.to == t.from
	}
}

recipients contains o.to if {
	input.parsed_body.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	is_zeto
	some field in ["transfers", "recipients"]
	some o in tx.data[field]
}

recipients contains o.to if some o in noto_outs

# A DvP lock touches both tokens; mint and transfer only their own.
gated_tokens contains data.bi.zeto.token if {
	input.parsed_body.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	is_zeto
	tx.function in {"mint", "transfer"}
}

gated_tokens contains token if {
	input.parsed_body.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	is_zeto
	tx.function == "createLock"
	some token in ["RD", "DFABI"]
}

gated_tokens contains noto_token if {
	write
	tx.function in {"mint", "transfer"}
}

gated_tokens contains token if {
	write
	noto_token
	tx.function == "lock"
	some token in ["RD", "DFABI"]
}

gated_tokens contains token if {
	count(noto_outs) > 0
	tx.function == "prepareUnlock"
	some token in ["RD", "DFABI"]
}

counterparty_nodes contains ident.node_of(c) if some c in data.bank.config.counterparties

counterparty(id) if ident.node_of(id) in counterparty_nodes

default allow := true

allow := false if {
	some r in recipients
	not counterparty(r)
}

allow := false if {
	some t in gated_tokens
	hours := data.bank.config.hours[t]
	not bank_window_open(hours)
}

allow := false if {
	daily_gated
	not daily_rows
}

allow := false if {
	daily_gated
	daily_used + daily_request > data.bank.config.daily_limit[daily_token]
}

# The token comes from BI's contract map (data, not a function call, so this bundle builds alone).
allow := false if {
	input.parsed_body.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	is_zeto
	field := {"transfer": "transfers", "createLock": "recipients"}[tx.function]
	cap := data.bank.config.max_per_tx[data.bi.config.zeto.contracts[lower(tx.to)]]
	sum([to_number(o.amount) | some o in tx.data[field]]) > cap
}

allow := false if sum([to_number(o.amount) | some o in noto_outs]) > data.bank.config.max_per_tx[noto_token]

# Daily limit (spec 6.3), per rail: the query asks only for the request's domain. OPA keeps no state and Zeto hides
# amounts on chain, so the gateway asks its own Paladin
# node for today's transactions (a node returns only the ones it submitted, any identity of the bank counts).
# Fails closed: no answer, non-200, a JSON-RPC error, or a full page means deny. Counted on submit, no lock:
# two requests in the same instant can both pass.
daily_page := 1000

daily_token := data.bi.config.zeto.contracts[lower(tx.to)]

daily_token := noto_token

daily_domain := "zeto" if is_zeto

daily_domain := "noto" if noto_token

# Only a bank with a limit for the request's token queries Paladin.
daily_gated if {
	input.parsed_body.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	is_zeto
	tx.function in {"transfer", "createLock"}
	data.bank.config.daily_limit[daily_token]
}

daily_gated if {
	count(noto_outs) > 0
	data.bank.config.daily_limit[noto_token]
}

# Today 00:00 WIB as UTC (WIB is UTC+7, no DST): "2026-11-05" -> "2026-11-04T17:00:00Z". BI's clock is read as data.
midnight_wib_ns := time.parse_ns("2006-01-02", data.bi.clock.today) - 25200000000000

day_start := time.format([midnight_wib_ns, "UTC", "2006-01-02T15:04:05Z"])

daily_query := {
	"method": "POST",
	"url": data.bi.config.nodes[input.attributes.contextExtensions.node].paladin_url,
	"headers": {"content-type": "application/json"},
	"body": {"jsonrpc": "2.0", "id": 1, "method": "ptx_queryTransactionsFull", "params": [{
		"limit": daily_page,
		"eq": [{"field": "domain", "value": daily_domain}],
		"greaterThan": [{"field": "created", "value": day_start}],
	}]},
	"timeout": "2s",
	"cache": false,
	"raise_error": false,
}

# Complete rule, so http.send runs once per request. Undefined when the answer cannot be trusted.
daily_rows := resp.body.result if {
	resp := http.send(daily_query)
	resp.status_code == 200
	is_array(resp.body.result)
	count(resp.body.result) < daily_page
}

daily_used := (sum([to_number(o.amount) |
	some r in daily_rows
	split(r.function, "(")[0] in {"transfer", "createLock"}
	data.bi.config.zeto.contracts[lower(r.to)] == daily_token
	some field in ["transfers", "recipients"]
	some o in r.data[field]
]) + sum([to_number(r.data.amount) |
	some r in daily_rows
	split(r.function, "(")[0] == "transfer"
	data.bi.config.noto.contracts[lower(r.to)] == daily_token
])) + sum([to_number(o.amount) |
	some r in daily_rows
	split(r.function, "(")[0] == "prepareUnlock"
	data.bi.config.noto.contracts[lower(r.to)] == daily_token
	not returns_lock(r)
	some o in r.data.recipients
])

daily_request := sum([to_number(o.amount) |
	is_zeto
	field := {"transfer": "transfers", "createLock": "recipients"}[tx.function]
	some o in tx.data[field]
]) + sum([to_number(o.amount) | some o in noto_outs])

# BI's clock values as data (not its open() function), so this bundle builds alone. Holidays are BI's.
bank_window_open(h) if {
	data.bi.clock.weekday in h.days
	h.open <= data.bi.clock.hhmm
	data.bi.clock.hhmm < h.close
}
