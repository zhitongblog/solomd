# Ctrl+Alt+M with the caret in $$…$$ opens the formula editor, not Quick Capture.
start_on index.md || fail "app did not start"
key ctrl+Home; key Down Down Down Down Down; sleep 0.5    # line 6: \int_0^1 …
shot caret >/dev/null
key ctrl+alt+m
# the modal fades in over the dimmed editor; poll until its palette is readable
wait_ocr "matrix" 8 eng 720x460+361+238 || note "symbol palette not readable within 8 s"
img=$(shot pressed)
qc=$(xdotool search --onlyvisible --name 'Quick Capture' 2>/dev/null)
expect "no Quick Capture window" test -z "$qc"
expect "formula dialog open (OCR symbol palette 'matrix' + 'Apply')" bash -c "python3 '$RG_SUITE/lib/ocr.py' has '$img' eng matrix 720x460+361+238 && python3 '$RG_SUITE/lib/ocr.py' has '$img' eng Apply 720x460+361+238"
expect "dialog holds the formula under the caret (OCR 'frac')" ocr_has "frac" "$img"
key Escape; sleep 0.5
finish "Ctrl+Alt+M opens the formula editor"
