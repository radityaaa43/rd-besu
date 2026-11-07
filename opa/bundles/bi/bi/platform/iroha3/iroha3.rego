# BI rules for Iroha 3 (RD and DFABI in dataspace 1), checked at every party's gateway ir-gw-N. Envoy tags the door
# {target: "iroha3", node: "node1".."node4"} and fronts that party's Torii. A signed Norito transaction arrives as
# input.attributes.request.http.rawBody (Envoy pack_as_bytes, base64); the txdec sidecar (rd-dfabi decode-tx serve, the
# same pod) turns it into JSON (apps/rd-dfabi/schema/decode-tx.response.json). Torii verifies the signature; the rules
# read what the transaction says. The decoder's answer is only read here, never returned: the result of `allow` is a boolean.
# Structural values come from data.bi.config.iroha3 (dataspace, assets: token -> asset definition id, accounts: id -> node);
# every limit from the Iroha 3 document (data.bi.config.policy.iroha3). The other platforms' documents do not matter.
#   mint              BI's node only; recipient not frozen; max_mint_per_tx, hours
#   burn              BI's node only, from its own holding; max_mint_per_tx
#   transfer          from = authority = this party; max_per_tx, hours, neither party frozen
#   DvP               seller's gateway (authority = delivery.from = payment.to): both legs max_per_tx, both tokens open,
#                     neither party frozen. all_or_nothing only
#   POST /gw/intent   buyer's registration of that DvP at the buyer's gateway (payment.from = this party), same checks
#   consent grant     CanExecuteSettlement at the buyer's gateway, only for an intent the store holds as active for the signer
#   reads             the explicit list below
# An asset passes only with the exact definition id of its token in data AND balance scope dataspace:<n>. Anything else
# (unknown kind, ContractCall/IVM, JSON body, batch, other grants, other routes), a decoder answer that is not a clean
# 200, a malformed quantity: denied (default false).
package bi.platform.iroha3

import data.bi.clock
import data.bi.ident

http_in := input.attributes.request.http

own := input.attributes.contextExtensions.node

cfg := data.bi.config.iroha3

policy := data.bi.config.policy.iroha3

# The txdec sidecar, loopback in the gateway pod: POST /decode, POST /intent/decode, POST /intent/lookup (BI) and
# POST /usage (bank). Not reachable from outside: Envoy routes only /gw/* to it, after this check.
sidecar := "http://127.0.0.1:8090"

# Path without the query string (tx status takes ?hash=).
path := split(http_in.path, "?")[0]

default allow := false

# --- reads: GET or POST on an exact path, nothing else

read_get := {
	"/health",
	"/status",
	"/v1/nexus/lifecycle",
	"/v1/node/capabilities",
	"/v1/pipeline/transactions/status",
}

read_post := {
	"/v1/fees/quote",
	"/v1/query",
	"/v1/pipeline/transactions/details",
	"/gw/usage",
}

allow if {
	http_in.method == "GET"
	path in read_get
}

# GET /v1/accounts/{id}/transactions (signed by the Torii canonical-signature headers; Torii checks them).
allow if {
	http_in.method == "GET"
	regex.match(`^/v1/accounts/[^/]+/transactions$`, path)
}

allow if {
	http_in.method == "POST"
	path in read_post
}

# --- transactions: POST /v1/pipeline/transactions, application/x-norito, exactly one instruction

allow if {
	tx_ok
	i := tx.instructions[0]
	i.kind == "mint"
	issuer
	own_account(tx.authority)
	token := movement_token(i)
	clock.token_open("iroha3", token)
	frozen_ok({node_of(i.to)})
	amount_ok(i.quantity, i.scale, policy.max_mint_per_tx[token])
}

allow if {
	tx_ok
	i := tx.instructions[0]
	i.kind == "burn"
	issuer
	own_account(tx.authority)
	i.from == tx.authority
	token := movement_token(i)
	amount_ok(i.quantity, i.scale, policy.max_mint_per_tx[token])
}

allow if {
	tx_ok
	i := tx.instructions[0]
	i.kind == "transfer"
	own_account(tx.authority)
	i.from == tx.authority
	to := node_of(i.to)
	to != own
	token := movement_token(i)
	clock.token_open("iroha3", token)
	frozen_ok({own, to})
	amount_ok(i.quantity, i.scale, policy.max_per_tx[token])
}

# DvP at the seller's gateway.
allow if {
	tx_ok
	i := tx.instructions[0]
	i.kind == "dvp"
	own_account(tx.authority)
	i.delivery.from == tx.authority
	dvp_ok(i)
}

