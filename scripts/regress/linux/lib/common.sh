# shellcheck shell=bash
# Shared helpers for the Linux regression suite. Sourced by vm-suite.sh and by
# every check. Runs INSIDE the Linux box (Lima VM or a CI runner), never on
# the Mac.
#
# Everything the suite starts carries SOLOMD_REGRESS_TAG in its environment,
# so cleanup can find (and kill) exactly our processes and nothing else.

: "${RG_ROOT:=/tmp/rg2}"                 # work dir (vault, profile, exports, out)
: "${RG_DISPLAY:=:94}"                   # private X display
: "${RG_SCREEN:=1440x900x24}"
: "${SOLOMD_BIN:=/usr/bin/SoloMD}"       # app under test
: "${SOLOMD_REGRESS_TAG:=rg2-$$}"
: "${RG_OUT:=$RG_ROOT/out}"
: "${RG_SUITE:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export RG_ROOT RG_DISPLAY SOLOMD_BIN SOLOMD_REGRESS_TAG RG_OUT RG_SUITE

VAULT="$RG_ROOT/vault"
EXP="$RG_ROOT/exp"
PROFILE_HOME="$RG_ROOT/home"            # HOME for the app → fresh, private profile
LS_DIR="$PROFILE_HOME/.local/share/app.solomd/localstorage"
LS_DB="$LS_DIR/tauri_localhost_0.localstorage"
SHOTS="$RG_OUT/shots"
mkdir -p "$RG_OUT" "$SHOTS"

# Current check id (set by run_check); used to prefix screenshots.
CHECK_ID="${CHECK_ID:-misc}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

# ---------------------------------------------------------------- rig env ---
rig_env() {
  export DISPLAY="$RG_DISPLAY"
  # shellcheck disable=SC1091
  [ -f "$RG_ROOT/rig.env" ] && . "$RG_ROOT/rig.env"
}

# ------------------------------------------------------------- processes ---
# PIDs whose environment carries our tag (the app, its WebKit children,
# xclip, xterm … everything we launched through app_env/rg_spawn).
our_pids() {
  local p
  for p in /proc/[0-9]*; do
    [ -r "$p/environ" ] || continue
    if tr '\0' '\n' <"$p/environ" 2>/dev/null | grep -qx "SOLOMD_REGRESS_TAG=$SOLOMD_REGRESS_TAG"; then
      echo "${p#/proc/}"
    fi
  done
}

# PIDs of app processes (SoloMD / WebKit helpers / AppImage runtime) we own.
our_app_pids() {
  local p c
  for p in $(our_pids); do
    c=$(cat "/proc/$p/comm" 2>/dev/null) || continue
    case "$c" in
      SoloMD*|solomd*|WebKit*|AppRun*|*.AppImage) echo "$p" ;;
    esac
  done
}

# Run something with the app's private environment (HOME, dbus, tag).
app_env() {
  env DISPLAY="$RG_DISPLAY" HOME="$PROFILE_HOME" \
    XDG_DATA_HOME="$PROFILE_HOME/.local/share" XDG_CONFIG_HOME="$PROFILE_HOME/.config" \
    XDG_CACHE_HOME="$PROFILE_HOME/.cache" XDG_STATE_HOME="$PROFILE_HOME/.local/state" \
    DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
    NO_AT_BRIDGE=1 GTK_A11Y=none LANG="${RG_LANG:-en_US.UTF-8}" \
    SOLOMD_REGRESS_TAG="$SOLOMD_REGRESS_TAG" "$@"
}

# Background helper process tagged as ours (xterm, xclip …).
rg_spawn() { app_env "$@" >/dev/null 2>&1 & echo $!; }

# ------------------------------------------------------------------ input ---
# key CHORD…  — each chord is held 0.15 s (keydown, sleep, keyup), then 0.35 s
# gap. Holding like a person does is what exposed the GTK double-fire bugs.
key() {
  local x
  for x in "$@"; do
    xdotool keydown "$x" sleep 0.15 keyup "$x"
    sleep 0.35
  done
}
# quick tap without the hold (for timing-sensitive checks)
tap() { xdotool key --delay 30 "$@"; }

