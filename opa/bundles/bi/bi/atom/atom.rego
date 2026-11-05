# BI rules for public txs: only the DvP Atom ones (Zeto AtomFactory, Noto RestrictedAtomFactory).
# An Atom's address is known only on chain, so execute/cancel go to any address except a factory.
package bi.atom

tx := input.parsed_body.params[0]

factories contains lower(a) if some a in data.bi.config.atom.factories

default allow := false

allow if {
	lower(tx.to) in factories
	tx.function == "create"
}

allow if {
	not lower(tx.to) in factories
	tx.function in {"execute", "cancel"}
}
