# title: after a folder pick the phone shows that folder's notes, not a blank editor
# row: L8 / 5.0 §8
#
# Opening a folder is not opening a note, so the phone should stay on 笔记 and
# show the folder. Judged from what A03 saw the moment the picker returned.
run_check() {
  case "${AFTER_PICK_VIEW:-unknown}" in
    home) pass "returned to Notes home with the folder listed" ;;
    editor) fail "picker returned to an empty 'Untitled' editor (keyboard up) instead of the folder's notes; user must tap ‹ Notes to see the folder (shot A03-after-pick)" ;;
    *) fail "could not tell where the pick landed (${AFTER_PICK_VIEW:-A03 not run})" ;;
  esac
}
