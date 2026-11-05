# Identities are compared by their node part (the text after "@"): a bank is its node, and one node
# submits from many identities (bankA@node2, stress-n2-00@node2, investor2@node2). An id must be exactly
# name@node with both parts non-empty (Paladin may split on the first "@", so "x@a@b" is ambiguous); any other
# id has no node, so it matches nothing. Each bundle has its own copy so the bank bundle builds alone.
package bank.ident

node_of(id) := n if {
	[name, n] := split(id, "@")
	name != ""
	n != ""
}

# True when the id's node is the node of one of BI's participants.
participant(id) if node_of(id) in participant_nodes

# Nodes of BI's participants.
participant_nodes contains node_of(p) if some p in data.bi.config.participants
