# Operating hours in WIB. WIB is a fixed UTC+7 with no DST, so local time is the clock plus 7h read as UTC
# and the OPA image needs no tz data. Tests pin the clock with `with time.now_ns as ...`.
package bi.clock

local_ns := time.now_ns() + 25200000000000

weekdays := {
	"Monday": 1,
	"Tuesday": 2,
	"Wednesday": 3,
	"Thursday": 4,
	"Friday": 5,
	"Saturday": 6,
	"Sunday": 7,
}

# Monday = 1 .. Sunday = 7. The bank bundle reads weekday and hhmm as data, so it builds without this package.
weekday := weekdays[time.weekday(local_ns)]

today := sprintf("%04d-%02d-%02d", time.date(local_ns))

hhmm := sprintf("%02d:%02d", array.slice(time.clock(local_ns), 0, 2))

# Open when the weekday is listed, today is no holiday, and open <= now < close (strings, so "24:00" works).
open(hours, holidays) if {
	weekday in hours.days
	not today in {h.date | some h in holidays}
	hours.open <= hhmm
	hhmm < hours.close
}

# Hours and holidays are those of the platform's BI document ("zeto" or "noto"). No document = closed.
token_open(platform, token) if {
	p := data.bi.config.policy[platform]
	open(p.hours[token], p.holidays)
}
