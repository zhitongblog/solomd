# Ctrl+F in a 中文 UI: Chinese labels, focus in the query, n/m counter,
# Enter steps, Esc closes.
FIND=1180x90+260+98     # find bar area under the tab strip
COUNT=120x30+535+102    # the n/m counter
SEED_SETTINGS='{"language":"zh"}' start_on long.md || fail "app did not start"
key ctrl+f; sleep 1
img=$(shot open)
expect "find bar has Chinese labels (替换为 / 全部替换)" bash -c "python3 '$RG_SUITE/lib/ocr.py' hasf '$img' chi_sim 替换为 $FIND && python3 '$RG_SUITE/lib/ocr.py' hasf '$img' chi_sim 全部替换 $FIND"
expect "no English labels (Replace All)" bash -c "! python3 '$RG_SUITE/lib/ocr.py' has '$img' eng 'Replace All' $FIND"
typ "filler"; sleep 0.8
img=$(shot typed)
c0=$(ocr_line "$img" "$COUNT"); note "counter after typing: '$c0'"
expect "query field had focus; counter 0/59" contains "$c0" "0/59"
key Return; sleep 0.6
c1=$(ocr_line "$(shot enter1)" "$COUNT"); note "after Enter: '$c1'"
key Return; sleep 0.6
c2=$(ocr_line "$(shot enter2)" "$COUNT"); note "after 2nd Enter: '$c2'"
expect "Enter steps to 1/59 then 2/59" bash -c "[[ '$c1' == *1/59* && '$c2' == *2/59* ]]"
key shift+Return; sleep 0.6
c3=$(ocr_line "$(shot shiftenter)" "$COUNT"); note "after Shift+Enter: '$c3'"
expect "Shift+Enter steps back to 1/59" contains "$c3" "1/59"
key Escape; sleep 0.8
img=$(shot closed)
expect "Esc closes the bar" bash -c "! python3 '$RG_SUITE/lib/ocr.py' hasf '$img' chi_sim 全部替换 $FIND"
finish "find bar OK in 中文"
