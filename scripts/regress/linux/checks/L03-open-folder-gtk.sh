# File > Open Folder (Ctrl+Alt+Shift+O) → GTK folder chooser → typed path.
SEED_EXTRA='{"solomd.workspace.v1":{"recentFiles":[],"recentFolders":[],"currentFolder":null,"safTreeUri":null,"safName":null}}' \
  start_on "" || fail "app did not start"
shot before >/dev/null
key ctrl+alt+shift+o
w=$(gtk_wait '^(Open Folder|Select Folder|Open|Select)' 15) || { shot nodialog >/dev/null; fail "no folder dialog appeared"; }
note "dialog title: $(xdotool getwindowname "$w")"
shot dialog >/dev/null
gtk_open "$VAULT/" "^$(xdotool getwindowname "$w")\$" || fail "could not drive the folder dialog"
sleep 2
img=$(shot after)
expect "tree lists the vault files (OCR 'long.md' and 'roundtrip.md')" bash -c "python3 '$RG_SUITE/lib/ocr.py' has '$img' eng long.md 260x750+0+150 && python3 '$RG_SUITE/lib/ocr.py' has '$img' eng roundtrip.md 260x750+0+150"
app_quit 10 || { note "quit timed out"; app_kill; }
cf=$(ls_json solomd.workspace.v1 'v.get("currentFolder")')
note "persisted currentFolder: $cf"
expect "workspace.currentFolder persisted as the vault" test "${cf%/}" = "$VAULT"
finish "folder opened through the GTK dialog"
