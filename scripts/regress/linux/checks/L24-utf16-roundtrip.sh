# A UTF-16LE file with BOM opens correctly and is saved back as UTF-16LE + BOM.
start_on u16.txt || fail "app did not start"
img=$(shot opened)
expect "content decoded (OCR 'UTF16')" ocr_has "UTF16" "$img"
# 5.0: the encoding lives in the stats pill's popover (bottom right)
ocr_click "characters" 1 eng 400x40+1040+848 || ocr_click "words" 1 eng 400x40+1040+848 || note "stats pill not found"
sleep 1; img=$(shot statspop)
expect "stats popover shows the encoding UTF-16LE" ocr_has "UTF-16LE" "$img"
key Escape; sleep 0.4
key ctrl+End; typ "Y"; key ctrl+s; sleep 1.5
hex=$(xxd -p "$VAULT/u16.txt" | tr -d '\n'); note "bytes: $hex"
note "file(1): $(file -b "$VAULT/u16.txt")"
expect "BOM kept (starts fffe)" bash -c "[[ '$hex' == fffe* ]]"
dec=$(tail -c +3 "$VAULT/u16.txt" | iconv -f UTF-16LE -t UTF-8 2>/dev/null)
expect "decodes as UTF-16LE to the original + Y" bash -c "[[ \"\$1\" == \$'UTF16 測試 line\nY' || \"\$1\" == \$'UTF16 測試 line\nY\n' ]]" _ "$dec"
finish "UTF-16LE round trip"
