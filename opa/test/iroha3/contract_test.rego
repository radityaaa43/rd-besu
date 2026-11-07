# Contract sync: the golden decoder outputs are shaped exactly as the decoder's schema, and every field the Iroha 3 rules
# read is a property of that schema and present in a golden output. If the decoder renames or drops a field, this fails
# before a gateway silently denies (or, worse, stops checking) a transaction.
package iroha3_contract_test

import data.iroha3_golden as g
import data.iroha3_schema as s

fixtures := {
	"transfer_rd": g.transfer_rd,
	"transfer_dfabi": g.transfer_dfabi,
	"mint_rd": g.mint_rd,
	"burn_rd": g.burn_rd,
	"dvp_settlement": g.dvp_settlement,
	"dvp_consent": g.dvp_consent,
	"unknown_kind": g.unknown_kind,
	"decode_error": {"ok": false, "error": {"code": "non_canonical", "message": "x"}},
}

test_golden_outputs_match_the_schema if {
	every f in fixtures {
		json.match_schema(f, s.decode_tx)[0] == true
	}
}

# a registration answer carries the same DvP instruction
test_registration_dvp_matches_the_schema if {
	json.match_schema(g.tx(g.a_acct, [g.dvp_registration.instruction]), s.decode_tx)[0] == true
}

# the schema really rejects a wrong shape (the check above would otherwise pass vacuously)
test_schema_rejects_a_wrong_shape if {
	json.match_schema(object.remove(g.transfer_rd, ["executable"]), s.decode_tx)[0] == false
	json.match_schema(object.union(g.transfer_rd, {"instructions": [{"kind": "transfer"}]}), s.decode_tx)[0] == false
}

# What bi.platform.iroha3 and bank.platform.iroha3 read of the answer
reads_tx := {"ok", "encoding", "executable", "signature_ok", "has_multisig", "instructions", "authority"}

reads_movement := {"kind", "asset_definition", "quantity", "scale", "from", "to", "scope", "dataspace"}

reads_dvp := {"kind", "delivery", "payment", "atomicity"}

reads_leg := {"asset_definition", "quantity", "scale", "from", "to"}

reads_grant := {"kind", "grant_kind", "permission", "consent"}

reads_consent := {"intent_hash"}

props(def) := {k | some k, _ in def.properties}

test_fields_read_by_the_rules_are_in_the_schema if {
	d := s.decode_tx.definitions
	count(reads_tx - props(d.TxView)) == 0
	count(reads_leg - props(d.Leg)) == 0
	count(reads_consent - props(d.Consent)) == 0
	every k, r in {"transfer": reads_movement, "dvp": reads_dvp, "grant": reads_grant} {
		count([1 | some o in d.Instr.oneOf; o.properties.kind.enum == [k]; count(r - props(o)) == 0]) == 1
	}
}

test_fields_read_by_the_rules_are_in_the_golden_outputs if {
	count(reads_tx - object.keys(g.transfer_rd)) == 0
	count(reads_movement - object.keys(g.transfer_rd.instructions[0])) == 0
	count(reads_movement - object.keys(g.mint_rd.instructions[0])) == 0
	count(reads_movement - object.keys(g.burn_rd.instructions[0])) == 0
	dvp := g.dvp_settlement.instructions[0]
	count(reads_dvp - object.keys(dvp)) == 0
	count(reads_leg - object.keys(dvp.delivery)) == 0
	count(reads_leg - object.keys(dvp.payment)) == 0
	grant := g.dvp_consent.instructions[0]
	count(reads_grant - object.keys(grant)) == 0
	count(reads_consent - object.keys(grant.consent)) == 0
}

# The scope strings the rules compare: global | dataspace:<n>, and n as a number
test_scope_shape if {
	m := g.transfer_rd.instructions[0]
	m.scope == sprintf("dataspace:%d", [m.dataspace])
	is_number(m.dataspace)
}
