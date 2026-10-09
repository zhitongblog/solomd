# Live / Source / Split / Preview via the header switch; each mode shows the
# right thing, and the choice persists.
SEG=500x40+990+52
start_on index.md || fail "app did not start"
mode() { # click the header segment; retry while the header is still settling
  local i
  for i in 1 2 3 4; do ocr_click "$1" 1 eng "$SEG" && { sleep 2; return 0; }; sleep 1; done
  note "no '$1' segment found in the header"; return 1
}
raw() { python3 "$RG_SUITE/lib/ocr.py" has "$1" eng "graph TD" 1180x800+260+95; }
rendered() { [ "$(mermaid_px "$1" "${2:-1180x800+260+95}")" -gt 2000 ]; }   # lavender mermaid nodes
scroll_to_mermaid() { key ctrl+Home; xdotool mousemove 900 500; for i in 1 2 3 4; do xdotool click 5; sleep 0.1; done; sleep 0.8; }

mode Source; scroll_to_mermaid; img=$(shot source)
expect "Source: raw mermaid source visible" raw "$img"
mode Split; scroll_to_mermaid; img=$(shot split)
expect "Split: raw source on the left" raw "$img"
expect "Split: rendered diagram on the right half" rendered "$img" 590x790+850+95
mode Preview; sleep 1; img=$(shot preview)
expect "Preview: rendered diagram" rendered "$img"
expect "Preview: no raw source" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'graph TD'"
mode Live; img=$(shot live)
expect "Live: diagram rendered inline" rendered "$img"
expect "Live: no raw mermaid source" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'graph TD'"
expect "Source: no rendered diagram" bash -c "[ \"\$(convert '$SHOTS/$CHECK_ID-source.png' -crop 1180x800+260+95 +repage -alpha off -fuzz 3% -fill '#FF00FE' -opaque '#ECECFF' -fuzz 0 -fill black +opaque '#FF00FE' -fill white -opaque '#FF00FE' -colorspace Gray -format '%[fx:int(mean*w*h+0.5)]' info:)\" -lt 500 ]"
key ctrl+shift+r; sleep 1.5; img=$(shot reading)
expect "Ctrl+Shift+R reading mode hides the file tree" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng long.md 260x700+0+150"
key ctrl+shift+r; sleep 1
mode Preview
app_quit 10 || app_kill
vm=$(ls_json solomd.settings.v1 'v.get("viewMode")'); note "persisted viewMode: $vm"
expect "Preview persisted (settings.viewMode=preview)" test "$vm" = preview
finish "view modes switch and persist"
