#!/usr/bin/env bash
# SoloMD Android regression suite (checklist column A rows L8/L9 + the 5.0
# phone shell). Drives a RELEASE build on an emulator or phone with adb only:
# input tap/text/keyevent, `uiautomator dump` for element bounds, screencap.
#
#   scripts/regress/android/run.sh [options] [CHECK…]
#
#   CHECK…                 run only checks whose file name contains one of these
#                          (e.g. `run.sh A01 saf`); A00 (install) always runs
#   --apk PATH             APK to install (default: the newest universal or
#                          arm64 release APK under gen/android/app/build/outputs)
#   --no-install           test whatever app.solomd is installed (skips A00's
#                          md5 / time-chain proof — results say so)
#   --avd NAME             start this AVD if no device is attached and stop it
#                          again at the end (default: Pixel7)
#   --keep-emulator        leave an emulator this script started running
#   --serial SERIAL        device to use (default: the only attached one)
#
# Environment: OUT_DIR (default /tmp/solomd-regress-android/<timestamp>),
#              RG_REMOTE_DIR (default /sdcard/Documents/SoloRegress).
#
# Output: PASS/FAIL table on stdout, $OUT_DIR/results.json, screenshots in
# $OUT_DIR/shots/, last UI dump per check in $OUT_DIR/ui/.
# Exit: 0 all passed, 1 some check failed, 2 setup failed.
#
# The run WIPES app data (pm clear / uninstall) so it starts from first launch.
# Device settings it changes (rotation, density, font scale, dark mode) are put
# back at the end even when a check fails.
set -uo pipefail

SUITE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SUITE/../../.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT_DIR:-/tmp/solomd-regress-android/$TS}"
REMOTE_DIR="${RG_REMOTE_DIR:-/sdcard/Documents/SoloRegress}"
APK=""; INSTALL=1; AVD="Pixel7"; KEEP_EMU=0; SERIAL="${SERIAL:-}"
FILTERS=()

usage() { sed -n 2,27p "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    --avd) AVD="$2"; shift 2 ;;
    --keep-emulator) KEEP_EMU=1; shift ;;
    --serial) SERIAL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) FILTERS+=("$1"); shift ;;
  esac
done

mkdir -p "$OUT/shots" "$OUT/ui" "$OUT/logs"
: > "$OUT/logs/run.log"
exec > >(tee -a "$OUT/logs/run.log") 2>&1

# ---- device ---------------------------------------------------------------
EMU_PID=""
if [ -z "$SERIAL" ]; then
  SERIAL=$(adb devices | awk 'NR>1 && $2=="device"{print $1}' | head -1)
fi
if [ -z "$SERIAL" ]; then
  command -v emulator >/dev/null || { echo "no device and no emulator binary" >&2; exit 2; }
  echo ">> starting AVD $AVD"
  emulator -avd "$AVD" -no-snapshot-load -no-audio >"$OUT/logs/emulator.log" 2>&1 &
  EMU_PID=$!
  adb wait-for-device
  SERIAL=$(adb devices | awk 'NR>1 && $2=="device"{print $1}' | head -1)
