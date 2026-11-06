# BI rules for Noto txs (shapes from paladin-sdk domains/noto.js and bond/src/lib/outright.ts). Its own per-token
# policy (data.bi.config.policy.noto), independent of Zeto's: caps, hours, holidays, frozen.
# Mint and transfer send {to, amount}; burn sends {amount} (issuer node only); a DvP leg is lock {amount} then prepareUnlock {recipients}, so the lock is
# capped and the recipients are checked at prepareUnlock. Lock and prepareUnlock need both tokens open.
# Finishing or unwinding a DvP is never blocked: delegateLock, and a prepareUnlock that only returns the lock to
# its owner (the rollback in outright.ts).
package bi.noto

import data.bi.clock
import data.bi.ident

tx := input.parsed_body.params[0]

node := data.bi.config.nodes[input.attributes.contextExtensions.node]

token := data.bi.config.noto.contracts[lower(tx.to)]

caps := data.bi.config.policy.noto

single := [{"to": tx.data.to, "amount": tx.data.amount}]

default allow := false

allow if {
	tx.function == "mint"
	node.issuer
	clock.token_open("noto", token)
	outputs_ok(single)
	frozen_ok(single)
	within_limit(single, caps.max_mint_per_tx[token])
}

allow if {
	tx.function == "transfer"
	clock.token_open("noto", token)
	outputs_ok(single)
	frozen_ok(single)
	within_limit(single, caps.max_per_tx[token])
}

# Burn: the issuer node destroys its own holdings (tx.from is checked against the node in bi.paladin). Same cap as mint.
allow if {
	tx.function == "burn"
	node.issuer
	token
	clock.token_open("noto", token)
	to_number(tx.data.amount) > 0
	to_number(tx.data.amount) <= caps.max_mint_per_tx[token]
}

allow if {
	tx.function == "lock"
	clock.token_open("noto", "RD")
	clock.token_open("noto", "DFABI")
	to_number(tx.data.amount) > 0
	frozen_ok([])
	to_number(tx.data.amount) <= caps.max_per_tx[token]
}

allow if {
	tx.function == "prepareUnlock"
	not to_self
	clock.token_open("noto", "RD")
	clock.token_open("noto", "DFABI")
	outputs_ok(tx.data.recipients)
	frozen_ok(tx.data.recipients)
	within_limit(tx.data.recipients, caps.max_per_tx[token])
}

allow if {
	token
	tx.function == "prepareUnlock"
	to_self
}

allow if {
	token
	tx.function == "delegateLock"
}

# Every recipient is the sender itself: the lock goes back to its owner.
to_self if {
	count(tx.data.recipients) > 0
	every o in tx.data.recipients {
		o.to == tx.from
	}
}

outputs_ok(outs) if {
	token
	count(outs) > 0
	every o in outs {
		ident.participant(o.to)
		to_number(o.amount) > 0
	}
}

# No recipient's node is frozen, and neither is the requesting node.
frozen_ok(outs) if {
	own := input.attributes.contextExtensions.node
	count(ident.frozen_nodes("noto") & ({ident.node_of(o.to) | some o in outs} | {own})) == 0
}

within_limit(outs, cap) if sum([to_number(o.amount) | some o in outs]) <= cap
