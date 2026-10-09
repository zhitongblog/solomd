# CJK proofread (Ctrl+Shift+J) does not flag file names / ellipsis; a control
# file with real issues is flagged.
start_on proof.md || fail "app did not start"
key ctrl+shift+j
img=$(shot_when "No issues found" clean 8)
expect "proof.md: 'No issues found'" ocr_has "No issues found" "$img"
app_open "$VAULT/proofctl.md" || note "could not open proofctl.md"
sleep 1
key ctrl+shift+j
img=$(shot_when "Half-width" control 8)
if ocr_has "No issues found" "$img"; then
  # the panel may still show the old result; rescan
  ocr_click Rescan && sleep 2 && img=$(shot control2)
fi
expect "control file IS flagged (no 'No issues found')" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'No issues found'"
expect "control file shows the half-width punctuation finding" ocr_has "Half-width" "$img"
finish "proofread skips file names, flags real issues"
