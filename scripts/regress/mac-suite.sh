#!/usr/bin/env bash
# SoloMD macOS regression suite — see scripts/regress/README.md.
#
#   scripts/regress/mac-suite.sh                 # build+launch, run every check, stop
#   scripts/regress/mac-suite.sh find split      # only checks whose file name contains "find" or "split"
#   REGRESS_KEEP=1 scripts/regress/mac-suite.sh  # leave the instance running afterwards
#   REGRESS_ATTACH=1 scripts/regress/mac-suite.sh  # reuse an already running regress instance
#
# Exit code: 0 when every check passed, 1 when any check failed, 2 on setup errors.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
APP="$REPO/app"
IDENT="app.solomd.regress"
PORT_VITE="${REGRESS_VITE_PORT:-1450}"
DATA="$HOME/Library/Application Support/$IDENT"
OUT="${REGRESS_OUT:-$HERE/out}"
BOOT_TIMEOUT="${REGRESS_BOOT_TIMEOUT:-1500}"   # seconds; a cold cargo build is slow
mkdir -p "$OUT"
LOG="$OUT/tauri-dev.log"
PIDFILE="$OUT/instance.pgid"

say() { printf '[regress] %s\n' "$*" >&2; }

started_pgid=""
stop_instance() {
  if [[ -n "$started_pgid" && "${REGRESS_KEEP:-0}" != 1 ]]; then
    say "stopping instance (process group $started_pgid)"
    kill -TERM -- "-$started_pgid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 -- "-$started_pgid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$started_pgid" 2>/dev/null
    rm -f "$PIDFILE"
  fi
}
trap stop_instance EXIT
trap 'exit 130' INT TERM

bridge_alive() {
  [[ -f "$DATA/dev-bridge.port" && -f "$DATA/dev-bridge.token" ]] || return 1
  local p; p="$(cat "$DATA/dev-bridge.port")"
  curl -s --noproxy '*' -m 5 -X POST "http://127.0.0.1:$p/eval" \
    -H "Authorization: Bearer $(cat "$DATA/dev-bridge.token")" -H 'content-type: application/json' \
    --data '{"script":"return document.readyState+\"|\"+!!document.querySelector(\"#app\")?.__vue_app__","timeout_ms":3000}' \
    | grep -q '"ok":true'
}

if [[ "${REGRESS_ATTACH:-0}" == 1 ]]; then
  bridge_alive || { say "REGRESS_ATTACH=1 but no live bridge in $DATA"; exit 2; }
  say "attached to running instance"
else
  # Refuse to clobber an instance this script did not start in this run.
  if [[ -f "$PIDFILE" ]] && kill -0 -- "-$(cat "$PIDFILE")" 2>/dev/null; then
    say "a previous regress instance (pgid $(cat "$PIDFILE")) is still running; stop it or use REGRESS_ATTACH=1"; exit 2
  fi
  if lsof -nP -iTCP:"$PORT_VITE" -sTCP:LISTEN >/dev/null 2>&1; then
    say "port $PORT_VITE is busy (another vite?). Set REGRESS_VITE_PORT."; exit 2
  fi
  # Fresh app-side state: session file, workspace, index — this identifier is ours alone.
  rm -rf "$DATA"
  CONFIG=$(printf '{"identifier":"%s","productName":"SoloMD-regress","build":{"devUrl":"http://localhost:%s","beforeDevCommand":"npx vite --port %s --strictPort"}}' "$IDENT" "$PORT_VITE" "$PORT_VITE")
  say "launching tauri dev ($IDENT, vite :$PORT_VITE) — log: $LOG"
  # New session/process group so we can stop exactly what we started (vite + cargo + app).
  # --no-watch: an edit under src-tauri/ (yours, mid-run) must not rebuild and
  # restart the app under the checks.
  ( cd "$APP" && exec python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      pnpm tauri dev --no-watch --config "$CONFIG" ) >"$LOG" 2>&1 &
  started_pgid=$!
  echo "$started_pgid" >"$PIDFILE"
  t0=$(date +%s)
  until bridge_alive; do
    if ! kill -0 "$started_pgid" 2>/dev/null; then say "tauri dev exited early; tail of log:"; tail -30 "$LOG" >&2; exit 2; fi
    if (( $(date +%s) - t0 > BOOT_TIMEOUT )); then say "bridge did not come up in ${BOOT_TIMEOUT}s"; tail -30 "$LOG" >&2; exit 2; fi
    sleep 3
  done
  say "bridge up after $(( $(date +%s) - t0 ))s"
fi

# Fixture vault in a fresh temp dir (the checks never touch your real notes).
# Canonical path (/private/var/…): FSEvents reports real paths, and a /var/… symlinked
# vault would make the file watcher miss every event.
T="${TMPDIR:-/tmp}"; VAULT="$(cd "$(mktemp -d "${T%/}/solomd-regress.XXXXXX")" && pwd -P)/vault"
python3 "$HERE/lib/make_fixture.py" "$VAULT" || { say "fixture creation failed"; exit 2; }
say "fixture vault: $VAULT"
echo "$VAULT" >"$OUT/last-vault"

PGID_ARG="${started_pgid:-$(cat "$PIDFILE" 2>/dev/null)}"
node "$HERE/lib/run-checks.mjs" --data "$DATA" --vault "$VAULT" --out "$OUT" --checks "$HERE/checks" --pgid "$PGID_ARG" -- "$@"
rc=$?
say "results: $OUT/results.json"
exit $rc
