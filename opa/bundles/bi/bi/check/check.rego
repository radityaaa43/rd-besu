# Checks on a draft of the BI documents (data.bi.config.policy.zeto and .noto, one per platform), run by the Lensa
# server with `opa eval` before the draft can be submitted for approval. Every document is checked the same way, and a
# message does not name the platform (the server composes the config so that only the draft can fail). Messages are shown to users as they are.
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

# Both platforms need a document (a missing one denies everything on that platform at runtime).
errors contains $"Kebijakan {p}: dokumen tidak ada" if {
	some p in ["zeto", "noto"]
	not data.bi.config.policy[p]
}

# Amounts: each is required. Keyed by [platform, name].
amounts[[p, name]] := v if {
	some p, doc in data.bi.config.policy
	some t in tokens
	some spec in [
		{"key": "max_per_tx", "label": "Limit per transaksi"},
		{"key": "max_mint_per_tx", "label": "Limit penerbitan"},
	]
	name := $"{spec.label} {t}"
	v := object.get(doc, [spec.key, t], null)
}

# Hours: a missing day list, open or close is closed at runtime, so it is an error here.
hours(doc, t) := object.get(doc, ["hours", t], {})

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

holiday_dates(doc) := [object.get(h, "date", "") | some h in doc.holidays]

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
	some k, v in amounts
	name := k[1]
	not pos_int(v)
}

errors contains $"{name}: melebihi 1.000.000.000.000.000" if {
	some k, v in amounts
	name := k[1]
	pos_int(v)
	v > max_amount
}

errors contains $"Jam {t}: hari harus 1 (Senin) sampai 7 (Minggu)" if {
	some _, doc in data.bi.config.policy
	some t in tokens
	not valid_days(hours(doc, t))
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some _, doc in data.bi.config.policy
	some t in tokens
	not valid_open(hours(doc, t))
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some _, doc in data.bi.config.policy
	some t in tokens
	not valid_close(hours(doc, t))
}

errors contains $"Jam {t}: jam buka harus sebelum jam tutup" if {
	some _, doc in data.bi.config.policy
	some t in tokens
	h := hours(doc, t)
	valid_open(h)
	valid_close(h)
	h.open >= h.close
}

errors contains "Hari libur: harus berupa daftar" if {
	some _, doc in data.bi.config.policy
	not is_array(object.get(doc, "holidays", null))
}

errors contains $"Hari libur {d}: tanggal tidak valid" if {
	some _, doc in data.bi.config.policy
	some d in holiday_dates(doc)
	not valid_date(d)
}

errors contains $"Hari libur {d}: tercatat dua kali" if {
	some _, doc in data.bi.config.policy
	dates := holiday_dates(doc)
	some d in dates
	valid_date(d)
	count([x | some x in dates; x == d]) > 1
}

errors contains "Pembekuan: harus berupa daftar" if {
	some _, doc in data.bi.config.policy
	not is_array(object.get(doc, "frozen", null))
}

errors contains $"Pembekuan: {id} bukan peserta" if {
	some _, doc in data.bi.config.policy
	some id in doc.frozen
	not ident.participant(id)
}

errors contains "Pembekuan: BI tidak dapat membekukan dirinya sendiri" if {
	some _, doc in data.bi.config.policy
	some id in doc.frozen
	ident.node_of(id) in bi_nodes
}
