# Ctrl+H opens find & replace; replace one, then Replace All; bytes on disk.
FIND=1180x90+260+98
start_on replace.md || fail "app did not start"
key ctrl+h; sleep 1
img=$(shot open)
expect "Ctrl+H opens the panel with a replace row (OCR 'Replace All')" ocr_has "Replace All" "$img" eng "$FIND"
typ "alpha"; sleep 0.6
c=$(ocr_line "$(shot query)" 120x30+535+102); note "counter: '$c'"
expect "query typed into the find field (n/3 counter)" contains "$c" "/3"
key ctrl+h; sleep 0.6           # with a query, Ctrl+H moves the caret to Replace
typ "BETA"; sleep 0.4
key Return; sleep 0.5; key Return; sleep 0.6   # first Enter selects, next replaces
shot one >/dev/null
txt=$(cat "$VAULT/replace.md")
ocr_click "Replace All" 1 eng "$FIND" || note "could not click Replace All"
sleep 0.8
shot all >/dev/null
key Escape; sleep 0.3
key ctrl+s; sleep 1.5
got=$(cat "$VAULT/replace.md")
note "disk: $(printf '%s' "$got" | tr '\n' '|')"
expect "all three replaced on disk" test "$got" = $'BETA one\nBETA two\nBETA three'
finish "Ctrl+H replace works"
