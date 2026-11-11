#!/usr/bin/env python3 -I
"""Reference SOURCE tar for POST /sink/bundles/<name> (opa/bundle-server/sink.py read_archive(rooted=False)). Python stdlib only.
  source_tar.py <bundle dir> -o out.tar.gz [--data assembled.json] [--revision STR]
<bundle dir> = opa/bundles/bi or opa/bundles/bank. Members: plain relative names (`bi/atom/atom.rego`, `gw/gw.rego`, `.manifest`), sorted,
mode 0644, uid/gid 0, mtime 0, gzip header mtime 0 -> the same input gives the same bytes. NEVER `opa build` output (rooted names: the sink answers 400).
--data   the assembled data.json, stored as `<kind>/config/data.json` (kind = bi|bank, the bundle dir name); replaces a data.json of the dir.
--revision  written into `.manifest` next to the roots (the sink keeps a given .manifest and then passes no --revision; Lensa reads it)."""
import gzip, io, json, os, sys, tarfile

def source_files(bundle_dir, data=None, revision=None):
    """{relative name: bytes} of the bundle dir; `data` (bytes) = assembled `<kind>/config/data.json`; `revision` goes into `.manifest`."""
    kind = os.path.basename(os.path.normpath(bundle_dir))
    files = {}
    for root, _, names in os.walk(bundle_dir):
        for n in names:
            p = os.path.join(root, n)
            with open(p, "rb") as f: files[os.path.relpath(p, bundle_dir).replace(os.sep, "/")] = f.read()
    if data is not None:
        files[f"{kind}/config/data.json"] = data
    if revision is not None:
        m = json.loads(files[".manifest"]) if ".manifest" in files else {}
        m["revision"] = revision
        files[".manifest"] = (json.dumps(m, sort_keys=True) + "\n").encode()
    return files

def make_tar(files):
    """Deterministic tar.gz bytes from {name: bytes}."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for name in sorted(files):
            ti = tarfile.TarInfo(name)
            ti.size, ti.mode, ti.uid, ti.gid, ti.uname, ti.gname, ti.mtime = len(files[name]), 0o644, 0, 0, "", "", 0
            t.addfile(ti, io.BytesIO(files[name]))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0, filename="") as g:
        g.write(raw.getvalue())
    return out.getvalue()

if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda n: a[a.index(n) + 1] if n in a else None
    if not a or not opt("-o"):
        sys.exit(__doc__)
    data = None
    if opt("--data"):
        with open(opt("--data"), "rb") as f: data = f.read()
    blob = make_tar(source_files(a[0], data, opt("--revision")))
    with open(opt("-o"), "wb") as f: f.write(blob)
    print(f"{opt('-o')}: {len(blob)} bytes")
