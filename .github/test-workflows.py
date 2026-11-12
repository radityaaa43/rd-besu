#!/usr/bin/env python3 -I
"""Public-repo rules for the workflows (analyst conditions 2026-11-12). Needs PyYAML. No network.
(a) every workflow step that pushes (`push: true`) must be FOLLOWED by a step that asserts the package visibility is private through the packages API and fails otherwise;
(c) CI logs are public: no env dump (printenv / `env |` / `set -x` / `ACTIONS_STEP_DEBUG`), no kubeconfig, no kubectl, no secret other than the job's GITHUB_TOKEN (never echoed)."""
import glob, re, sys, yaml
fails = []
for f in sorted(glob.glob(".github/workflows/*.yml")):
    text = open(f).read(); wf = yaml.safe_load(text)
    for jn, job in (wf.get("jobs") or {}).items():
        steps = job.get("steps") or []
        for i, s in enumerate(steps):
            if str((s.get("with") or {}).get("push", "")).lower() == "true":
                after = [x for x in steps[i + 1:] if "run" in x]
                ok = any(re.search(r"packages/container/", x["run"]) and re.search(r"visibility", x["run"]) and re.search(r"private", x["run"]) and re.search(r"exit 1", x["run"]) for x in after)
                if not ok: fails.append(f"{f}:{jn}: pushes a package but no later step asserts visibility == private (gh api packages/container/<name> .visibility, exit 1 otherwise)")
    for pat, why in ((r"printenv", "env dump"), (r"(^|[\s;|&])env\s*(\||$)", "env dump"), (r"set\s+-x", "shell trace"), (r"ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG", "debug logging"), (r"kubeconfig|kubectl", "cluster access in CI"),
                     (r"echo[^\n]*\$\{\{\s*secrets\.", "echo of a secret")):
        if re.search(pat, text, re.M): fails.append(f"{f}: {why} ({pat})")
    for m in re.finditer(r"secrets\.([A-Za-z0-9_]+)", text):
        if m.group(1) != "GITHUB_TOKEN": fails.append(f"{f}: secret {m.group(1)} used (only the job's GITHUB_TOKEN is allowed)")
if fails:
    print("\n".join("FAIL " + x for x in fails), file=sys.stderr); sys.exit(1)
print("OK workflows: every pushing job asserts a private package; no env dump, no kubeconfig/kubectl, no secret but GITHUB_TOKEN")
