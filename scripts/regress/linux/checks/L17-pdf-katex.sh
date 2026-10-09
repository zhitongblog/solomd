# Export to PDF (text) through the GTK print dialog; KaTeX glyphs survive.
start_on index.md || fail "app did not start"
key ctrl+alt+shift+p
gtk_print_to_file "$EXP/index.pdf" || { shot printdlg >/dev/null; fail "could not drive the print dialog"; }
wait_file "$EXP/index.pdf" 30 || fail "no PDF written"
txt=$(pdftotext "$EXP/index.pdf" - 2>/dev/null)
fonts=$(pdffonts "$EXP/index.pdf" 2>/dev/null)
note "pdf: $(stat -c %s "$EXP/index.pdf") bytes, $(pdfinfo "$EXP/index.pdf" 2>/dev/null | awk '/^Pages/{print $2}') page(s)"
note "fonts: $(echo "$fonts" | awk 'NR>2{print $1}' | sed 's/^[A-Z]*+//' | tr '\n' ' ')"
pdftoppm -r 60 -png -f 1 -l 1 "$EXP/index.pdf" "$SHOTS/$CHECK_ID-page" 2>/dev/null
expect "text layer has the inline math letters (E = mc)" bash -c "grep -q 'E = mc' <<<\"\$1\"" _ "$txt"
expect "text layer has the integral (∫ … dx)" bash -c "grep -q '∫' <<<\"\$1\" && grep -q 'dx' <<<\"\$1\"" _ "$txt"
expect "KaTeX_Math font embedded" bash -c "grep -q KaTeX_Math <<<\"\$1\"" _ "$fonts"
expect "body text selectable (Index Note)" bash -c "grep -q 'Index Note' <<<\"\$1\"" _ "$txt"
finish "text PDF keeps KaTeX letters"
