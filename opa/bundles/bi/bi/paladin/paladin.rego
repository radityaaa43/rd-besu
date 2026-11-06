# BI rules for a bank's Paladin RPC. Reads pass from an explicit list; writes pass only in the shapes below.
# Paladin's SDK never batches, so a JSON-RPC array has no method and is denied.
package bi.paladin

import data.bi.ident

rpc := input.parsed_body

tx := rpc.params[0]

node := data.bi.config.nodes[input.attributes.contextExtensions.node]

# The SDK sends private Zeto and Noto writes without `domain` (Paladin resolves it from `to`); only deploys carry it.
# So a tx is Zeto by its domain or by a contract BI knows. Undefined `to` makes the second rule undefined, not an error.
is_zeto if tx.domain == "zeto"

is_zeto if data.bi.config.zeto.contracts[lower(tx.to)]

# Noto the same way. Never both: a tx is Zeto first.
is_noto if {
	not is_zeto
	tx.domain == "noto"
}

is_noto if {
	not is_zeto
	data.bi.config.noto.contracts[lower(tx.to)]
}

default allow := false

allow if rpc.method in data.bi.config.paladin.read_methods

allow if {
	rpc.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	tx.type == "private"
	is_zeto
	ident.node_of(tx.from) == input.attributes.contextExtensions.node
	data.bi.zeto.allow
}

allow if {
	rpc.method == "ptx_sendTransaction"
	tx.type == "public"
	data.bi.atom.allow
}

allow if {
	rpc.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	tx.type == "private"
	is_noto
	ident.node_of(tx.from) == input.attributes.contextExtensions.node
	data.bi.noto.allow
}

# Pente txs only into the groups BI knows (the Noto hooks' cash and issuer-custodian groups).
# Group membership itself is enforced by Paladin.
allow if {
	rpc.method == "pgroup_sendTransaction"
	tx.domain == "pente"
	tx.group in data.bi.config.pente.groups
}

# Deploying a Noto platform (contracts and groups data.json does not know yet): issuer node only, see bi.notosetup.
allow if data.bi.notosetup.allow

# A bank reports its Zeto outputs to BI only over its own {bank, BI} group.
allow if {
	rpc.method == "pgroup_sendMessage"
	tx.domain == "pente"
	tx.topic == "zeto-report-v1"
	tx.group == node.report_group
}
