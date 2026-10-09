# The AppImage starts, renders, takes typing and quits fully.
[ -n "${SOLOMD_APPIMAGE:-}" ] && [ -f "$SOLOMD_APPIMAGE" ] || skip "SOLOMD_APPIMAGE not given"
chmod +x "$SOLOMD_APPIMAGE"
if [ ! -e /dev/fuse ] || ! command -v fusermount >/dev/null 2>&1; then
  export APPIMAGE_EXTRACT_AND_RUN=1; note "no FUSE: using APPIMAGE_EXTRACT_AND_RUN=1"
fi
mounts0=$(grep -c '\.mount_' /proc/mounts)
SOLOMD_BIN="$SOLOMD_APPIMAGE"
start_on plain.md || fail "AppImage: no painted window within ${LAUNCH_TIMEOUT:-45}s"
note "window process: $(readlink /proc/$(xdotool getwindowpid "$(main_window)")/exe)"
note "AppImage painted after ${LAUNCH_SECS}s"
shot launched >/dev/null
key ctrl+End; typ " APPIMG"
txt=$(editor_text)
expect "typing lands in the editor (clipboard read-back has APPIMG)" contains "$txt" "APPIMG"
expect "Ctrl+Q exits every process" app_quit 12
sleep 1
expect "no FUSE mount left behind" test "$(grep -c '\.mount_' /proc/mounts)" -le "$mounts0"
finish "AppImage painted in ${LAUNCH_SECS}s, typing works, quit cleanly"
