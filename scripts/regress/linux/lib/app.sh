# shellcheck shell=bash
# Rig (Xvfb + openbox + private dbus), profile, vault and app lifecycle.

# ------------------------------------------------------------------- rig ---
rig_up() {
  mkdir -p "$RG_ROOT"
  local n="${RG_DISPLAY#:}"
  if [ -e "/tmp/.X${n}-lock" ]; then
    local holder; holder=$(tr -d ' ' <"/tmp/.X${n}-lock" 2>/dev/null)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      if [ "$(cat "$RG_ROOT/xvfb.pid" 2>/dev/null)" != "$holder" ]; then
        log "display $RG_DISPLAY is in use by pid $holder (not ours) — pick another RG_DISPLAY"
        return 1
      fi
    else
      rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
    fi
  fi
  if ! xdpyinfo -display "$RG_DISPLAY" >/dev/null 2>&1; then
    env SOLOMD_REGRESS_TAG="$SOLOMD_REGRESS_TAG" Xvfb "$RG_DISPLAY" -screen 0 "$RG_SCREEN" -nolisten tcp \
      >"$RG_ROOT/xvfb.log" 2>&1 &
    echo $! >"$RG_ROOT/xvfb.pid"
    local i; for i in $(seq 1 40); do xdpyinfo -display "$RG_DISPLAY" >/dev/null 2>&1 && break; sleep 0.25; done
  fi
  export DISPLAY="$RG_DISPLAY"
  # private session bus: single-instance (D-Bus) and portals stay out of
  # any other rig on this machine
  local addr pid
  read -r addr pid < <(env SOLOMD_REGRESS_TAG="$SOLOMD_REGRESS_TAG" dbus-daemon --session --fork \
    --print-address=1 --print-pid=1 | tr '\n' ' ')
  echo "$pid" >"$RG_ROOT/dbus.pid"
  printf 'export DBUS_SESSION_BUS_ADDRESS=%q\n' "$addr" >"$RG_ROOT/rig.env"
  export DBUS_SESSION_BUS_ADDRESS="$addr"
  # window manager: without one nothing ever gets keyboard focus (trap 1)
  env SOLOMD_REGRESS_TAG="$SOLOMD_REGRESS_TAG" DISPLAY="$RG_DISPLAY" openbox >"$RG_ROOT/openbox.log" 2>&1 &
  echo $! >"$RG_ROOT/openbox.pid"
  sleep 1
  # sanity: the rig itself delivers keystrokes (trap 1 again)
  rig_selftest
}

rig_selftest() {
  local f="$RG_ROOT/.selftest" pid
  rm -f "$f"
  pid=$(rg_spawn xterm -geometry 60x5+10+10 -e "bash -c 'read -r l; echo \"\$l\" > $f'")
  local w; w=$(wait_window '^xterm$|bash' 10) || true
  sleep 1
  [ -n "$w" ] && xdotool windowactivate --sync "$w" 2>/dev/null
  typ "rig-ok"; key Return
  sleep 1
  kill "$pid" 2>/dev/null
  if [ "$(cat "$f" 2>/dev/null)" = "rig-ok" ]; then log "rig self-test: keyboard reaches a window"; return 0; fi
  log "rig self-test FAILED: xterm did not receive keystrokes"; return 1
}

rig_down() {
  app_kill
  local p
  for p in $(our_pids); do kill "$p" 2>/dev/null; done
  for f in openbox dbus xvfb; do
    p=$(cat "$RG_ROOT/$f.pid" 2>/dev/null) && kill "$p" 2>/dev/null
    rm -f "$RG_ROOT/$f.pid"
  done
  sleep 0.5
}