# typ TEXT — real XTEST typing (unicode works via keysym remap).
typ() {
  local f="$RG_ROOT/.type.txt"
  printf '%s' "$1" >"$f"
  xdotool type --delay "${TYPE_DELAY:-35}" --file "$f"
  sleep 0.2
}

click() { xdotool mousemove "$1" "$2" sleep 0.15 click "${3:-1}"; sleep 0.3; }
rclick() { click "$1" "$2" 3; }

# ---------------------------------------------------------------- windows ---
main_pid() { cat "$RG_ROOT/app.pid" 2>/dev/null; }

# Visible windows titled like ours. Prints window ids.
app_windows() {
  xdotool search --onlyvisible --name 'SoloMD' 2>/dev/null | while read -r w; do
    local pid; pid=$(xdotool getwindowpid "$w" 2>/dev/null) || continue
    if our_pids | grep -qx "$pid"; then echo "$w"; fi
  done
}

active_title() { xdotool getactivewindow getwindowname 2>/dev/null; }

# Title of the main window (first visible window of the main pid that is not
# Quick Capture).
main_window() {
  local w
  for w in $(app_windows); do
    case "$(xdotool getwindowname "$w")" in *"Quick Capture"*) continue ;; esac
    echo "$w"; return 0
  done
  return 1
}
main_title() { local w; w=$(main_window) && xdotool getwindowname "$w"; }

focus_main() {
  local w; w=$(main_window) || return 1
  xdotool windowactivate --sync "$w" 2>/dev/null || xdotool windowfocus "$w"
  sleep 0.4
}

# wait_title REGEX [timeout_s] — main window title matches.
wait_title() {
  local re="$1" t="${2:-15}" i
  for ((i = 0; i < t * 4; i++)); do
    if main_title | grep -Eq -- "$re"; then return 0; fi
    sleep 0.25
  done
  return 1
}

# wait_window NAME_REGEX [timeout] → prints window id (any client, our pids).
wait_window() {
  local re="$1" t="${2:-15}" i w
  for ((i = 0; i < t * 4; i++)); do
    for w in $(xdotool search --onlyvisible --name "$re" 2>/dev/null); do
      echo "$w"; return 0
    done
    sleep 0.25
  done
  return 1
}

# ----------------------------------------------------------- screenshots ---
# shot NAME → $SHOTS/<check>-<name>.png ; prints the path
shot() {
  local f="$SHOTS/${CHECK_ID}-$1.png"
  import -window root "$f" 2>/dev/null || xwd -root -silent | convert xwd:- "$f"
  echo "$f"
}
shot_quiet() { shot "$@" >/dev/null; }

# crop SRC WxH+X+Y DST
crop() { convert "$1" -crop "$2" +repage "$3"; }

# img_diff A B → number of differing pixels (fuzz 8%)
img_diff() { compare -metric AE -fuzz 8% "$1" "$2" null: 2>&1 | awk '{print int($1)}'; }

# colours in an image (blank-screen detector)
img_colors() { convert "$1" -format '%k' info: 2>/dev/null; }

