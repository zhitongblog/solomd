# Edit menu (GTK) has Undo / Redo and they work.
MENUBAR=600x30+0+20
start_on plain.md || fail "app did not start"
key ctrl+End; typ " UNDOME"; sleep 0.8
ocr_click Edit 1 eng "$MENUBAR" || fail "no Edit menu in the menu bar"
img=$(shot_when Redo menu 6 400x90+40+40)
expect "Edit menu lists Undo and Redo" bash -c "python3 '$RG_SUITE/lib/ocr.py' has '$img' eng Undo 400x90+40+40 && python3 '$RG_SUITE/lib/ocr.py' has '$img' eng Redo 400x90+40+40"
ocr_click Undo 1 eng 400x90+40+40 || { key Escape; note "no Undo item"; }
sleep 1; t1=$(editor_text)
expect "Edit > Undo removed the typed text" bash -c "[[ \"\$1\" != *UNDOME* ]]" _ "$t1"
ocr_click Edit 1 eng "$MENUBAR"; sleep 0.8
ocr_click Redo 1 eng 400x90+40+40 || { key Escape; note "no Redo item"; }
sleep 1; t2=$(editor_text)
shot redone >/dev/null
expect "Edit > Redo brought it back" contains "$t2" "UNDOME"
finish "Edit menu Undo/Redo work"
