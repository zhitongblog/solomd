#!/usr/bin/env bash
# Read or update a SoloMD localStorage setting from the CLI.
# Usage:
#   solomd-settings.sh [--bundle dev|prod] get
#   solomd-settings.sh [--bundle dev|prod] set <key> <jsonValue>
# Examples:
#   ./scripts/solomd-settings.sh get
#   ./scripts/solomd-settings.sh --bundle dev set autoGitEnabled true
#
# Tauri uses two distinct WKWebView data stores keyed by bundle id:
#   - prod  → ~/Library/WebKit/app.solomd/  (the installed dmg)
#   - dev   → ~/Library/WebKit/solomd/      (the `pnpm tauri dev` build)
# Default = dev (the one used while iterating).
#
# Each LocalStorage value is UTF-16 LE inside an SQLite blob.
# REQUIRES SoloMD be closed (WKWebView holds the file open).

set -euo pipefail

BUNDLE="dev"

if [ "${1:-}" = "--bundle" ]; then
  BUNDLE="${2:-dev}"
  shift 2
fi

case "$BUNDLE" in
  dev)
    LS_DIR="$HOME/Library/WebKit/solomd/WebsiteData/Default/y_a-QbuPa1QmlFcuFGdl2gs24bBFFTCBTT8ilCLEsu0/y_a-QbuPa1QmlFcuFGdl2gs24bBFFTCBTT8ilCLEsu0/LocalStorage"
    ;;
  prod)
    LS_DIR="$HOME/Library/WebKit/app.solomd/WebsiteData/Default/bvB3gbOLx5VDrjmfAOI5KBKeMsCcGefh6CxQA9MFkBM/bvB3gbOLx5VDrjmfAOI5KBKeMsCcGefh6CxQA9MFkBM/LocalStorage"
    ;;
  *)
    echo "unknown bundle: $BUNDLE (use dev or prod)" >&2
    exit 2
    ;;
esac

LS_FILE="$LS_DIR/localstorage.sqlite3"
if [ ! -f "$LS_FILE" ]; then
  echo "no localStorage at $LS_FILE" >&2
  exit 1
fi

cmd="${1:-get}"

case "$cmd" in
  get)
    LS_FILE="$LS_FILE" python3 - <<'PY'
import sqlite3, json, os
LS = os.environ['LS_FILE']
conn = sqlite3.connect(LS)
cur = conn.cursor()
cur.execute("SELECT value FROM ItemTable WHERE key='solomd.settings.v1'")
row = cur.fetchone()
if not row:
    print('{}'); exit(0)
data = json.loads(row[0].decode('utf-16-le'))
print(json.dumps(data, indent=2, ensure_ascii=False))
PY
    ;;
  set)
    key="${2:?key required}"
    value="${3:?value required (JSON literal)}"
    LS_FILE="$LS_FILE" KEY="$key" VAL="$value" python3 - <<'PY'
import sqlite3, json, os
LS = os.environ['LS_FILE']
KEY = os.environ['KEY']
VAL = json.loads(os.environ['VAL'])
conn = sqlite3.connect(LS)
cur = conn.cursor()
cur.execute("SELECT value FROM ItemTable WHERE key='solomd.settings.v1'")
row = cur.fetchone()
if not row:
    print('no settings row'); exit(1)
data = json.loads(row[0].decode('utf-16-le'))
data[KEY] = VAL
new_raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-16-le')
cur.execute("UPDATE ItemTable SET value=? WHERE key='solomd.settings.v1'", (new_raw,))
conn.commit()
print(f'set {KEY} = {VAL}')
PY
    ;;
  set-workspace)
    folder="${2:?folder required}"
    LS_FILE="$LS_FILE" FOLDER="$folder" python3 - <<'PY'
import sqlite3, json, os
LS = os.environ['LS_FILE']
FOLDER = os.environ['FOLDER']
conn = sqlite3.connect(LS)
cur = conn.cursor()
cur.execute("SELECT value FROM ItemTable WHERE key='solomd.workspace.v1'")
row = cur.fetchone()
data = json.loads(row[0].decode('utf-16-le')) if row else {'recentFiles': []}
data['currentFolder'] = FOLDER
new_raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-16-le')
if row:
    cur.execute("UPDATE ItemTable SET value=? WHERE key='solomd.workspace.v1'", (new_raw,))
else:
    cur.execute("INSERT INTO ItemTable(key, value) VALUES('solomd.workspace.v1', ?)", (new_raw,))
conn.commit()
print(f'workspace.currentFolder = {FOLDER}')
PY
    ;;
  *)
    echo "usage: $0 [--bundle dev|prod] {get|set <k> <v>|set-workspace <folder>}" >&2
    exit 2
    ;;
esac
