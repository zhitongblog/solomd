#!/usr/bin/env bash
# In-box part of the SoloMD Linux regression suite. Runs on the Linux machine
# itself (the Lima VM, or a GitHub Actions ubuntu runner under Xvfb).
#
#   vm-suite.sh all  [CHECK…]   rig up → install → run checks → report → rig down
#   vm-suite.sh up               start the rig only (Xvfb, openbox, dbus)
#   vm-suite.sh run  [CHECK…]    run checks against an already-up rig
#   vm-suite.sh down             stop everything this suite started
#   vm-suite.sh exec 'CMD'       run a shell snippet with the helpers loaded
#   vm-suite.sh deps             apt-install whatever tools are missing
#
# CHECK is a file name prefix under checks/ (e.g. L04 or L04-type-save).
# Environment knobs (all optional):
#   SOLOMD_DEB=/path/x.deb        install with dpkg before running
#   SOLOMD_APPIMAGE=/path/x.AppImage  used by the AppImage check
#   SOLOMD_BIN=/usr/bin/SoloMD    binary under test
#   RG_ROOT=/tmp/rg2  RG_DISPLAY=:94  CHECK_TIMEOUT=240
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RG_SUITE="$HERE"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/app.sh
. "$HERE/lib/app.sh"
# shellcheck source=lib/fixtures.sh
. "$HERE/lib/fixtures.sh"

# The tag must be stable across sub-invocations (up / run / down) of one rig.
if [ -f "$RG_ROOT/tag" ]; then SOLOMD_REGRESS_TAG=$(cat "$RG_ROOT/tag"); export SOLOMD_REGRESS_TAG; fi

need_tools() {
  local missing=() t
  for t in Xvfb openbox xdotool xclip import convert compare tesseract pdftotext pdffonts \
    dbus-daemon xdpyinfo xterm python3 iconv file unzip; do
    command -v "$t" >/dev/null || missing+=("$t")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    log "missing tools: ${missing[*]}"
    log "apt install: xvfb openbox xdotool xclip imagemagick tesseract-ocr tesseract-ocr-chi-sim poppler-utils dbus-x11 x11-utils xterm python3 unzip file"
    return 1
  fi
}

APT_PKGS="xvfb openbox xdotool xclip imagemagick tesseract-ocr tesseract-ocr-chi-sim poppler-utils dbus-x11 x11-utils xterm python3 unzip file fonts-noto-cjk"
cmd_deps() {
  local missing=0
  need_tools >/dev/null 2>&1 || missing=1
  tesseract --list-langs 2>/dev/null | grep -qx chi_sim || missing=1
  [ $missing = 0 ] && { log "all tools present"; return 0; }
  log "installing: $APT_PKGS"
  sudo -n apt-get update -q >/dev/null 2>&1
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -q $APT_PKGS >/dev/null 2>&1 || true
  need_tools
}

install_deb() {
  [ -n "${SOLOMD_DEB:-}" ] || return 0
  log "installing $SOLOMD_DEB"
  if ! sudo -n dpkg -i "$SOLOMD_DEB" >"$RG_OUT/logs/dpkg.log" 2>&1; then
    sudo -n apt-get -y -f install >>"$RG_OUT/logs/dpkg.log" 2>&1 || { log "dpkg failed (see logs/dpkg.log)"; return 1; }
  fi
  { basename "$SOLOMD_DEB"; sha256sum "$SOLOMD_DEB" | cut -c1-16; } | tr '\n' ' ' >"$RG_OUT/build.txt"
  dpkg-deb -f "$SOLOMD_DEB" Package Version | tr '\n' ' ' >>"$RG_OUT/build.txt"
  echo >>"$RG_OUT/build.txt"
  md5sum "$SOLOMD_BIN" >>"$RG_OUT/build.txt"
}

cmd_up() {
  mkdir -p "$RG_ROOT" "$RG_OUT/logs" "$RG_OUT/results" "$SHOTS"
  [ -f "$RG_ROOT/tag" ] || echo "rg2-$(date +%s)-$$" >"$RG_ROOT/tag"
  SOLOMD_REGRESS_TAG=$(cat "$RG_ROOT/tag"); export SOLOMD_REGRESS_TAG
  need_tools || return 1
  rig_up
}

cmd_down() {
  rig_env
  rig_down
  rm -f "$RG_ROOT/tag"
}

list_checks() {
  local f
  if [ $# -eq 0 ]; then
    ls "$HERE"/checks/*.sh | sort
  else
    for p in "$@"; do ls "$HERE"/checks/"$p"*.sh 2>/dev/null | sort; done
  fi
}

# Runs one check in its own process group with a timeout. A check that dies,
# hangs or leaves the app running never affects the next one.
run_check() {
  local f="$1" id; id=$(basename "$f" .sh)
  rm -f "$RG_OUT/results/$id".*
  log "=== $id"
  local t0=$SECONDS
  CHECK_ID="$id" timeout --kill-after=10 "${CHECK_TIMEOUT:-240}" \
    bash -c '
      set -u
      . "$RG_SUITE/lib/common.sh"; . "$RG_SUITE/lib/app.sh"; . "$RG_SUITE/lib/fixtures.sh"
      rig_env
      . "$1"
    ' _ "$f" >>"$RG_OUT/logs/$id.log" 2>&1
  local rc=$?
  local status; status=$(cat "$RG_OUT/results/$id.status" 2>/dev/null)
  if [ -z "$status" ]; then
    status=FAIL
    if [ $rc -ge 124 ]; then echo "check timed out / was killed (rc=$rc)" >"$RG_OUT/results/$id.summary"
    else echo "check ended without a verdict (rc=$rc), see logs/$id.log" >"$RG_OUT/results/$id.summary"; fi
    echo FAIL >"$RG_OUT/results/$id.status"
  fi
  echo $((SECONDS - t0)) >"$RG_OUT/results/$id.secs"
  # never let one check's app leak into the next
  CHECK_ID="$id" app_kill
  for p in $(our_pids); do
    case "$(cat /proc/$p/comm 2>/dev/null)" in xclip|xterm) kill "$p" 2>/dev/null ;; esac
  done
  log "    $status ($(cat "$RG_OUT/results/$id.secs")s) $(cat "$RG_OUT/results/$id.summary" 2>/dev/null)"
}

report() {
  python3 "$HERE/lib/report.py" "$RG_OUT"
}

cmd_run() {
  rig_env
  mkdir -p "$RG_OUT/logs" "$RG_OUT/results" "$SHOTS"
  local f
  for f in $(list_checks "$@"); do run_check "$f"; done
  report
}

case "${1:-all}" in
  deps) shift; cmd_deps ;;
  up) shift; cmd_up ;;
  down) shift; cmd_down ;;
  run) shift; cmd_run "$@" ;;
  exec) shift; rig_env; CHECK_ID="${CHECK_ID:-exec}"; mkdir -p "$RG_OUT/logs" "$RG_OUT/results"; eval "$*" ;;
  all)
    shift
    [ -f "$RG_ROOT/tag" ] && cmd_down     # a rig left over from an earlier run
    rm -rf "$RG_OUT"; mkdir -p "$RG_OUT/logs" "$RG_OUT/results" "$SHOTS"
    cmd_up || { log "rig failed"; exit 2; }
    install_deb || { cmd_down; exit 2; }
    cmd_run "$@"
    rc=$?
    cmd_down
    exit $rc
    ;;
  *) sed -n 2,20p "$0"; exit 2 ;;
esac
