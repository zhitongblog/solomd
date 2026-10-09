# File-tree and tab context menus say "Show in File Manager" on Linux.
start_on index.md || fail "app did not start"
img=$(shot tree)
xy=$(ocr_find long.md "$img" eng 260x700+0+200) || fail "long.md not found in the tree"
# shellcheck disable=SC2086
rclick $xy
img=$(shot_when "Show in File Manager" treemenu)
expect "tree menu: 'Show in File Manager'" ocr_has "Show in File Manager" "$img"
expect "tree menu: no 'Reveal in Finder'" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'Reveal in Finder'"
key Escape; sleep 0.5
xy=$(ocr_find index.md "$(shot tabs)" eng 700x40+262+52) && { rclick $xy; img=$(shot_when "Show in File Manager" tabmenu)
  expect "tab menu: 'Show in File Manager'" ocr_has "Show in File Manager" "$img"; key Escape; }
finish "Linux wording in context menus"
