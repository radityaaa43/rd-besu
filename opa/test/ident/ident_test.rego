# bi.ident and bank.ident carry separate copies of node_of/participant (separate bundle owners cannot share
# code, Ruling 11). This pins both to the same answers so one cannot drift from the other.
package ident_test

import data.bank.ident as bank
import data.bi.ident as bi

# valid ids, no "@", two "@", empty sides, case, empty string
ids := [
	"bankA@node2", "stress-n2-00@node2", "investor2@node3", "x@a",
	"bankA", "node2", "",
	"x@a@b", "@@", "a@@b",
	"@node2", "bankA@", "@",
	"bankA@Node2", "BANKA@node2", "bankA@NODE2",
]

participants := ["bankA@node2", "bankB@node3", "x@Node4"]

bi_node(id) := n if n := bi.node_of(id)

bi_node(id) := "<undefined>" if not bi.node_of(id)

bank_node(id) := n if n := bank.node_of(id)

bank_node(id) := "<undefined>" if not bank.node_of(id)

test_node_of_agrees if {
	every id in ids {
		bi_node(id) == bank_node(id)
	}
}

test_node_of_table if {
	bi_node("bankA@node2") == "node2"
	bi_node("bankA") == "<undefined>"
	bi_node("x@a@b") == "<undefined>"
	bi_node("@node2") == "<undefined>"
	bi_node("bankA@") == "<undefined>"
	bi_node("bankA@Node2") == "Node2"
}

bi_part(id) if bi.participant(id) with data.bi.config.participants as participants

bi_part(id) := false if not bi.participant(id) with data.bi.config.participants as participants

bank_part(id) if bank.participant(id) with data.bi.config.participants as participants

bank_part(id) := false if not bank.participant(id) with data.bi.config.participants as participants

test_participant_agrees if {
	every id in ids {
		bi_part(id) == bank_part(id)
	}
}

test_participant_table if {
	bi.participant("stress-n2-00@node2") with data.bi.config.participants as participants
	not bi.participant("bankA@node9") with data.bi.config.participants as participants
	not bi.participant("bankA@Node2") with data.bi.config.participants as participants
	not bi.participant("x@a@node2") with data.bi.config.participants as participants
}

# Frozen nodes come from the platform's own document.
test_frozen_nodes_per_platform if {
	cfg := {"policy": {"zeto": {"frozen": ["bankC@node4"]}, "noto": {"frozen": ["bankA@node2", "x@node3"]}}}
	bi.frozen_nodes("zeto") == {"node4"} with data.bi.config as cfg
	bi.frozen_nodes("noto") == {"node2", "node3"} with data.bi.config as cfg
	not bi.frozen_nodes("pente") with data.bi.config as cfg
}