# ------------------------------------------------------------------- OCR ---
# ocr [IMAGE] [lang]  → text of the whole image (2× upscale helps tesseract)
ocr() {
  local img="${1:-}" lang="${2:-eng}"
  [ -n "$img" ] || img=$(shot "ocr-$(date +%s%N)")
  python3 "$RG_SUITE/lib/ocr.py" text "$img" "$lang"
}
# ocr_has PHRASE [IMAGE] [lang] — case-insensitive, whitespace-tolerant
ocr_has() {
  local img="${2:-}" lang="${3:-eng}"
  [ -n "$img" ] || img=$(shot "ocr-$(date +%s%N)")
  python3 "$RG_SUITE/lib/ocr.py" has "$img" "$lang" "$1" "${4:-}"
}
# ocr_hasf PHRASE IMAGE [lang] [region] — fuzzy (1–2 glyph errors), for CJK
ocr_hasf() { python3 "$RG_SUITE/lib/ocr.py" hasf "$2" "${3:-chi_sim}" "$1" "${4:-}"; }
# ocr_line IMAGE REGION → single-line OCR of a tight crop (counters like 1/59)
ocr_line() {
  local t="$RG_ROOT/.line.png"
  convert "$1" -crop "$2" +repage -colorspace Gray -resize 400% "$t"
  tesseract "$t" - --psm 7 2>/dev/null | tr -d '\f' | head -1
}
# ocr_find PHRASE [IMAGE] [lang] [region WxH+X+Y] → "X Y" centre of phrase
ocr_find() {
  local img="${2:-}" lang="${3:-eng}" region="${4:-}"
  [ -n "$img" ] || img=$(shot "ocr-$(date +%s%N)")
  python3 "$RG_SUITE/lib/ocr.py" find "$img" "$lang" "$1" "$region"
}
# ocr_click PHRASE [button] [lang] [region] — screenshot, find, click.
ocr_click() {
  local xy img
  img=$(shot "click-$(date +%s%N)")
  xy=$(ocr_find "$1" "$img" "${3:-eng}" "${4:-}") || { rm -f "$img"; return 1; }
  rm -f "$img"
  # shellcheck disable=SC2086
  click $xy "${2:-1}"
}
# wait_ocr PHRASE [timeout] [lang] [region] — poll screen until phrase shows.
wait_ocr() {
  local t="${2:-10}" end img
  end=$((SECONDS + t))
  while [ $SECONDS -le $end ]; do
    img="$RG_ROOT/.wait.png"
    import -window root "$img" 2>/dev/null
    [ -n "${4:-}" ] && convert "$img" -crop "$4" +repage "$img"
    if python3 "$RG_SUITE/lib/ocr.py" has "$img" "${3:-eng}" "$1"; then return 0; fi
    sleep 0.5
  done
  return 1
}

# ------------------------------------------------------------- clipboard ---
clip_get() { timeout 3 xclip -selection clipboard -o ${1:+-t "$1"} 2>/dev/null; }
clip_targets() { timeout 3 xclip -selection clipboard -t TARGETS -o 2>/dev/null; }
clip_clear() { printf '' | rg_spawn_clip text/plain; }
# put a file on the clipboard with a mime type (xclip stays as owner, tagged)
clip_put_file() { # FILE MIME
  app_env xclip -selection clipboard -t "$2" -i "$1" >/dev/null 2>&1 &
  sleep 0.5
}

# Editor contents through the clipboard: Ctrl+A, Ctrl+C, then collapse the
# selection with End (Ctrl+End). Only use where moving the caret to the end
# does not matter.
editor_text() {
  printf 'RG-CLIP-SENTINEL' | app_env xclip -selection clipboard -i >/dev/null 2>&1
  sleep 0.2
  key ctrl+a ctrl+c
  sleep 0.4
  clip_get
  key ctrl+End
}

# ------------------------------------------------------------ localStorage ---
# ls_get KEY → value (decoded) from the app profile, app must be stopped
ls_get() { python3 "$RG_SUITE/lib/ls.py" get "$LS_DB" "$1"; }
# ls_json KEY PYEXPR → evaluates PYEXPR with v = parsed JSON value
ls_json() { python3 "$RG_SUITE/lib/ls.py" json "$LS_DB" "$1" "$2"; }

