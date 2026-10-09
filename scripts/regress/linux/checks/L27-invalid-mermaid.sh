# Invalid mermaid shows an inline error and never shifts the app chrome,
# even after a preview find scrolls to a match.
SEED_SETTINGS='{"viewMode":"preview"}' start_on badmermaid.md || fail "app did not start"
sleep 2
img=$(shot preview)
expect "inline mermaid error shown in the note" bash -c "python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'error' 1180x800+260+95"
expect "no mermaid 'bomb' (Syntax error in text)" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'Syntax error in text'"
crop "$img" 1440x95+0+0 "$RG_ROOT/top0.png"
app_open "$VAULT/long.md" || note "could not open long.md"
sleep 2
key ctrl+f; sleep 0.8; typ "third"; sleep 0.5; key Return; sleep 0.8; key Return; sleep 1.2
img=$(shot found)
expect "menu bar still at the top (OCR 'Paragraph' in y 20-45)" ocr_has "Paragraph" "$img" eng 600x26+0+20
expect "tab strip still visible (OCR 'long.md' in y 52-90)" ocr_has "long.md" "$img" eng 900x40+262+52
expect "match scrolled into view (OCR 'Paragraph 45' on screen)" ocr_has "Paragraph 45" "$img"
expect "no mermaid bomb anywhere" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'Syntax error in text'"
key Escape; sleep 0.5
xdotool mousemove 900 500; for i in 1 2 3 4 5; do xdotool click 4; sleep 0.1; done; sleep 0.8
img=$(shot scrolled)
expect "after wheel-scrolling up the chrome is intact" ocr_has "Paragraph" "$img" eng 600x26+0+20
finish "mermaid error contained"
