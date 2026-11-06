# BI rules for deploying a Noto platform (bond/src/index.ts, run by Lensa's bootstrap-noto through the gateways). Only the
# deploy shapes, only on the issuer node (node1). Nothing else of the bootstrap passes here: once the new contracts exist,
# mint/lock/... go to addresses and groups that data.json does not know yet and stay denied until it is updated and BI republished.
package bi.notosetup

import data.bi.ident

rpc := input.parsed_body

tx := rpc.params[0]

ext := input.attributes.contextExtensions

issuer if data.bi.config.nodes[ext.node].issuer

own(id) if ident.node_of(id) == ext.node

deploy if object.get(tx, "to", null) == null

default allow := false

# Pente privacy group (cash group, issuer+custodian group): every member on the issuer node.
allow if {
	issuer
	rpc.method == "pgroup_createGroup"
	tx.domain == "pente"
	count(tx.members) > 0
	every m in tx.members {
		own(m)
	}
}

# Contract deploy inside a Pente group (ERC20Tracker, BondTracker): no `to`, constructor + bytecode.
allow if {
	issuer
	rpc.method == "pgroup_sendTransaction"
	tx.domain == "pente"
	deploy
	tx.function.type == "constructor"
	tx.bytecode != ""
	own(tx.from)
}

# Noto deploy (cash, bond): hooks mode with BI's own notary.
allow if {
	issuer
	rpc.method == "ptx_sendTransaction"
	tx.type == "private"
	tx.domain == "noto"
	tx.function == ""
	is_array(tx.abi)
	tx.data.notaryMode == "hooks"
	own(tx.from)
	own(tx.data.notary)
}

# Public deploy (BondTrackerPublic, RestrictedAtomFactory).
allow if {
	issuer
	rpc.method == "ptx_sendTransaction"
	tx.type == "public"
	tx.function == ""
	deploy
	is_array(tx.abi)
	tx.bytecode != ""
	own(tx.from)
}
