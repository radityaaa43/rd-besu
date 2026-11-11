#!/usr/bin/env python3
"""Offline run test of s21/s21.py layer 3 against a fake kubectl (no cluster). Catches what a syntax check cannot: a missing import or an
undefined name in the live path (S21 attempt 2: `threading` was not imported in the fail-fast Ready wait). Needs python3 only.
Usage: s21_test.py <s21.py> <fake-kubectl>"""
import os, subprocess, sys, tempfile
s21, fake = sys.argv[1], sys.argv[2]
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
bindir = tempfile.mkdtemp()
os.symlink(os.path.abspath(fake), os.path.join(bindir, "kubectl"))
def run(scenario, cmd="l3"):
    env = dict(os.environ, PATH=bindir + os.pathsep + os.environ["PATH"], FAKE_SCENARIO=scenario, S21_HELD="1", S21_ROOT=bindir, S21_BK=bindir)
    return subprocess.run([sys.executable, "-I", s21, cmd], capture_output=True, text=True, env=env, timeout=90)
r = run("ready")
check(r.returncode == 0 and "L3 DONE 3 node(s)" in r.stdout, f"l3 with Ready pods must finish: rc={r.returncode} {r.stdout[-300:]} {r.stderr[-300:]}")
check("Traceback" not in r.stderr and "NameError" not in r.stderr, "l3 ready: no Python error")
check(r.stdout.count("ghcr-pull present") == 3, "l3 must re-read the default SA (ghcr-pull present) before EACH of the 3 new nodes")
check(r.stdout.count("PROOF3") == 3 and "= 0; \"REMOVE: DSN\" lines = 0" in r.stdout, "l3 ready: proof 3 (counts only) must run for each of the 3 nodes with 0 and 0")
r = run("dsnleak")
check(r.returncode == 1 and "proof 3 failed" in r.stdout, f"l3 with a Ready pod whose log shows the DSN must STOP on proof 3: rc={r.returncode} {r.stdout[-200:]}")
check("SECRETPASSWORD123" not in r.stdout + r.stderr, "dsnleak: the password must not reach the output")
r = run("crash")
check(r.returncode == 1 and "container waiting reason CrashLoopBackOff" in r.stdout, f"l3 with a crashing pod must STOP at once on CrashLoopBackOff: rc={r.returncode} {r.stdout[-300:]} {r.stderr[-300:]}")
check("Traceback" not in r.stderr, "l3 crash: no Python error")
check("SECRETPASSWORD123" not in r.stdout + r.stderr, "the fork's `REMOVE: DSN=` log line (it prints the DB password) must never reach the output")
check("last log lines" in r.stdout and "PD010004" in r.stdout, "the stop line must carry the filtered last log lines")
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print("OK s21.py l3 offline run: Ready path, CrashLoopBackOff stop, DSN line dropped")
