# The File menu shows "Sync & History" with its ampersand.
start_on index.md || fail "app did not start"
ocr_click File 1 eng 600x30+0+20 || fail "no File menu"
img=$(shot_when "Sync & History" filemenu 6 440x600+0+40)
key Escape
expect "File menu reads 'Sync & History'" ocr_has "Sync & History" "$img" eng 440x600+0+40
finish "ampersand shown"
