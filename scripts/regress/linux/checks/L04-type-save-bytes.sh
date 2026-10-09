# Type at the end of a note, Ctrl+S, compare the bytes on disk.
start_on index.md || fail "app did not start"
orig=$(cat "$VAULT/index.md"; printf x); orig=${orig%x}
key ctrl+End; typ "TYPED-L04 äö 中文"
key ctrl+s; sleep 1.5
shot saved >/dev/null
got=$(cat "$VAULT/index.md"; printf x); got=${got%x}
want="${orig}TYPED-L04 äö 中文"
if [ "$got" = "$want" ] || [ "$got" = "$want"$'\n' ]; then
  note "tail bytes: $(tail -c 24 "$VAULT/index.md" | xxd -p)"
  pass "disk bytes = original + typed text"
fi
note "expected tail: $(printf '%s' "$want" | tail -c 30 | xxd -p)"
note "got tail:      $(tail -c 30 "$VAULT/index.md" | xxd -p)"
fail "bytes on disk differ from original + typed text"
