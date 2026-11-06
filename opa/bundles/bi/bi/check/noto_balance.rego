# Checks on BI's optional Noto balance controls (noto.max_balance, noto.min_balance, noto.max_supply, per token; absent = off).
# Same package as check.rego: errors, tokens, pos_int and max_amount are its.
package bi.check

noto_controls[name] := v if {
	some t in tokens
	some spec in [
		{"key": "max_balance", "label": "Saldo maksimal"},
		{"key": "min_balance", "label": "Saldo minimal"},
		{"key": "max_supply", "label": "Suplai maksimal"},
	]
	name := $"{spec.label} {t}"
	v := data.bi.config.noto[spec.key][t]
}

errors contains $"{name}: harus bilangan bulat positif" if {
	some name, v in noto_controls
	not pos_int(v)
}

errors contains $"{name}: melebihi 1.000.000.000.000.000" if {
	some name, v in noto_controls
	pos_int(v)
	v > max_amount
}

errors contains $"Saldo minimal {t}: harus lebih kecil dari saldo maksimal" if {
	some t in tokens
	lo := data.bi.config.noto.min_balance[t]
	hi := data.bi.config.noto.max_balance[t]
	pos_int(lo)
	pos_int(hi)
	lo >= hi
}
