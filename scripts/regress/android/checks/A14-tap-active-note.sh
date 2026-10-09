# title: tapping the note that is already open (the active tab) opens it again
# row: 5.0 §8
#
# Common path: open a note, ‹ Notes, tap the same note again — or a cold start
# that restored the last note as the active tab, then tap that note.
run_check() {
  open_note beta >/dev/null || { fail "cannot open beta"; return; }
  go_home || { fail "‹ Notes did not return home"; return; }
  tap '^beta$' --class TextView; sleep 2
  shot A14-tap-again >/dev/null
  if in_editor; then pass "re-tapping the active note opens the editor"
  else fail "tapping beta on home while beta is the active tab does nothing (stays on home)"; fi
}
