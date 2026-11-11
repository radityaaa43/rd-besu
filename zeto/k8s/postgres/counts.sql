-- Row count per user table: `psql -At -f counts.sql > counts.txt` (lines `schema.table|count`, input of compare-counts.py).
select format('select %L, count(*) from %I.%I', schemaname || '.' || relname, schemaname, relname)
from pg_stat_user_tables order by 1
\gexec
