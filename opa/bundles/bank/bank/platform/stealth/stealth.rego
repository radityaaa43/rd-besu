# The gateway bank's own rules for target `stealth` (S17): same caller and routes as bi.platform.stealth (reads, and the writes BI's document
# allows), plus this bank's own Stealth document (data.bank.config.policy.stealth, the zeto/noto/fabricx bank schema): an outflow must go to
# one of its counterparties, within its own max_per_tx and inside its own hours. Recipients are named by stealth meta-address in the body and
# mapped to a node by data.bi.config.stealth_meta. Daily limit (2026-11-14): when the document sets daily_limit for a token, today's outflow
# (GET /outflow on this party's own signer, same namespace as this gateway) plus the request stays under it. Counted: rd-/bond-transfer and
# dvp-leg (what moves value out of a stealth address); not mints/issues (Paladin and Fabric-X count transfers only too). Fails closed: no
# answer, non-200 or a bad body means deny. Counted on submit, no lock: two requests in the same instant can both pass.
# A copy of the caller/route rules of bi.platform.stealth: this bundle builds alone (gw needs both to allow).
package bank.platform.stealth

import data.bank.ident

http := input.attributes.request.http

caller := input.attributes.source.principal

body := input.parsed_body

policy := data.bank.config.policy.stealth

lensa := {"CN=lensa", "CN=lensa-bi", "CN=lensa-bank-a", "CN=lensa-bank-b", "CN=lensa-bank-c"}

routes := {
	["POST", "/intent"], ["GET", "/holdings"], ["GET", "/history"], ["GET", "/health"], ["GET", "/meta-address"],
	["GET", "/ledger?kind=rd"], ["GET", "/ledger?kind=bond"],
	["POST", "/dvp/offer"], ["POST", "/dvp/bid"], ["POST", "/dvp/escrow"], ["POST", "/dvp/settle"], ["POST", "/dvp/cancel"],
}

token_of := {"rd-transfer": "RD", "bond-transfer": "DFABI", "rd-mint": "RD", "bond-issue": "DFABI"}

node_of_meta(m) := data.bi.config.stealth_meta[lower(m)] if is_string(m)

# What this request sends out of this party: recipient node ("" when only the escrow is known), token, amount.
outflows contains {"to": node_of_meta(body.to.metaAddress), "token": token_of[body.kind], "amount": body.amount} if {
	http.path == "/intent"
	body.kind in {"rd-transfer", "bond-transfer", "rd-mint", "bond-issue"}
}

outflows contains {"to": "", "token": {"bond": "DFABI", "rd": "RD"}[body.leg], "amount": body.amount} if {
	http.path == "/intent"
	body.kind == "dvp-leg"
}

outflows contains {"to": node_of_meta(body.buyerMeta), "token": "DFABI", "amount": body.amount} if http.path == "/dvp/offer"

outflows contains {"to": node_of_meta(body.sellerMeta), "token": "RD", "amount": body.price} if http.path == "/dvp/bid"

counterparty_nodes contains ident.node_of(c) if some c in policy.counterparties

default allow := false

allow if {
	caller in lensa
	route_ok
	not denied
}

route_ok if [http.method, http.path] in routes

route_ok if {
	http.method == "GET"
	regex.match(`^/outflow\?since=(0|[1-9][0-9]{0,11})$`, http.path)
}

denied if {
	http.method == "POST"
	not policy
}

# A recipient that is the gateway's own party (DFABI issued to BI itself) is not a counterparty transfer.
denied if {
	some o in outflows
	o.to != ""
	o.to != input.attributes.contextExtensions.node
	not o.to in counterparty_nodes
}

denied if {
	some o in outflows
	cap := policy.max_per_tx[o.token]
	not amount_within(o.amount, cap)
}

denied if {
	some o in outflows
	hours := policy.hours[o.token]
	not bank_window_open(hours)
}

# A recipient meta-address that maps to no party.
denied if {
	http.path == "/intent"
	body.kind in {"rd-transfer", "bond-transfer", "rd-mint", "bond-issue"}
	not node_of_meta(body.to.metaAddress)
}

denied if {
	some t, _ in daily_request
	not daily_used[t]
}

denied if {
	some t, n in daily_request
	daily_used[t] + n > policy.daily_limit[t]
}

# The value this request moves out of a stealth address, per token with a daily_limit.
daily_request[o.token] := to_number(o.amount) if {
	http.path == "/intent"
	body.kind in {"rd-transfer", "bond-transfer", "dvp-leg"}
	some o in outflows
	policy.daily_limit[o.token]
}

daily_used[t] := to_number(data.bank.stealth_usage.today[t]) if {
	some t, _ in daily_request
	regex.match(`^(0|[1-9][0-9]{0,30})$`, data.bank.stealth_usage.today[t])
}

amount_within(a, cap) if {
	is_string(a)
	regex.match(`^[1-9][0-9]{0,30}$`, a)
	to_number(a) <= cap
}

# BI's clock values as data (not its open() function), so this bundle builds alone. Holidays are BI's.
bank_window_open(h) if {
	data.bi.clock.weekday in h.days
	h.open <= data.bi.clock.hhmm
	data.bi.clock.hhmm < h.close
}