# ---------------------------------------------------------------- profile ---
# A fresh, private profile per check: HOME points at $PROFILE_HOME, so the
# box's real ~/.local/share/app.solomd is never touched. localStorage is
# seeded so the first-run wizard / tour / banners don't eat input (trap 2),
# and it is created from scratch, so no WAL from a previous run (trap 3).
#
# SEED_SETTINGS='{"language":"zh"}' merges into the settings blob.
# SEED_EXTRA='{"key": value}' adds raw localStorage keys.
profile_reset() {
  app_kill
  rm -rf "$PROFILE_HOME"
  mkdir -p "$PROFILE_HOME/Documents" "$LS_DIR"
  python3 "$RG_SUITE/lib/seed.py" "$VAULT" "${SEED_SETTINGS:-}" "${SEED_EXTRA:-}" >"$RG_ROOT/seed.json"
  python3 "$RG_SUITE/lib/ls.py" seed "$LS_DB" "$RG_ROOT/seed.json"
}

# ------------------------------------------------------------------- app ---
app_launch() { # [args…]  — starts the app, waits for a painted window
  local t0=$SECONDS
  app_env "$SOLOMD_BIN" "$@" >>"$RG_OUT/logs/$CHECK_ID.app.log" 2>&1 &
  echo $! >"$RG_ROOT/app.pid"
  app_wait_ready "${LAUNCH_TIMEOUT:-45}" || return 1
  LAUNCH_SECS=$((SECONDS - t0))
  return 0
}

# Wait for the main window and its first non-blank, stable frame (trap 5).
app_wait_ready() {
  local t="${1:-45}" w="" prev="$RG_ROOT/.rdy0.png" cur="$RG_ROOT/.rdy1.png" end
  end=$((SECONDS + t))
  while [ $SECONDS -le $end ]; do
    w=$(main_window) && break
    sleep 0.5
  done
  [ -n "$w" ] || { log "no window within ${t}s"; return 1; }
  if [ "${NO_RESIZE:-0}" != 1 ]; then
    xdotool windowmove "$w" 0 0 windowsize "$w" 1440 870 2>/dev/null
  fi
  xdotool windowactivate --sync "$w" 2>/dev/null
  rm -f "$prev"
  while [ $SECONDS -le $end ]; do
    sleep 0.7
    import -window root "$cur" 2>/dev/null || continue
    if [ "$(img_colors "$cur")" -gt 60 ] && [ -f "$prev" ] && [ "$(img_diff "$prev" "$cur")" -lt 300 ]; then
      sleep "${SETTLE:-1.5}"
      return 0
    fi
    cp "$cur" "$prev"
  done
  log "window never painted a stable non-blank frame"
  return 1
}

# Ctrl+Q in the main window; true when every app process is gone in time.
app_quit() {
  local t="${1:-10}" i
  focus_main
  key ctrl+q
  for ((i = 0; i < t * 4; i++)); do
    [ -z "$(our_app_pids)" ] && return 0
    sleep 0.25
  done
  return 1
}

app_running() { [ -n "$(our_app_pids)" ]; }

app_kill() {
  local p ps
  ps=$(our_app_pids)
  [ -z "$ps" ] && return 0
  for p in $ps; do kill "$p" 2>/dev/null; done
  sleep 1
  for p in $(our_app_pids); do kill -9 "$p" 2>/dev/null; done
  sleep 0.3
}

# Open a file in the running app through the single-instance hand-off
# (second launch with a path argument → existing window opens it).
app_open() {
  app_env "$SOLOMD_BIN" "$1" >>"$RG_OUT/logs/$CHECK_ID.app.log" 2>&1 &
  wait_title "$(basename "$1" | sed 's/[.[\*^$]/\\&/g') — SoloMD" 15
}

# Fresh vault + profile, launch on FILE (relative to the vault).
# Usage: start_on FILE   (empty → no file argument)
start_on() {
  vault_reset
  profile_reset
  if [ -n "${1:-}" ]; then
    app_launch "$VAULT/$1" || return 1
    wait_title "$(basename "$1" | sed 's/[.[\*^$]/\\&/g') — SoloMD" 20 || { log "title never showed $1"; return 1; }
  else
    app_launch || return 1
  fi
  sleep 0.5
}

# Click into the editor body (safe spot: right half, a bit below the top of
# the document) — used when a check needs focus in the editor explicitly.
click_editor() { click "${1:-900}" "${2:-500}"; }
