# Shared helpers for the Android regression suite. Sourced by run.sh; every
# check file under checks/ is sourced into the same shell, so these are all
# available there.
#
# Conventions
#   ADB           adb pinned to the device under test ($SERIAL)
#   OUT           this run's output dir (shots/, ui/, logs)
#   PKG           app.solomd
#   pass "detail" / fail "detail"   end a check (exactly one per check)
#   note "text"   extra line in the log for this check
#
# All element lookups go through a fresh `uiautomator dump`, and coordinates
# come from the dump's bounds — never from guesses. The WebView builds its
# accessibility tree lazily: the first dump after a navigation often shows the
# WebView as one opaque node, so `dump` retries until the tree has children.

PKG="${PKG:-app.solomd}"
ADB=adb_
adb_() { adb -s "$SERIAL" "$@"; }
UI_PY="$SUITE/lib/ui.py"
DUMP="$OUT/ui/last.xml"

log()  { printf '   %s\n' "$*" >&2; }
note() { CHECK_NOTES+=("$*"); log "$*"; }

# ---- device ---------------------------------------------------------------

sh_() { $ADB shell "$@" | tr -d '\r'; }

screen_size() {           # prints "W H" of the current orientation
  local s; s=$(sh_ dumpsys window displays | grep -m1 -oE 'cur=[0-9]+x[0-9]+' | cut -d= -f2)
  echo "${s%x*} ${s#*x}"
}

status_bar_bottom() {     # px height of the status bar (top inset)
  # dumpsys window has "statusBars ... frame=[0,0][1080,136]" on API 30+.
  local v
  v=$(sh_ dumpsys window | grep -m1 -oE 'type=statusBars frame=\[0,0\]\[[0-9]+,[0-9]+\]' | grep -oE ',[0-9]+\]$' | tr -d ',]')
  echo "${v:-0}"
}

foreground_pkg() {
  sh_ dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' \
    | grep -oE '[a-zA-Z0-9_.]+/[a-zA-Z0-9_.$]+' | head -1 | cut -d/ -f1
}

app_pid() { sh_ pidof "$PKG"; }

launch_app() {
  sh_ am start -W -n "$PKG/.MainActivity" >/dev/null
  wait_for 'webview' 40 || true
}

force_stop() { sh_ am force-stop "$PKG"; }

# ---- screenshots ----------------------------------------------------------

shot() {                  # shot NAME  -> $OUT/shots/NAME.png, echoes the path
  local f="$OUT/shots/$1.png"
  $ADB exec-out screencap -p > "$f" 2>/dev/null
  SHOTS+=("$1.png")
  echo "$f"
}

# ---- UI tree --------------------------------------------------------------

dump() {                  # refresh $DUMP; retries until the WebView tree is built
  local i n
  for i in 1 2 3 4 5; do
    $ADB shell uiautomator dump /sdcard/rg-ui.xml >/dev/null 2>&1
    $ADB pull /sdcard/rg-ui.xml "$DUMP" >/dev/null 2>&1 || { sleep 1; continue; }
    # A foreign window (picker, settings) has no WebView: accept it as is.
    if ! grep -q 'android.webkit.WebView' "$DUMP"; then return 0; fi
    n=$(python3 "$UI_PY" webview-nodes "$DUMP" 2>/dev/null || echo 0)
    [ "${n:-0}" -gt 3 ] && return 0
    sleep 1
  done
  return 0
}

ui()       { python3 "$UI_PY" "$@"; }
# find REGEX [ui.py options]  -> "cx cy x0 y0 x1 y1" from the CURRENT dump
find_el()  { ui find "$DUMP" "$@"; }
has()      { [ "$(ui count "$DUMP" "$@")" -gt 0 ]; }

