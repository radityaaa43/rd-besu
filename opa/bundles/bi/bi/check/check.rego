# Checks on a draft of the BI document (data.bi.config), run by the Lensa server with `opa eval` before
# the draft can be submitted for approval. Messages are shown to users as they are.
# The bank bundle has its own copy of the helpers it needs (bank.check): a bundle may not call the other's functions.
package bi.check

import data.bi.ident

tokens := ["RD", "DFABI"]

max_amount := 1000000000000000

time_re := `^([01][0-9]|2[0-3]):[0-5][0-9]$`

pos_int(v) if {
	is_number(v)
	v > 0
	v == floor(v)
}

valid_time(t) if {
	is_string(t)
	regex.match(time_re, t)
}

valid_date(d) if {
	is_string(d)
	time.format([time.parse_ns("2006-01-02", d), "UTC", "2006-01-02"]) == d
}

# Amounts: each is required.
amounts[name] := v if {
	some t in tokens
	some spec in [
		{"key": "max_per_tx", "label": "Limit per transaksi"},
		{"key": "max_mint_per_tx", "label": "Limit penerbitan"},
	]
	name := $"{spec.label} {t}"
	v := object.get(data.bi.config, ["zeto", spec.key, t], null)
}

# Hours: a missing day list, open or close is closed at runtime, so it is an error here.
hours(t) := object.get(data.bi.config, ["hours", t], {})

valid_days(h) if {
	days := object.get(h, "days", null)
	is_array(days)
	count(days) > 0
	every d in days {
		is_number(d)
		d == floor(d)
		d >= 1
		d <= 7
	}
}

valid_open(h) if valid_time(object.get(h, "open", null))

valid_close(h) if valid_time(object.get(h, "close", null))

valid_close(h) if h.close == "24:00"

holiday_dates := [object.get(h, "date", "") | some h in data.bi.config.holidays]

# Names of the BI node: the issuer, or the node of party BI.
bi_nodes contains name if {
	some name, node in data.bi.config.nodes
	node.issuer == true
}

bi_nodes contains name if {
	some name, node in data.bi.config.nodes
	node.party == "BI"
}

errors contains $"{name}: harus bilangan bulat positif" if {
	some name, v in amounts
	not pos_int(v)
}

errors contains $"{name}: melebihi 1.000.000.000.000.000" if {
	some name, v in amounts
	pos_int(v)
	v > max_amount
}

errors contains $"Jam {t}: hari harus 1 (Senin) sampai 7 (Minggu)" if {
	some t in tokens
	not valid_days(hours(t))
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some t in tokens
	not valid_open(hours(t))
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some t in tokens
	not valid_close(hours(t))
}

errors contains $"Jam {t}: jam buka harus sebelum jam tutup" if {
	some t in tokens
	h := hours(t)
	valid_open(h)
	valid_close(h)
	h.open >= h.close
}

errors contains "Hari libur: harus berupa daftar" if not is_array(object.get(data.bi.config, "holidays", null))

errors contains $"Hari libur {d}: tanggal tidak valid" if {
	some d in holiday_dates
	not valid_date(d)
}

errors contains $"Hari libur {d}: tercatat dua kali" if {
	some d in holiday_dates
	valid_date(d)
	count([x | some x in holiday_dates; x == d]) > 1
}

errors contains "Pembekuan: harus berupa daftar" if not is_array(object.get(data.bi.config, "frozen", null))

errors contains $"Pembekuan: {id} bukan peserta" if {
	some id in data.bi.config.frozen
	not ident.participant(id)
}

errors contains "Pembekuan: BI tidak dapat membekukan dirinya sendiri" if {
	some id in data.bi.config.frozen
	ident.node_of(id) in bi_nodes
}
