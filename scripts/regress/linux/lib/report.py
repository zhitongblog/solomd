#!/usr/bin/env python3
"""Collect results/<id>.{status,summary,notes,secs} into results.json and
print a PASS/FAIL table. Exit 0 when nothing failed, 1 otherwise."""
import glob
import json
import os
import sys

out = sys.argv[1]
res_dir = os.path.join(out, "results")
shots = sorted(os.listdir(os.path.join(out, "shots"))) if os.path.isdir(os.path.join(out, "shots")) else []


def read(p, default=""):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return default


checks = []
for st in sorted(glob.glob(os.path.join(res_dir, "*.status"))):
    cid = os.path.basename(st)[:-len(".status")]
    base = os.path.join(res_dir, cid)
    checks.append({
        "id": cid,
        "status": read(st, "FAIL"),
        "summary": read(base + ".summary"),
        "seconds": int(read(base + ".secs", "0") or 0),
        "notes": [n for n in read(base + ".notes").splitlines() if n],
        "screenshots": [s for s in shots if s.startswith(cid + "-")],
        "log": f"logs/{cid}.log",
    })

counts = {}
for c in checks:
    counts[c["status"]] = counts.get(c["status"], 0) + 1

doc = {
    "build": read(os.path.join(out, "build.txt")),
    "counts": counts,
    "checks": checks,
}
with open(os.path.join(out, "results.json"), "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)

w = max([len(c["id"]) for c in checks] + [5])
print()
print(f"{'check':<{w}}  result  secs  summary")
print(f"{'-' * w}  ------  ----  -------")
for c in checks:
    print(f"{c['id']:<{w}}  {c['status']:<6}  {c['seconds']:>4}  {c['summary']}")
print()
print("totals: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
for c in checks:
    if c["status"] == "FAIL":
        print(f"\n--- {c['id']}: {c['summary']}")
        for n in c["notes"]:
            print(f"    {n}")
        print(f"    screenshots: {' '.join(c['screenshots']) or '-'}")
sys.exit(1 if counts.get("FAIL") else 0)
