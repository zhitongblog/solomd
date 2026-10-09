# Export a note to DOCX, import that DOCX back (Ctrl+Shift+L): bold, numbered
# list, task boxes and links survive.
start_on roundtrip.md || fail "app did not start"
palette "Export to Word (DOCX)"
gtk_save "$EXP/rt.docx" || { shot exportdlg >/dev/null; fail "could not drive the DOCX save dialog"; }
wait_file "$EXP/rt.docx" 30 || fail "no DOCX written"
expect "exported DOCX is a valid zip" unzip -tq "$EXP/rt.docx"
focus_main
key ctrl+shift+l
gtk_open "$EXP/rt.docx" || { shot importdlg >/dev/null; fail "could not drive the import dialog"; }
for i in $(seq 1 30); do [ -s "$VAULT/rt.md" ] && break; sleep 0.5; done
shot imported >/dev/null
[ -s "$VAULT/rt.md" ] || fail "import wrote no rt.md into the vault ($(ls "$VAULT" | tr '\n' ' '))"
md=$(cat "$VAULT/rt.md")
cp "$VAULT/rt.md" "$RG_OUT/$CHECK_ID-imported.md"
note "imported markdown: $(printf '%s' "$md" | tr '\n' '|' | head -c 400)"
expect "bold stays bold (**bold words**)" bash -c "grep -q '\*\*bold words\*\*' <<<\"\$1\"" _ "$md"
expect "numbered list stays numbered (1. / 2. / 3.)" bash -c "grep -Eq '^ *1\. +first item' <<<\"\$1\" && grep -Eq '^ *[0-9]+\. +second item' <<<\"\$1\"" _ "$md"
expect "open task stays '- [ ]'" bash -c "grep -Eq '^ *[-*] \[ \] +open task' <<<\"\$1\"" _ "$md"
expect "done task stays '- [x]'" bash -c "grep -Eq '^ *[-*] \[[xX]\] +done task' <<<\"\$1\"" _ "$md"
expect "link kept ([Example Site](https://example.com/page))" bash -c "grep -Fq '[Example Site](https://example.com/page)' <<<\"\$1\"" _ "$md"
finish "DOCX round trip keeps structure"
