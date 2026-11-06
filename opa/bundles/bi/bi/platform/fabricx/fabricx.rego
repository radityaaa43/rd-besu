# BI rules for Fabric-X (Panurus tokens in namespace rd_dfabi_v2), checked at every party's gateway fx-gw-N. Envoy tags
# the door {target: "fabricx", node: "node1".."node4"}; the body is one JSON request to that party's fxapi
# (rdbi-driver serve, fabric-x/panurus-itest/rdbi/cmd/driver/serve.go), which only serves its own node.
# Every value comes from the Fabric-X document (data.bi.config.policy.fabricx); the other platforms' do not matter.
#   issue, award      issuer node only; mint cap (award: DFABI mint cap, RD transfer cap), hours, recipient not frozen
#   transfer, swap,   from = this party; transfer cap per leg, hours (a swap needs both tokens open), neither party frozen
#   redeem
#   precheck          the counterparty leg of a swap/award, at the gateway of the party that gives it (to = this party);
#                     same caps, hours and frozen check as the initiator's side
#   reads             balance, history, records, finality, report, usage: own node only (fxapi serves nothing else)
# Anything else, a non-POST, an unknown token, node or op, a malformed amount: denied (default false).
package bi.platform.fabricx

import data.bi.clock
import data.bi.ident

body := input.parsed_body

own := input.attributes.contextExtensions.node

# Fabric-X node names of the parties (Service and certificate names), and token types as BI's documents name them.
# Kept here, not in bi/config/data.json: the bank bundle has its own copy and must build alone.
fx_node := {"node1": "issuer", "node2": "bank2", "node3": "bank3", "node4": "bank4"}

party_node := {fx: n | some n, fx in fx_node}

tokens := {"RD": "RD", "DFABI-2027A": "DFABI"}

policy := data.bi.config.policy.fabricx

reads := {"balance", "history", "records", "finality", "report", "usage"}

default allow := false

allow if {
	post
	body.op in reads
}

allow if {
	post
	body.op == "issue"
	data.bi.config.nodes[own].issuer
	bank(body.to)
	token := tokens[body.type]
	clock.token_open("fabricx", token)
	frozen_ok({party_node[body.to]})
	amount_ok(body.amount, policy.max_mint_per_tx[token])
}

allow if {
	post
	body.op == "award"
	data.bi.config.nodes[own].issuer
	id_ok
	bank(body.to)
	both_open
	frozen_ok({party_node[body.to]})
	amount_ok(body.dfabi, policy.max_mint_per_tx.DFABI)
	amount_ok(body.rd, policy.max_per_tx.RD)
}

allow if {
	post
	body.op == "transfer"
	body.from == fx_node[own]
	to := party_node[body.to]
	to != own
	token := tokens[body.type]
	clock.token_open("fabricx", token)
	frozen_ok({own, to})
	amount_ok(body.amount, policy.max_per_tx[token])
}

allow if {
	post
	body.op == "swap"
	body.from == fx_node[own]
	legs_ok(body.from, body.to)
}

allow if {
	post
	body.op == "redeem"
	body.from == fx_node[own]
	token := tokens[body.type]
	clock.token_open("fabricx", token)
	frozen_ok({own})
	amount_ok(body.amount, policy.max_per_tx[token])
}

# Swap: the buyer gives `get`; at the buyer's gateway (to = this party) with the same BI checks as the seller's side.
allow if {
	post
	body.op == "precheck"
	body.kind == "swap"
	body.to == fx_node[own]
	legs_ok(body.from, body.to)
}

# Award: BI gives DFABI (minted), the bank pays RD.
allow if {
	post
	body.op == "precheck"
	body.kind == "award"
	body.from == "issuer"
	body.to == fx_node[own]
	bank(body.to)
	body.give.type == "DFABI-2027A"
	body.get.type == "RD"
	id_ok
	both_open
	frozen_ok({own})
	amount_ok(body.give.amount, policy.max_mint_per_tx.DFABI)
	amount_ok(body.get.amount, policy.max_per_tx.RD)
}

post if input.attributes.request.http.method == "POST"

bank(fx) if party_node[fx] != "node1"

# The swap id ties the precheck to the swap in both gateways' decision logs.
id_ok if regex.match(`^[A-Za-z0-9._:-]{1,64}$`, body.id)

both_open if {
	clock.token_open("fabricx", "RD")
	clock.token_open("fabricx", "DFABI")
}

# Two different banks, two different tokens, both open, neither party frozen, each leg within its token's cap.
legs_ok(from, to) if {
	f := party_node[from]
	t := party_node[to]
	f != t
	bank(from)
	bank(to)
	id_ok
	tokens[body.give.type] != tokens[body.get.type]
	both_open
	frozen_ok({f, t})
	amount_ok(body.give.amount, policy.max_per_tx[tokens[body.give.type]])
	amount_ok(body.get.amount, policy.max_per_tx[tokens[body.get.type]])
}

# None of the nodes is frozen in the Fabric-X document. No document: frozen_nodes is undefined, so this fails.
frozen_ok(nodes) if count(ident.frozen_nodes("fabricx") & nodes) == 0

# A positive uint64 as a decimal string (fxapi parses it the same way), at most the cap.
amount_ok(a, cap) if {
	regex.match(`^[1-9][0-9]{0,19}$`, a)
	to_number(a) <= 18446744073709551615
	to_number(a) <= cap
}
