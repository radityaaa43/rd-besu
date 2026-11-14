# BI rules for target `stealth` (S17): the stealth gateway st-gw-<N>'s door :8550 -> the party's signer (context_extensions {target: "stealth", node}).
# Lensa (relay and read model, no keys) may call only these routes, and only with its own mTLS client certificate:
#   reads   GET /health, /holdings, /history, /meta-address; GET /ledger?kind=rd|bond (exact query; the signer serves it on BI only);
#           GET /outflow?since=<unix seconds> (today's outflow for the policy usage view; the bank side enforces daily_limit with it)
#   writes  POST /intent, /dvp/offer, /dvp/bid, /dvp/escrow, /dvp/settle, /dvp/cancel, checked against BI's Stealth document
#           (data.bi.config.policy.stealth: max_per_tx, max_mint_per_tx, hours, holidays, frozen; the same schema as zeto/noto/fabricx)
#           from the request body Envoy sends (with_request_body):
#     rd-mint            BI's gateway only, from BI, to a bank; RD mint cap; RD open; recipient not frozen
#     bond-issue         BI's gateway only, from BI, to BI itself (DFABI is issued to BI and reaches banks by award); DFABI mint cap
#     rd-/bond-transfer  a bank's gateway, from this party, to another bank; per-tx cap of the token; open; neither frozen
#     dvp-leg            from this party; leg bond: DFABI cap (mint cap at BI's gateway: the award), leg rd: RD cap; token open
#     /dvp/offer         seller side (a bank, or BI for an award), buyer = another bank; DFABI cap (mint cap at BI); both open; neither frozen
#     /dvp/bid           buyer side (a bank), seller = another party; price within the RD cap; both open; neither frozen
#     /dvp/escrow        BI's gateway only; both tokens open; well-formed amounts (each leg is checked at offer/bid/dvp-leg)
#     /dvp/settle|cancel any gateway: moves only what the escrow terms fixed (anyone may call on chain); escrow an address
# A body names a party by its stealth meta-address; data.bi.config.stealth_meta maps it (lowercase) to the node. Amounts are positive
# decimal strings without leading zeros. No Stealth document = every write denied (reads stay). /cert and /escrow-certs are never here.
# The caller is attributes.source.principal ("CN=<name>", our client certs carry no SAN); the cert's CA is the party's own.
# The bank bundle has its own rules (bank.platform.stealth: counterparties, the bank's own caps and hours); gw needs both to allow.
package bi.platform.stealth

import data.bi.clock
import data.bi.ident

http := input.attributes.request.http

caller := input.attributes.source.principal

own := input.attributes.contextExtensions.node

body := input.parsed_body

policy := data.bi.config.policy.stealth

lensa := {"CN=lensa", "CN=lensa-bi", "CN=lensa-bank-a", "CN=lensa-bank-b", "CN=lensa-bank-c"}

reads := {
	["GET", "/holdings"], ["GET", "/history"], ["GET", "/health"], ["GET", "/meta-address"],
	["GET", "/ledger?kind=rd"], ["GET", "/ledger?kind=bond"],
}

party := {"node1": "BI", "node2": "A", "node3": "B", "node4": "C"}

token_of := {"rd-transfer": "RD", "bond-transfer": "DFABI", "rd-mint": "RD", "bond-issue": "DFABI"}

default allow := false

allow if {
	caller in lensa
	permitted
}

permitted if [http.method, http.path] in reads

permitted if {
	http.method == "GET"
	regex.match(`^/outflow\?since=(0|[1-9][0-9]{0,11})$`, http.path)
}

post(path) if {
	http.method == "POST"
	http.path == path
}

# --- issuance (BI's gateway) ---
permitted if {
	post("/intent")
	body.kind == "rd-mint"
	issuer
	body.from == "BI"
	to := node_of_meta(body.to.metaAddress)
	bank(to)
	clock.token_open("stealth", "RD")
	frozen_ok({to})
	amount_ok(body.amount, policy.max_mint_per_tx.RD)
}

permitted if {
	post("/intent")
	body.kind == "bond-issue"
	issuer
	body.from == "BI"
	node_of_meta(body.to.metaAddress) == own
	clock.token_open("stealth", "DFABI")
	amount_ok(body.amount, policy.max_mint_per_tx.DFABI)
}

# --- transfers between banks ---
permitted if {
	post("/intent")
	body.kind in {"rd-transfer", "bond-transfer"}
	bank(own)
	body.from == party[own]
	to := node_of_meta(body.to.metaAddress)
	bank(to)
	to != own
	token := token_of[body.kind]
	clock.token_open("stealth", token)
	frozen_ok({own, to})
	amount_ok(body.amount, policy.max_per_tx[token])
}

# --- DvP and award ---
permitted if {
	post("/intent")
	body.kind == "dvp-leg"
	body.from == party[own]
	is_string(body.escrow)
	leg_ok(body.leg, body.amount)
	frozen_ok({own})
}

leg_ok("bond", amount) if {
	clock.token_open("stealth", "DFABI")
	amount_ok(amount, dfabi_cap)
}

leg_ok("rd", amount) if {
	clock.token_open("stealth", "RD")
	amount_ok(amount, policy.max_per_tx.RD)
}

permitted if {
	post("/dvp/offer")
	buyer := node_of_meta(body.buyerMeta)
	bank(buyer)
	buyer != own
	both_open
	frozen_ok({own, buyer})
	amount_ok(body.amount, dfabi_cap)
}

permitted if {
	post("/dvp/bid")
	bank(own)
	seller := node_of_meta(body.sellerMeta)
	seller != own
	both_open
	frozen_ok({own, seller})
	amount_ok(body.price, policy.max_per_tx.RD)
}

permitted if {
	post("/dvp/escrow")
	issuer
	both_open
	amount_ok(body.bondAmount, max([policy.max_per_tx.DFABI, policy.max_mint_per_tx.DFABI]))
	amount_ok(body.rdAmount, policy.max_per_tx.RD)
}

permitted if {
	some p in ["/dvp/settle", "/dvp/cancel"]
	post(p)
	regex.match(`^0x[0-9a-fA-F]{1,40}$`, body.escrow)
	policy # a Stealth document exists
}

# The DFABI an offer or a bond leg may move: the award (BI's gateway) mints, a bank transfers.
dfabi_cap := policy.max_mint_per_tx.DFABI if issuer

dfabi_cap := policy.max_per_tx.DFABI if not issuer

issuer if data.bi.config.nodes[own].issuer == true

bank(n) if {
	data.bi.config.nodes[n]
	not data.bi.config.nodes[n].issuer
}

node_of_meta(m) := data.bi.config.stealth_meta[lower(m)] if is_string(m)

both_open if {
	clock.token_open("stealth", "RD")
	clock.token_open("stealth", "DFABI")
}

# None of the nodes is frozen in the Stealth document. No document: frozen_nodes is undefined, so this fails.
frozen_ok(nodes) if count(ident.frozen_nodes("stealth") & nodes) == 0

# A positive decimal string without leading zeros, at most the cap (and within uint256 as the signer parses it).
amount_ok(a, cap) if {
	is_string(a)
	regex.match(`^[1-9][0-9]{0,30}$`, a)
	to_number(a) <= cap
}
