# BI rules for Zeto txs (shapes from paladin-sdk domains/zeto.js). Recipients are lookups such as
# "bankB@node3". Mint, transfers and DvP locks each have a per-tx cap on the sum of their outputs.
# Mint, transfer and createLock also need the token's operating hours open (a DvP lock needs both tokens open)
# and no frozen recipient. A frozen bank's own gateway also stops its transfers and locks. Identities are
# compared by node (bi.ident), so freezing bankC@node4 freezes every identity on node4.
# Finishing or unwinding a DvP (spendLock, delegateLock, cancelLock) is never blocked.
package bi.zeto

import data.bi.clock
import data.bi.ident

tx := input.parsed_body.params[0]

node := data.bi.config.nodes[input.attributes.contextExtensions.node]

token := data.bi.config.zeto.contracts[lower(tx.to)]

default allow := false

allow if {
	tx.function == "mint"
	node.issuer
	clock.token_open(token)
	outputs_ok(tx.data.mints)
	frozen_ok(tx.data.mints)
	within_limit(tx.data.mints, data.bi.config.zeto.max_mint_per_tx[token])
}

allow if {
	tx.function == "transfer"
	clock.token_open(token)
	outputs_ok(tx.data.transfers)
	frozen_ok(tx.data.transfers)
	within_limit(tx.data.transfers, data.bi.config.zeto.max_per_tx[token])
}

allow if {
	tx.function == "createLock"
	clock.token_open("RD")
	clock.token_open("DFABI")
	outputs_ok(tx.data.recipients)
	frozen_ok(tx.data.recipients)
	within_limit(tx.data.recipients, data.bi.config.zeto.max_per_tx[token])
}

# Finishing or unwinding a DvP is never blocked by hours. The amounts were checked when the lock was created.
allow if {
	token
	tx.function in {"spendLock", "delegateLock", "cancelLock"}
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
	count(ident.frozen_nodes & ({ident.node_of(o.to) | some o in outs} | {own})) == 0
}

within_limit(outs, cap) if sum([to_number(o.amount) | some o in outs]) <= cap
