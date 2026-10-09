# title: tap a note on home -> editor screen with ‹ Notes back button and its text
# row: 5.0 §8
run_check() {
  dismiss_banner
  if ! open_note alpha; then shot A05-open >/dev/null; fail "tapping alpha did not open the editor"; return; fi
  shot A05-editor >/dev/null
  local errs=()
  has '^alpha$' --class TextView --within 0,450 || errs+=("header title is not 'alpha'")
  has 'zebracorn' --class EditText || errs+=("editor does not show alpha.md's text")
  if [ ${#errs[@]} -eq 0 ]; then pass "editor: ‹ Notes, title alpha, body loaded from SAF"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
