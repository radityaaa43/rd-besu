#!/usr/bin/env python3 -I
"""Public-repo rules for the workflows (analyst conditions 2026-11-12). Needs PyYAML. No network.
(a) every workflow step that pushes (`push: true`) must be FOLLOWED by a step that asserts the package visibility is private through the packages API and fails otherwise;
(d)/(e) attest-build-provenance needs id-token + attestations write, and the private-package assert + an authenticated pull test must run BEFORE it (--selftest runs fixtures);
(c) CI logs are public: no env dump (printenv / `env |` / `set -x` / `ACTIONS_STEP_DEBUG`), no kubeconfig, no kubectl, no secret other than the job's GITHUB_TOKEN (never echoed)."""
import glob, re, sys, yaml
fails = []

def check_attest(name, wf):
    """(d) a job that uses actions/attest-build-provenance needs id-token: write AND attestations: write (job permissions replace the workflow ones;
    a job without its own block inherits the workflow ones). (e) BEFORE that attest step: a step asserting the package is private (fail closed) and an authenticated
    pull test (docker pull of the pushed digest, compared, exit 1 otherwise). The attest step failing must never be what hides a missing visibility check."""
    out = []
    for jn, job in (wf.get("jobs") or {}).items():
        steps = job.get("steps") or []
        idx = [i for i, x in enumerate(steps) if str(x.get("uses", "")).startswith("actions/attest-build-provenance")]
        if not idx: continue
        perms = job["permissions"] if "permissions" in job else (wf.get("permissions") or {})
        for need in ("id-token", "attestations"):
            if not isinstance(perms, dict) or perms.get(need) != "write": out.append(f"{name}:{jn}: actions/attest-build-provenance needs `{need}: write` on the job (effective permissions: {perms})")
        before = [x for x in steps[:idx[0]] if "run" in x]
        if not any(re.search(r"packages/container/", x["run"]) and re.search(r"visibility", x["run"]) and re.search(r"private", x["run"]) and re.search(r"exit 1", x["run"]) for x in before):
            out.append(f"{name}:{jn}: no step before the attest step asserts the package is private (it must run before the attest step)")
        if not any(re.search(r"docker pull", x["run"]) and re.search(r"digest|RepoDigests|imagetools", x["run"]) and re.search(r"exit 1", x["run"]) and re.search(r"\[ .*= .*\]|!=", x["run"]) for x in before):
            out.append(f"{name}:{jn}: no authenticated pull test before the attest step (docker pull of the pushed digest, compared, exit 1 otherwise)")
    return out

GOOD = """
name: g
permissions: {contents: read, packages: write}
jobs:
  image:
    runs-on: ubuntu-24.04
    permissions: {contents: read, packages: write, id-token: write, attestations: write}
    steps:
      - id: build
        uses: docker/build-push-action@x
        with: {push: true}
      - name: Assert the package is private
        run: |
          v=$(gh api /users/o/packages/container/p --jq .visibility) || exit 1
          [ "$v" = private ] || exit 1
      - name: Authenticated pull test
        run: |
          docker pull ghcr.io/o/p@${{ steps.build.outputs.digest }} || exit 1
          got=$(docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/o/p@${{ steps.build.outputs.digest }})
          [ "$got" = "ghcr.io/o/p@${{ steps.build.outputs.digest }}" ] || exit 1
      - uses: actions/attest-build-provenance@v2
        with: {subject-name: x, subject-digest: y}
"""
def selftest():
    import copy
    g = yaml.safe_load(GOOD)
    assert check_attest("good.yml", g) == [], check_attest("good.yml", g)
    b = copy.deepcopy(g); del b["jobs"]["image"]["permissions"]["attestations"]
    assert any("attestations: write" in x for x in check_attest("b.yml", b)), "missed missing attestations"
    b = copy.deepcopy(g); del b["jobs"]["image"]["permissions"]["id-token"]
    assert any("id-token: write" in x for x in check_attest("b.yml", b)), "missed missing id-token"
    b = copy.deepcopy(g); del b["jobs"]["image"]["permissions"]; b["permissions"] = {"contents": "read", "packages": "write"}
    assert len(check_attest("b.yml", b)) >= 2, "workflow-level permissions without id-token/attestations must fail"
    b = copy.deepcopy(g); b["permissions"] = {"id-token": "write", "attestations": "write"}; del b["jobs"]["image"]["permissions"]
    assert not [x for x in check_attest("b.yml", b) if "write" in x and "permissions" in x], "workflow-level permissions are inherited when the job has none"
    b = copy.deepcopy(g); st = b["jobs"]["image"]["steps"]; st[1], st[3] = st[3], st[1]
    assert any("before the attest" in x for x in check_attest("b.yml", b)), "missed attest before the visibility assert"
    b = copy.deepcopy(g); del b["jobs"]["image"]["steps"][2]
    assert any("authenticated pull" in x for x in check_attest("b.yml", b)), "missed missing pull test"
    b = copy.deepcopy(g); b["jobs"]["image"]["steps"][2]["run"] = "docker pull x"
    assert any("authenticated pull" in x for x in check_attest("b.yml", b)), "pull test must compare and fail closed"
    b = copy.deepcopy(g); b["jobs"]["image"]["steps"] = [x for x in b["jobs"]["image"]["steps"] if "attest" not in str(x.get("uses", ""))]
    assert check_attest("b.yml", b) == [], "no attest step: nothing to check"
    print("selftest ok")
if "--selftest" in sys.argv:
    selftest(); sys.exit(0)
for f in sorted(glob.glob(".github/workflows/*.yml")):
    text = open(f).read(); wf = yaml.safe_load(text)
    fails += check_attest(f, wf)
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
