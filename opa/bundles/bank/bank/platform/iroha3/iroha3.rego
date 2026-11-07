# The gateway's own bank rules for Iroha 3, on top of BI's (data.bank.config.policy.iroha3; node1's is BI's own bank
# document). What this party sends out of a request (its outflow) must go to a counterparty, fall inside the bank's hours
# for the tokens involved, stay under its max_per_tx, and with today's outflow stay under daily_limit.
#   transfer          amount of the token to `to`
#   mint              amount to the recipient (BI's gateway; BI itself is no counterparty question). Not counted per day
#   DvP               the seller's delivery leg to the buyer, both tokens' hours
#   POST /gw/intent   the buyer's payment leg to the seller (the buyer's side of the same DvP), both tokens' hours
# Reads, burn, the consent grant (its legs were checked when the intent was registered) and anything BI denies are not
# touched here (default allow; gw needs both bundles to allow). The transaction is decoded by the same txdec sidecar as in
# BI's package (this bundle builds alone and calls it itself); a body that does not decode to one instruction is denied.
# Asset ids, accounts and the dataspace are BI's structural data (data.bi.config.iroha3), read as data.
# Daily limit: today's outflow per token comes from the gateway's own decode journal (txdec POST /usage {token, since}):
# counted at submit, so a consent whose DvP never executes stays counted. Fails closed: no answer, non-200, an incomplete
# journal (started after midnight, e.g. a pod that moved) or a bad body means deny. No lock: two requests in the same
# instant can both pass. Mint and burn are not counted.
package bank.platform.iroha3

import data.bank.ident

http_in := input.attributes.request.http

own := input.attributes.contextExtensions.node

cfg := data.bi.config.iroha3

policy := data.bank.config.policy.iroha3

sidecar := "http://127.0.0.1:8090"

path := split(http_in.path, "?")[0]

ct := object.get(http_in.headers, "content-type", "")

# Same request as BI's package.
tx := resp.body if {
	http_in.method == "POST"
	path == "/v1/pipeline/transactions"
	ct == "application/x-norito"
	resp := http.send(sidecar_req("/decode", {"b64": http_in.rawBody, "ct": ct}))
	resp.status_code == 200
	resp.body.ok == true
}

reg := resp.body if {
	http_in.method == "POST"
	path == "/gw/intent"
	resp := http.send(sidecar_req("/intent/decode", {"b64": http_in.rawBody, "ct": ct}))
	resp.status_code == 200
	resp.body.ok == true
}

sidecar_req(p, body) := {
	"method": "POST",
	"url": concat("", [sidecar, p]),
	"headers": {"content-type": "application/json"},
	"body": body,
	"timeout": "2s",
	"cache": false,
	"raise_error": false,
}

# The route carries a transaction (or a DvP registration): without a decodable instruction, deny.
decoded_route if {
	http_in.method == "POST"
	path in {"/v1/pipeline/transactions", "/gw/intent"}
}

instr := tx.instructions[0] if count(tx.instructions) == 1

instr := reg.instruction if reg.instruction.kind == "dvp"

# {to: node name ("unknown" for an account not in data), token: "" for an asset not in data, amount, daily: counts per day}
outflows contains {"to": node(instr.to), "token": movement_token(instr), "amount": instr.quantity, "scale": instr.scale, "daily": true} if {
	instr.kind == "transfer"
	path == "/v1/pipeline/transactions"
}

outflows contains {"to": node(instr.to), "token": movement_token(instr), "amount": instr.quantity, "scale": instr.scale, "daily": false} if {
	instr.kind == "mint"
	path == "/v1/pipeline/transactions"
}

# Seller's side: gives the delivery leg.
outflows contains {"to": node(instr.delivery.to), "token": leg_token(instr.delivery), "amount": instr.delivery.quantity, "scale": instr.delivery.scale, "daily": true} if {
	instr.kind == "dvp"
	path == "/v1/pipeline/transactions"
}

# Buyer's side: gives the payment leg.
outflows contains {"to": node(instr.payment.to), "token": leg_token(instr.payment), "amount": instr.payment.quantity, "scale": instr.payment.scale, "daily": true} if {
	instr.kind == "dvp"
	path == "/gw/intent"
}

node(a) := object.get(cfg.accounts, a, "unknown")

# "" for an asset not in data. The scope is BI's check.
movement_token(i) := object.get(token_of, i.asset_definition, "")

leg_token(l) := object.get(token_of, l.asset_definition, "")

token_of[def] := token if {
	some token, def in cfg.assets
}

# Both tokens of a DvP are gated by the hours, the amounts of its outflow only.
gated_tokens contains o.token if some o in outflows

gated_tokens contains t if {
	instr.kind == "dvp"
	some t, _ in cfg.assets
}

counterparty_nodes contains ident.node_of(c) if some c in policy.counterparties

default allow := true

allow := false if {
	decoded_route
	not instr
}

allow := false if {
	some o in outflows
	o.token == ""
}

allow := false if {
	some o in outflows
	not regex.match(`^[1-9][0-9]{0,15}$`, o.amount)
}

allow := false if {
	some o in outflows
	o.scale != 0
}

# A recipient that is this party (BI minting to itself) needs no counterparty entry.
allow := false if {
	some o in outflows
	o.to != own
	not o.to in counterparty_nodes
}

allow := false if {
	some t in gated_tokens
	hours := policy.hours[t]
	not bank_window_open(hours)
}

allow := false if {
	some o in outflows
	to_number(o.amount) > policy.max_per_tx[o.token]
}

allow := false if {
	some t in daily_tokens
	not used[t]
}

allow := false if {
	some t in daily_tokens
	used[t] + request[t] > policy.daily_limit[t]
}

# Tokens this request sends out and the bank limits per day.
daily_tokens contains o.token if {
	some o in outflows
	o.daily
	policy.daily_limit[o.token]
}

request[t] := sum([to_number(o.amount) | some o in outflows; o.daily; o.token == t]) if some t in daily_tokens

# Today 00:00 WIB as UTC (WIB is UTC+7, no DST). BI's clock is read as data.
midnight_wib_ns := time.parse_ns("2006-01-02", data.bi.clock.today) - 25200000000000

day_start := time.format([midnight_wib_ns, "UTC", "2006-01-02T15:04:05Z"])

usage_query(t) := {
	"method": "POST",
	"url": concat("", [sidecar, "/usage"]),
	"headers": {"content-type": "application/json"},
	"body": {"token": t, "since": day_start},
	"timeout": "2s",
	"cache": false,
	"raise_error": false,
}

# Undefined when the answer cannot be trusted. {"amount": "<whole units>", "complete": true}
used[t] := to_number(resp.body.amount) if {
	some t in daily_tokens
	resp := http.send(usage_query(t))
	resp.status_code == 200
	resp.body.complete == true
	regex.match(`^(0|[1-9][0-9]{0,19})$`, resp.body.amount)
}

# BI's clock values as data (not its open() function), so this bundle builds alone. Holidays are BI's.
bank_window_open(h) if {
	data.bi.clock.weekday in h.days
	h.open <= data.bi.clock.hhmm
	data.bi.clock.hhmm < h.close
}
