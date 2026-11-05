package clock_test

import data.bi.clock

hours := {
	"RD": {"days": [1, 2, 3, 4, 5], "open": "06:30", "close": "18:00"},
	"DFABI": {"days": [1, 2, 3, 4, 5], "open": "08:00", "close": "16:00"},
}

cfg := {"hours": hours, "holidays": [{"date": "2026-12-25", "name": "Natal"}]}

at(rfc3339) := time.parse_rfc3339_ns(rfc3339)

test_today_rolls_at_1700_utc if {
	clock.today == "2026-11-05" with time.now_ns as at("2026-11-05T16:59:59Z")
	clock.today == "2026-11-06" with time.now_ns as at("2026-11-05T17:00:00Z")
}

test_close_is_exclusive if {
	not clock.token_open("RD") with time.now_ns as at("2026-11-05T11:00:00Z") with data.bi.config as cfg
	clock.token_open("RD") with time.now_ns as at("2026-11-05T10:59:59Z") with data.bi.config as cfg
}

test_weekend_closed if {
	not clock.token_open("RD") with time.now_ns as at("2026-11-07T03:00:00Z") with data.bi.config as cfg
}

# Holiday 2026-12-25, RD open every day all day: only the date can close it.
test_holiday_uses_wib_date if {
	all_day := {"hours": {"RD": {"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00", "close": "24:00"}}, "holidays": cfg.holidays}
	not clock.token_open("RD") with time.now_ns as at("2026-12-24T17:30:00Z") with data.bi.config as all_day
	clock.token_open("RD") with time.now_ns as at("2026-12-24T16:30:00Z") with data.bi.config as all_day
}

# Friday 25 Dec 10:00 WIB is inside Mon-Fri 06:30-18:00, so only the holiday closes it.
test_holiday_closes_weekday_in_hours if {
	not clock.token_open("RD") with time.now_ns as at("2026-12-25T03:00:00Z") with data.bi.config as cfg
}

test_full_day_24 if {
	full := {"hours": {"RD": {"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00", "close": "24:00"}}, "holidays": []}
	clock.token_open("RD") with time.now_ns as at("2026-11-05T16:59:00Z") with data.bi.config as full
}