# The consent: the buyer's grant of CanExecuteSettlement. Only for an intent registered at this gateway, still active,
# registered for this signer. The store (not this rule) marks it consumed when the consent goes through.
allow if {
	tx_ok
	i := tx.instructions[0]
	i.kind == "grant"
	i.grant_kind == "permission"
	i.permission == "CanExecuteSettlement"
	c := i.consent
	own_account(tx.authority)
	frozen_ok({own})
	intent := intent_of(c.intent_hash)
	intent.status == "active"
	intent.intent_hash == c.intent_hash
	intent.buyer == tx.authority
}

# --- DvP intent registration (a write into the gateway's store): only the buyer's own gateway, same checks as the DvP

allow if {
	http_in.method == "POST"
	path == "/gw/intent"
	i := reg.instruction
	i.kind == "dvp"
	cfg.accounts[i.payment.from] == own
	dvp_ok(i)
}

# --- the sidecar's answers (kept out of the result)

ct := object.get(http_in.headers, "content-type", "")

# The decoder is asked for a Norito body only: JSON bodies are refused here, before and after decoding.
tx := resp.body if {
	http_in.method == "POST"
	path == "/v1/pipeline/transactions"
	ct == "application/x-norito"
	resp := http.send(sidecar_req("/decode", {"b64": http_in.rawBody, "ct": ct}))
	resp.status_code == 200
	resp.body.ok == true
}

# {"ok": true, "instruction": <one Instr, kind "dvp">}
reg := resp.body if {
	http_in.method == "POST"
	path == "/gw/intent"
	resp := http.send(sidecar_req("/intent/decode", {"b64": http_in.rawBody, "ct": ct}))
	resp.status_code == 200
	resp.body.ok == true
}

# {"status": active|expired|consumed|unknown, "buyer": I105, "intent_hash": "hash:..", "expires_at": ms}
intent_of(h) := resp.body if {
	resp := http.send(sidecar_req("/intent/lookup", {"intent_hash": h}))
	resp.status_code == 200
	resp.body.status in {"active", "expired", "consumed", "unknown"}
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

# A signed transaction by one key, one instruction, no executable but instructions.
tx_ok if {
	tx.encoding == "norito"
	tx.executable == "instructions"
	tx.signature_ok == true
	tx.has_multisig == false
	count(tx.instructions) == 1
}

# --- helpers

issuer if data.bi.config.nodes[own].issuer == true

own_account(a) if cfg.accounts[a] == own

node_of(a) := cfg.accounts[a]

# The token of an asset movement: the exact definition id in data, in balance scope dataspace:<n> (not global, not another
# dataspace). A look-alike definition (same name, other id) has no token.
movement_token(i) := token if {
	i.scope == sprintf("dataspace:%d", [cfg.dataspace])
	i.dataspace == cfg.dataspace
	some token, def in cfg.assets
	def == i.asset_definition
}

# A DvP leg has no balance scope in the transaction (the chain picks the bucket): the definition id is checked only.
leg_token(l) := token if {
	some token, def in cfg.assets
	def == l.asset_definition
}

# Seller and buyer are two parties, delivery and payment two tokens, each side of both legs the same party, atomic,
# both tokens open, neither party frozen, each leg within its token's cap.
dvp_ok(d) if {
	d.atomicity == "all_or_nothing"
	seller := d.delivery.from
	buyer := d.delivery.to
	d.payment.to == seller
	d.payment.from == buyer
	s := node_of(seller)
	b := node_of(buyer)
	s != b
	dt := leg_token(d.delivery)
	pt := leg_token(d.payment)
	dt != pt
	clock.token_open("iroha3", dt)
	clock.token_open("iroha3", pt)
	frozen_ok({s, b})
	amount_ok(d.delivery.quantity, d.delivery.scale, policy.max_per_tx[dt])
	amount_ok(d.payment.quantity, d.payment.scale, policy.max_per_tx[pt])
}

# None of the nodes is frozen in the Iroha 3 document. No document: frozen_nodes is undefined, so this fails.
frozen_ok(nodes) if count(ident.frozen_nodes("iroha3") & nodes) == 0

# A positive whole quantity as a decimal string with scale 0, at most the cap.
amount_ok(q, scale, cap) if {
	scale == 0
	regex.match(`^[1-9][0-9]{0,15}$`, q)
	to_number(q) <= cap
}
