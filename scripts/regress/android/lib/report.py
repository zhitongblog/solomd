#!/usr/bin/env python3
"""results.tsv -> PASS/FAIL table on stdout + results.json. Exit 1 if any FAIL."""
import json, sys, datetime

tsv, out_json, apk, serial = sys.argv[1:5]
rows = []
for line in open(tsv, encoding='utf-8'):
    line = line.rstrip('\n')
    if not line:
        continue
    p = (line.split('\t') + [''] * 8)[:8]
    rows.append(dict(id=p[0], status=p[1], seconds=int(p[2] or 0), row=p[3], title=p[4],
                     detail=p[5], shots=[s for s in p[6].split(',') if s],
                     notes=[s for s in p[7].split(' | ') if s]))

w_id = max([len(r['id']) for r in rows] + [5])
print()
print(f"{'CHECK'.ljust(w_id)}  RESULT  {'ROW'.ljust(8)}  DETAIL")
print('-' * (w_id + 80))
for r in rows:
    print(f"{r['id'].ljust(w_id)}  {r['status'].ljust(6)}  {r['row'][:8].ljust(8)}  {r['detail'][:140]}")
n_fail = sum(r['status'] != 'PASS' for r in rows)
print('-' * (w_id + 80))
print(f"{len(rows) - n_fail} passed, {n_fail} failed, {len(rows)} total")

json.dump(dict(platform='android', when=datetime.datetime.now().isoformat(timespec='seconds'),
               apk=apk, serial=serial, passed=len(rows) - n_fail, failed=n_fail, checks=rows),
          open(out_json, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
sys.exit(1 if n_fail else 0)
