# Ctrl+W on a dirty tab asks; Esc keeps it; N (Don't Save) closes it, disk unchanged.
start_on plain.md || fail "app did not start"
before=$(md5sum <"$VAULT/plain.md")
key ctrl+End; typ " DIRTY-L07"
key ctrl+w
img=$(shot_when "Unsaved Changes" prompt)
expect "unsaved prompt shown (OCR 'Unsaved Changes')" ocr_has "Unsaved Changes" "$img"
expect "prompt names the file and asks 'Save changes?'" ocr_has "Save changes" "$img"
expect "tab still open while prompting" wait_title '^plain\.md — SoloMD$' 2
key Escape; sleep 0.8
shot cancelled >/dev/null
expect "Esc (Cancel) keeps the tab" wait_title '^plain\.md — SoloMD$' 2
key ctrl+w; sleep 1.2
key n; sleep 1.2
shot discarded >/dev/null
expect "N (Don't Save) closes the tab" bash -c "! (xdotool search --onlyvisible --name '^plain\.md — SoloMD$' | grep -q .)"
expect "file on disk unchanged" test "$(md5sum <"$VAULT/plain.md")" = "$before"
finish "unsaved prompt works"