# wait_for REGEX SECONDS [ui.py options]   (special: 'webview' = app tree ready)
wait_for() {
  local rx="$1" t="${2:-15}"; shift 2 || true
  local end=$(( $(date +%s) + t ))
  while [ "$(date +%s)" -le "$end" ]; do
    dump
    if [ "$rx" = webview ]; then
      [ "$(ui webview-nodes "$DUMP")" -gt 3 ] && return 0
    elif has "$rx" "$@"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

tap_xy() { sh_ input tap "$1" "$2"; }

# tap REGEX [ui.py options] — dumps, taps the centre of the match. Fails if absent.
tap() {
  dump
  local c; c=$(find_el "$@") || { log "tap: no element matching '$1'"; return 1; }
  set -- $c
  tap_xy "$1" "$2"
  sleep "${TAP_SETTLE:-1}"
}

# type_ascii TEXT — adb input text; spaces become %s. ASCII only.
type_ascii() {
  local s="${1// /%s}"
  # single-quoted for the device shell, so # ; & ( ) reach `input` intact
  sh_ input text "'$s'"
}

key() { sh_ input keyevent "$@"; }

# ---- results --------------------------------------------------------------

pass() { CHECK_STATUS=PASS; CHECK_DETAIL="$*"; }
fail() { CHECK_STATUS=FAIL; CHECK_DETAIL="$*"; }

# element bounds as "x0 y0 x1 y1" for every match in the current dump
bounds_all() { ui bounds-all "$DUMP" "$@"; }

# all_on_screen REGEX… : every match must lie within the screen (margin 0)
all_on_screen() {
  local w h; read -r w h < <(screen_size)
  local bad=0 line
  while read -r line; do
    [ -z "$line" ] && continue
    set -- $line
    if [ "$1" -lt 0 ] || [ "$2" -lt 0 ] || [ "$3" -gt "$w" ] || [ "$4" -gt "$h" ]; then
      log "off-screen: $line (screen ${w}x${h})"; bad=1
    fi
  done
  return $bad
}

# ---- UI vocabulary (English or Chinese UI) --------------------------------
RX_NOTES='^(Notes|笔记)$'
RX_SEARCH='^(Search|搜索)$'
RX_SETTINGS='^(Settings|设置)$'
RX_NEWNOTE='^(New note|新建笔记)$'
RX_OPENFOLDER='^(Open Folder…|打开文件夹…)$'
RX_MORE='^(More|更多)$'
RX_SAVE='^(Save|保存)$'
RX_DARK='^(✓ )?(Dark mode|深色模式)$'
RX_LIVE='^(✓ )?(Live|实时)$'
RX_SOURCE='^(✓ )?(Source|源码)$'
RX_PREVIEW='^(✓ )?(Preview|预览)$'
RX_GOTIT='^(Got it|我知道了)$'
RX_BASICS='^(Basics|基础)$'
# shortcut hints that have no business on a phone
RX_HINT='Ctrl|⌘|⌥|⇧|Shift\+|Alt\+|\bEsc\b|↑↓|↵'

# ---- app navigation -------------------------------------------------------
H_BOTTOM_MIN=1900          # y above which the bottom bar lives (portrait 2400px)

in_editor() { dump; has "$RX_NOTES" --class Button --within 0,450 && has "$RX_MORE" --class Button; }
on_home()   { dump; has "$RX_NOTES" --class TextView --within 0,450; }

dismiss_banner() { dump; has "$RX_GOTIT" && tap "$RX_GOTIT"; return 0; }

keyboard_shown() { sh_ dumpsys input_method | grep -q 'mInputShown=true'; }
hide_keyboard() { keyboard_shown && key KEYCODE_BACK && sleep 1; return 0; }

# header back button (editor -> home)
go_home() {
  on_home && return 0
  tap "$RX_NOTES" --class Button --within 0,450 || return 1
  on_home
}

# open_note NAME — tap the note in the home list and land in the editor
open_note() {
  go_home
  tap "^$1\$" --class TextView || return 1
  sleep 1
  in_editor && return 0
  # Known bug (A14): tapping the note that is already the active tab does
  # nothing on the phone. Work around it so later checks still run: open some
  # other note, come back, then tap the wanted one.
  local other; for other in alpha beta; do
    [ "$other" = "$1" ] && continue
    tap "^$other\$" --class TextView && sleep 1 && go_home && tap "^$1\$" --class TextView && sleep 1
    break
  done
  in_editor
}

open_more()  { hide_keyboard; tap "$RX_MORE" --class Button; }
# menu_pick REGEX — open More and tap the menu item
menu_pick()  { open_more || return 1; tap "$1" --class MenuItem; }
close_more() { dump; has '' --class MenuItem && tap "$RX_MORE" --class Button; return 0; }

# mean luminance (0-255) of the content area of a screenshot
luma() { python3 - "$1" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('L')
w, h = im.size
im = im.crop((0, int(h * .15), w, int(h * .85))).resize((108, 168))
d = list(im.getdata()) if not hasattr(im, 'get_flattened_data') else list(im.get_flattened_data())
print(int(sum(d) / len(d)))
PY
}

# push the fixture vault to the device
push_fixtures() {
  local d; d=$(mktemp -d)
  printf '# Alpha\n\nalpha body line with zebracorn token.\n\n- item one\n- item two\n' > "$d/alpha.md"
  printf '# Beta\n\nSecond note, **bold** text.\n' > "$d/beta.md"
  sh_ rm -rf "$REMOTE_DIR"
  sh_ mkdir -p "$REMOTE_DIR"
  $ADB push "$d/alpha.md" "$d/beta.md" "$REMOTE_DIR/" >/dev/null
  rm -rf "$d"
}
