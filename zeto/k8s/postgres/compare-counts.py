#!/usr/bin/env python3
"""Compare two row-count listings (lines `schema.table|count`, from counts.sql) for the zeto S8 copy proof.
Usage: compare-counts.py OLD NEW   Exit 0 = every table equal; 1 = differences (printed side by side); 2 = an input is empty."""
import sys

def load(path):
    rows = {}
    for line in open(path):
        line = line.strip()
        if line:
            t, n = line.rsplit("|", 1)
            rows[t] = int(n)
    return rows

old, new = load(sys.argv[1]), load(sys.argv[2])
if not old or not new:
    print("empty listing: an empty database proves nothing", file=sys.stderr)
    sys.exit(2)
bad = [(t, old.get(t), new.get(t)) for t in sorted(set(old) | set(new)) if old.get(t) != new.get(t)]
for t in sorted(set(old) | set(new)):
    print(f"{t}|{old.get(t, 'MISSING')}|{new.get(t, 'MISSING')}|{'DIFF' if (t, old.get(t), new.get(t)) in bad else 'ok'}")
sys.exit(1 if bad else 0)
