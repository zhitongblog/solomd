# title: SAF Open Folder… through the system picker; the folder's notes are listed
# row: L8
#
# Fixture: $REMOTE_DIR (default /sdcard/Documents/SoloRegress) with alpha.md and
# beta.md. SAF refuses Documents itself, so the vault is a subfolder of it.
run_check() {
  push_fixtures
  local name; name=$(basename "$REMOTE_DIR")
  go_home >/dev/null 2>&1
  tap "$RX_OPENFOLDER" --class Button || { fail "no Open Folder… button on home"; return; }
  wait_for '^(USE THIS FOLDER|Use this folder|使用此文件夹|使用这个文件夹)$' 15 || { shot A03-no-picker >/dev/null; fail "system folder picker did not appear (fg=$(foreground_pkg))"; return; }
  note "picker: $(foreground_pkg)"
  # Walk to Documents: the breadcrumb if the picker remembers a nearby folder,
  # else roots drawer -> device storage -> Documents.
  if has '^Documents$' --class TextView; then
    tap '^Documents$' --class TextView
  else
    tap '^(Show roots|显示根目录)$' && sleep 1
    tap "$(sh_ getprop ro.product.model)|Internal storage|内部存储" --class TextView; sleep 1
    tap '^Documents$' --class TextView
  fi
  sleep 1
  tap "^$name\$" --class TextView || { shot A03-picker >/dev/null; fail "picker: $name not found under Documents"; return; }
  sleep 1
  shot A03-picker >/dev/null
  tap '^(USE THIS FOLDER|Use this folder|使用此文件夹|使用这个文件夹)$' || { fail "no USE THIS FOLDER"; return; }
  wait_for '^(ALLOW|Allow|允许)$' 10 && tap '^(ALLOW|Allow|允许)$'
  local end=$(( $(date +%s) + 20 ))
  while [ "$(foreground_pkg)" != "$PKG" ] && [ "$(date +%s)" -lt "$end" ]; do sleep 1; done
  sleep 2
  shot A03-after-pick >/dev/null
  # Where did the pick leave us? (A04 judges this.)
  if in_editor; then AFTER_PICK_VIEW=editor; elif on_home; then AFTER_PICK_VIEW=home; else AFTER_PICK_VIEW=other; fi
  note "after the pick the app shows: $AFTER_PICK_VIEW"
  dismiss_banner
  go_home
  wait_for '^alpha$' 10 --class TextView || true
  shot A03-home-folder >/dev/null
  local errs=()
  has "$name" || errs+=("folder name $name not shown")
  has '^alpha$' --class TextView || errs+=("alpha.md not listed")
  has '^beta$'  --class TextView || errs+=("beta.md not listed")
  sh_ dumpsys package "$PKG" >/dev/null
  if [ ${#errs[@]} -eq 0 ]; then pass "picked $REMOTE_DIR via DocumentsUI; home lists alpha, beta under $name"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
