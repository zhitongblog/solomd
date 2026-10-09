# Launch the installed .deb on a fresh profile; first stable non-blank frame;
# KaTeX / mermaid / table rendered; Ctrl+Q leaves no process behind.
start_on index.md || fail "no painted window within ${LAUNCH_TIMEOUT:-45}s (see logs/$CHECK_ID.app.log)"
note "window process: $(readlink /proc/$(xdotool getwindowpid "$(main_window)")/exe)"
note "first stable paint after ${LAUNCH_SECS}s; build: $("$SOLOMD_BIN" --version 2>/dev/null | head -1)"
img=$(shot launched)
expect "window title is 'index.md — SoloMD'" wait_title '^index\.md — SoloMD$' 5
expect "document text rendered (OCR 'Index Note')" ocr_has "Index Note" "$img"
expect "mermaid diagram rendered (OCR node 'Start')" ocr_has "Start" "$img" eng 900x700+500+150
expect "file tree shows the vault (OCR 'long.md')" ocr_has "long.md" "$img" eng 260x700+0+200
expect "Ctrl+Q exits every app process" app_quit 10
finish "painted in ${LAUNCH_SECS}s, rendered, quit cleanly"
