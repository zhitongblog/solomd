#!/usr/bin/env python3
"""Read / seed the WebKitGTK localStorage database of the app profile.

WebKitGTK keeps localStorage in SQLite (`ItemTable(key, value BLOB)`), values
UTF-16LE, WAL mode. Reading through sqlite3 picks up the WAL automatically;
seeding is only done while the app is NOT running.

  ls.py get  DB KEY            -> prints the value
  ls.py json DB KEY PYEXPR     -> evaluates PYEXPR with `v` = parsed JSON,
                                  prints the result (exit 1 if falsy/absent)
  ls.py keys DB                -> prints all keys
  ls.py seed DB JSONFILE       -> creates DB with {key: value(str|obj)}
"""
import json
import os
import sqlite3
import sys


def connect(db):
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def get(db, key):
    if not os.path.exists(db):
        return None
    c = connect(db)
    try:
        row = c.execute("select value from ItemTable where key=?", (key,)).fetchone()
    finally:
        c.close()
    if not row:
        return None
    v = row[0]
    return v.decode("utf-16-le") if isinstance(v, (bytes, bytearray)) else str(v)


def main():
    mode, db = sys.argv[1], sys.argv[2]
    if mode == "get":
        v = get(db, sys.argv[3])
        if v is None:
            return 1
        print(v)
        return 0
    if mode == "json":
        raw = get(db, sys.argv[3])
        v = json.loads(raw) if raw else None
        r = eval(sys.argv[4], {"v": v, "json": json})  # noqa: S307 — test helper
        print(json.dumps(r, ensure_ascii=False) if not isinstance(r, str) else r)
        return 0 if r else 1
    if mode == "keys":
        c = connect(db)
        for (k,) in c.execute("select key from ItemTable"):
            print(k)
        return 0
    if mode == "seed":
        data = json.load(open(sys.argv[3], encoding="utf-8"))
        os.makedirs(os.path.dirname(db), exist_ok=True)
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(db + suffix):
                os.unlink(db + suffix)
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, "
                  "value BLOB NOT NULL ON CONFLICT FAIL)")
        for k, v in data.items():
            s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
            c.execute("insert into ItemTable values (?, ?)", (k, s.encode("utf-16-le")))
        c.commit()
        c.close()
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
