# BI rules for a bank's Paladin RPC. Reads pass from an explicit list; writes pass only in the shapes below.
# Paladin's SDK never batches, so a JSON-RPC array has no method and is denied.
package bi.paladin

import data.bi.ident

rpc := input.parsed_body

tx := rpc.params[0]

node := data.bi.config.nodes[input.attributes.contextExtensions.node]

default allow := false

allow if rpc.method in data.bi.config.paladin.read_methods

allow if {
	rpc.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	tx.type == "private"
	tx.domain == "zeto"
	ident.node_of(tx.from) == input.attributes.contextExtensions.node
	data.bi.zeto.allow
}

allow if {
	rpc.method == "ptx_sendTransaction"
	tx.type == "public"
	data.bi.atom.allow
}

# Noto and Pente are not scoped yet: they pass so the gateway does not break their flows.
allow if {
	rpc.method in {"ptx_sendTransaction", "ptx_prepareTransaction"}
	tx.type == "private"
	tx.domain in {"noto", "pente"}
}

allow if rpc.method == "pgroup_sendTransaction"

# A bank reports its Zeto outputs to BI only over its own {bank, BI} group.
allow if {
	rpc.method == "pgroup_sendMessage"
	tx.domain == "pente"
	tx.topic == "zeto-report-v1"
	tx.group == node.report_group
}