# ---------------------------------------------------------------- results ---
# A check prints evidence with note(), and ends with pass / fail / skip.
note() { echo "$*" >>"$RG_OUT/results/$CHECK_ID.notes"; log "  $*"; }
_result() {
  local status="$1"; shift
  printf '%s\n' "$status" >"$RG_OUT/results/$CHECK_ID.status"
  [ $# -gt 0 ] && printf '%s\n' "$*" >"$RG_OUT/results/$CHECK_ID.summary"
}
pass() { _result PASS "$@"; exit 0; }
fail() { _result FAIL "$@"; exit 1; }
skip() { _result SKIP "$@"; exit 0; }
# soft assertion: records a failure but lets the check continue
FAILS=()
expect() { # DESC CMD…
  local d="$1"; shift
  if "$@"; then note "ok: $d"; else note "FAILED: $d"; FAILS+=("$d"); fi
}
finish() { # SUMMARY
  if [ ${#FAILS[@]} -eq 0 ]; then pass "$1"; else fail "$(printf '%s; ' "${FAILS[@]}" | sed 's/; $//')"; fi
}

# ------------------------------------------------------------ GTK dialogs ---
# Any visible window that is not one of the app's own top-level windows.
# gtk_wait REGEX [timeout] → window id of a dialog whose title matches.
gtk_wait() { # newest matching window wins (ids grow)
  local i w
  for ((i = 0; i < ${2:-15} * 4; i++)); do
    w=$(xdotool search --onlyvisible --name "$1" 2>/dev/null | sort -n | tail -1)
    [ -n "$w" ] && { echo "$w"; return 0; }
    sleep 0.25
  done
  return 1
}
# Give a dialog real keyboard focus: activate it, then click its title bar
# (openbox focuses on a frame click; _NET_ACTIVE_WINDOW alone sometimes
# leaves the keyboard in the parent window while the dialog is mapping).
gtk_focus() {
  local x y w h
  xdotool windowactivate --sync "$1" 2>/dev/null
  read -r x y w h < <(win_geom "$1")
  [ -n "$h" ] || return 1
  xdotool mousemove $((x + w / 2)) $((y - 10)) sleep 0.1 click 1
  sleep 0.4
  [ "$(xdotool getactivewindow 2>/dev/null)" = "$1" ]
}
gtk_gone() { # WID [timeout]
  local i
  for ((i = 0; i < ${2:-10} * 4; i++)); do
    xdotool getwindowname "$1" >/dev/null 2>&1 || return 0
    xdotool search --onlyvisible --name . 2>/dev/null | grep -qx "$1" || return 0
    sleep 0.25
  done
  return 1
}
# gtk_save PATH [title-regex] — fill a GTK Save dialog's Name field with a full path
gtk_save() {
  local w try; w=$(gtk_wait "${2:-^(Save|Export|Print to|Save File)}" 20) || { log "no save dialog"; return 1; }
  for try in 1 2 3; do
    sleep 1
    gtk_focus "$w" || { log "could not focus dialog $w"; continue; }
    key ctrl+a; typ "$1"; sleep 0.5; key Return
    gtk_gone "$w" 8 && return 0
    log "save dialog still open after try $try"
  done
  return 1
}
# gtk_open PATH [title-regex] — type a path into a GTK Open/Select-folder dialog
gtk_open() {
  local w try; w=$(gtk_wait "${2:-^(Open|Select|Import|Choose)}" 20) || { log "no open dialog"; return 1; }
  for try in 1 2 3; do
    sleep 1
    gtk_focus "$w" || { log "could not focus dialog $w"; continue; }
    key ctrl+l; sleep 0.4; key ctrl+a; typ "$1"; sleep 0.8
    # GTK's location entry auto-completes inline (selected text); Delete drops it
    key Delete; sleep 0.2; key Return
    gtk_gone "$w" 8 && return 0
    log "open dialog still open after try $try"
  done
  return 1
}

# win_geom WID → "X Y W H"
win_geom() {
  xdotool getwindowgeometry --shell "$1" 2>/dev/null | awk -F= '/^X=/{x=$2}/^Y=/{y=$2}/^WIDTH=/{w=$2}/^HEIGHT=/{h=$2}END{print x, y, w, h}'
}
# win_corner WID W H → region string for the bottom-right W×H of the window
win_corner() {
  local x y w h; read -r x y w h < <(win_geom "$1")
  echo "${2}x${3}+$((x + w - $2))+$((y + h - $3))"
}
# win_region WID → region string of the whole window
win_region() {
  local x y w h; read -r x y w h < <(win_geom "$1")
  echo "${w}x${h}+${x}+${y}"
}

# gtk_print_to_file PDF — drive the GTK print dialog: Print to File → set the
# output path through the File button → Print.
gtk_print_to_file() {
  local out="$1" w
  w=$(gtk_wait '^Print$' 20) || { log "no print dialog"; return 1; }
  xdotool windowactivate --sync "$w" 2>/dev/null; sleep 0.8
  ocr_click "Print to File" 1 eng "$(win_region "$w")" || { log "no 'Print to File' printer"; return 1; }
  sleep 1
  # the File: button shows the current output path (e.g. /output.pdf)
  ocr_click "output.pdf" 1 eng "$(win_region "$w")" || { log "no output file button"; return 1; }
  gtk_save "$out" '^Select a filename' || return 1
  sleep 0.5
  xdotool windowactivate --sync "$w" 2>/dev/null; sleep 0.5
  ocr_click "Print" 1 eng "$(win_corner "$w" 220 70)" || { log "no Print button"; return 1; }
  gtk_gone "$w" 20
}

# palette TEXT — run a command through the command palette (Ctrl+Shift+K),
# fuzzy-matched on its English title.
palette() {
  focus_main
  key ctrl+shift+k; sleep 0.8
  typ "$1"; sleep 0.8
  key Return; sleep 0.8
}

# ------------------------------------------------------------ misc helpers ---
# away [secs] — give focus to another X client (an xterm we own) for a while,
# the way a user alt-tabs to another program.
AWAY_WIN=""
away() {
  if [ -z "$AWAY_WIN" ]; then
    rg_spawn xterm -geometry 40x4+1000+760 -T rg-away >/dev/null
    AWAY_WIN=$(wait_window '^rg-away$' 10)
  fi
  xdotool windowactivate --sync "$AWAY_WIN" 2>/dev/null
  sleep "${1:-2}"
}

# The "File Changed on Disk" dialog is on screen (screenshot saved as NAME).
file_changed_dialog() {
  local img; img=$(shot "$1")
  ocr_has "File Changed on Disk" "$img" eng || ocr_has "modified by another program" "$img" eng
}

# contains HAYSTACK NEEDLE
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# wait_file PATH [timeout] — exists and size stopped changing
wait_file() {
  local f="$1" t="${2:-20}" i s0=-1 s
  for ((i = 0; i < t * 2; i++)); do
    if [ -s "$f" ]; then
      s=$(stat -c %s "$f")
      [ "$s" = "$s0" ] && return 0
      s0=$s
    fi
    sleep 0.5
  done
  [ -s "$f" ]
}

# color_px IMAGE REGION HEX [fuzz%] → number of pixels of that colour
color_px() {
  convert "$1" -crop "$2" +repage -alpha off -fuzz "${4:-4}%" -fill '#FF00FE' -opaque "$3" \
    -fuzz 0 -fill black +opaque '#FF00FE' -fill white -opaque '#FF00FE' -colorspace Gray \
    -format '%[fx:int(mean*w*h+0.5)]' info: 2>/dev/null
}
# mermaid_px IMAGE [REGION] → lavender (#ECECFF) node-fill pixels of rendered mermaid
mermaid_px() { color_px "$1" "${2:-1180x800+260+95}" '#ECECFF' 3; }

# shot_when PHRASE NAME [timeout] [region] — wait (up to timeout) until PHRASE
# is readable on screen, then take the evidence screenshot. Popups and modals
# fade in; a shot taken mid-fade OCRs as nothing. Prints the screenshot path.
shot_when() {
  wait_ocr "$1" "${3:-6}" eng "${4:-}" || log "  '$1' not readable within ${3:-6}s"
  shot "$2"
}