fi
for _ in $(seq 120); do
  [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 2
done
export SERIAL
# shellcheck source=lib/common.sh
source "$SUITE/lib/common.sh"
echo ">> device $SERIAL  ($(sh_ getprop ro.product.model), Android $(sh_ getprop ro.build.version.release))"

# ---- remember device settings we touch ------------------------------------
ORIG_ACCEL=$(sh_ settings get system accelerometer_rotation)
ORIG_ROT=$(sh_ settings get system user_rotation)
ORIG_FONT=$(sh_ settings get system font_scale)
ORIG_NIGHT=$(sh_ cmd uimode night | awk '{print $NF}')
restore_device() {
  sh_ wm density reset >/dev/null
  sh_ settings put system font_scale "${ORIG_FONT:-1.0}"
  sh_ settings put system user_rotation "${ORIG_ROT:-0}"
  sh_ settings put system accelerometer_rotation "${ORIG_ACCEL:-1}"
  [ -n "$ORIG_NIGHT" ] && sh_ cmd uimode night "$ORIG_NIGHT" >/dev/null 2>&1
}
cleanup() {
  restore_device
  if [ -n "$EMU_PID" ] && [ "$KEEP_EMU" -eq 0 ]; then
    echo ">> stopping the emulator this run started"
    adb -s "$SERIAL" emu kill >/dev/null 2>&1 || kill "$EMU_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

# Start from a known device state.
sh_ settings put system accelerometer_rotation 0
sh_ settings put system user_rotation 0
sh_ wm density reset >/dev/null
sh_ settings put system font_scale 1.0
sh_ cmd uimode night no >/dev/null 2>&1
sh_ input keyevent KEYCODE_WAKEUP; sh_ wm dismiss-keyguard >/dev/null 2>&1

# ---- APK ------------------------------------------------------------------
OUTPUTS="$REPO/app/src-tauri/gen/android/app/build/outputs/apk"
if [ "$INSTALL" -eq 1 ] && [ -z "$APK" ]; then
  # arm64-v8a split first (what most phones get), then the fat universal one.
  APK=$(ls -t "$OUTPUTS"/*/release/*arm64-v8a-release.apk 2>/dev/null | head -1)
  [ -n "$APK" ] || APK=$(ls -t "$OUTPUTS"/*/release/*universal-release.apk 2>/dev/null | head -1)
  [ -n "$APK" ] || { echo "no release APK under $OUTPUTS (build with scripts/build-android.sh)" >&2; exit 2; }
fi
export APK INSTALL REPO REMOTE_DIR

# ---- run checks -----------------------------------------------------------
RESULTS="$OUT/results.tsv"; : > "$RESULTS"
ALL=()
for f in "$SUITE"/checks/*.sh; do ALL+=("$f"); done
selected() {
  local base; base=$(basename "$1")
  [[ "$base" == A00-* ]] && return 0
  [ ${#FILTERS[@]} -eq 0 ] && return 0
  local f; for f in "${FILTERS[@]}"; do [[ "$base" == *"$f"* ]] && return 0; done
  return 1
}

for f in "${ALL[@]}"; do
  selected "$f" || continue
  id=$(basename "$f" .sh)
  title=$(sed -n 's/^# title: //p' "$f" | head -1)
  row=$(sed -n 's/^# row: //p' "$f" | head -1)
  echo
  echo "== $id  $title"
  CHECK_STATUS=FAIL; CHECK_DETAIL="check did not report"; CHECK_NOTES=(); SHOTS=()
  DUMP="$OUT/ui/$id.xml"
  t0=$(date +%s)
  # shellcheck disable=SC1090
  source "$f"
  if declare -f run_check >/dev/null; then run_check; unset -f run_check; fi
  dt=$(( $(date +%s) - t0 ))
  shots_joined=$(IFS=,; echo "${SHOTS[*]:-}")
  notes_joined=$(printf '%s | ' "${CHECK_NOTES[@]:-}"); notes_joined=${notes_joined% | }
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$CHECK_STATUS" "$dt" "$row" "$title" \
    "$CHECK_DETAIL" "$shots_joined" "$notes_joined" >> "$RESULTS"
  echo "   -> $CHECK_STATUS  $CHECK_DETAIL"
  # A00 failing means we are not testing the build we think we are.
  if [[ "$id" == A00-* ]] && [ "$CHECK_STATUS" = FAIL ] && [ "$INSTALL" -eq 1 ]; then
    echo "A00 failed — refusing to run the behavioural checks against an unverified install" >&2
    python3 "$SUITE/lib/report.py" "$RESULTS" "$OUT/results.json" "$APK" "$SERIAL"
    exit 2
  fi
done

python3 "$SUITE/lib/report.py" "$RESULTS" "$OUT/results.json" "${APK:-installed}" "$SERIAL"
rc=$?
echo ">> results: $OUT/results.json   shots: $OUT/shots/   dumps: $OUT/ui/"
exit $rc
