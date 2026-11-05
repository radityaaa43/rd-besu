# Entrypoint for the OPA-Envoy plugin (path gw/allow). Envoy tags each listener with
# context_extensions {target, node}: target picks the door (paladin or besu), node says whose gateway it is.
# A Paladin request passes only when both BI's rules and the bank's own rules allow it.
package gw

ext := input.attributes.contextExtensions

# METADATA
# entrypoint: true
default allow := false

allow if {
	ext.target == "paladin"
	data.bi.config.nodes[ext.node]
	data.bi.paladin.allow
	data.bank.paladin.allow
}

allow if {
	ext.target == "besu"
	data.bi.besu.allow
}
