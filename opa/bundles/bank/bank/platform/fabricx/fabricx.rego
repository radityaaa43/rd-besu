# The gateway's own bank rules for Fabric-X, on top of BI's (data.bank.config.policy.fabricx; node1's is BI's own
# bank document). What this party sends out of a request (its outflow) must go to a counterparty, fall inside the
# bank's hours for the tokens involved, stay under its max_per_tx, and with today's outflow stay under daily_limit.
#   transfer   amount of `type` to `to`         swap      `give` to `to`, both tokens' hours
#   redeem     amount of `type` (no recipient)  precheck  `get` to `from` (this party is the buyer), both tokens' hours
#   issue      amount of `type` to `to`         award     `dfabi` DFABI to `to`, both tokens' hours
# Reads and anything BI denies are not touched here (default allow; gw needs both bundles to allow).
# Daily limit: today's outflow per token comes from this party's own token records through its fxapi (op usage,
# same pod), as on Paladin from the node itself. Fails closed: no answer, non-200 or a bad body means deny. Counted on
# submit, no lock: two requests in the same instant can both pass. Issue and award are not counted (fxapi neither).
package bank.platform.fabricx

import data.bank.ident

body := input.parsed_body

# Copies of BI's maps (bi.platform.fabricx): this bundle builds alone.
fx_node := {"node1": "issuer", "node2": "bank2", "node3": "bank3", "node4": "bank4"}

party_node := {fx: n | some n, fx in fx_node}

tokens := {"RD": "RD", "DFABI-2027A": "DFABI"}

policy := data.bank.config.policy.fabricx

# {to: party node or "" (redeem), type: Fabric-X type, amount: string}
outflows contains {"to": party_node[body.to], "type": body.type, "amount": body.amount} if body.op in {"transfer", "issue"}

outflows contains {"to": party_node[body.to], "type": body.give.type, "amount": body.give.amount} if body.op == "swap"

outflows contains {"to": "", "type": body.type, "amount": body.amount} if body.op == "redeem"

outflows contains {"to": party_node[body.from], "type": body.get.type, "amount": body.get.amount} if body.op == "precheck"

outflows contains {"to": party_node[body.to], "type": "DFABI-2027A", "amount": body.dfabi} if body.op == "award"

gated_tokens contains tokens[o.type] if some o in outflows

gated_tokens contains t if {
	body.op in {"swap", "precheck", "award"}
	some t in ["RD", "DFABI"]
}

counterparty_nodes contains ident.node_of(c) if some c in policy.counterparties

default allow := true

allow := false if {
	some o in outflows
	o.to != ""
	not o.to in counterparty_nodes
}

allow := false if {
	some t in gated_tokens
	hours := policy.hours[t]
	not bank_window_open(hours)
}

allow := false if {
	some o in outflows
	to_number(o.amount) > policy.max_per_tx[tokens[o.type]]
}

allow := false if {
	some t in daily_types
	not used[t]
}

allow := false if {
	some t in daily_types
	used[t] + request[t] > policy.daily_limit[tokens[t]]
}

# Fabric-X types this request sends out and the bank limits per day.
daily_types contains o.type if {
	body.op in {"transfer", "swap", "redeem", "precheck"}
	some o in outflows
	policy.daily_limit[tokens[o.type]]
}

request[t] := sum([to_number(o.amount) | some o in outflows; o.type == t]) if some t in daily_types

# Today 00:00 WIB as UTC (WIB is UTC+7, no DST). BI's clock is read as data.
midnight_wib_ns := time.parse_ns("2006-01-02", data.bi.clock.today) - 25200000000000

day_start := time.format([midnight_wib_ns, "UTC", "2006-01-02T15:04:05Z"])

usage_query(t) := {
	"method": "POST",
	"url": "http://127.0.0.1:8080/",
	"headers": {"content-type": "application/json"},
	"body": {"op": "usage", "type": t, "since": day_start},
	"timeout": "2s",
	"cache": false,
	"raise_error": false,
}

# Undefined when the answer cannot be trusted.
used[t] := to_number(resp.body.amount) if {
	some t in daily_types
	resp := http.send(usage_query(t))
	resp.status_code == 200
	regex.match(`^(0|[1-9][0-9]{0,19})$`, resp.body.amount)
}

# BI's clock values as data (not its open() function), so this bundle builds alone. Holidays are BI's.
bank_window_open(h) if {
	data.bi.clock.weekday in h.days
	h.open <= data.bi.clock.hhmm
	data.bi.clock.hhmm < h.close
}
