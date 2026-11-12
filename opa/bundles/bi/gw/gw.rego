# Entrypoint for the OPA-Envoy plugin (path gw/allow). Envoy tags each listener with
# context_extensions {target, node}: target picks the door, node says whose gateway it is. `target` comes only from there,
# never from the request body or headers, which a client controls.
# A Paladin request passes only when both BI's rules and the bank's own rules allow it.
# Any other target is a platform (zeto/noto are Paladin; a fabricx or iroha3 gateway sets its own id) and passes only when
# BOTH its packages allow: data.bi.platform.<target>.allow and data.bank.platform.<target>.allow (besu/opa/README.md,
# "Adding a platform"). A target with no package leaves the lookup undefined, so it is denied.
# BI's Noto balance controls (bi.balance) come last: they ask node1, so the cheaper checks run first.
package gw

ext := input.attributes.contextExtensions

# METADATA
# entrypoint: true
default allow := false

allow if {
	ext.target == "paladin"
	data.bi.config.nodes[ext.node]
	data.bi.caller.ok("paladin", ext.node)
	data.bi.paladin.allow
	data.bank.paladin.allow
	data.bi.balance.allow
}

allow if {
	ext.target == "besu"
	data.bi.besu.allow
}

allow if {
	not ext.target in {"paladin", "besu"}
	data.bi.caller.ok(ext.target, ext.node)
	data.bi.platform[ext.target].allow
	data.bank.platform[ext.target].allow
}
