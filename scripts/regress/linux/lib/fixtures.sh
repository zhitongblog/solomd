# shellcheck shell=bash
# Fixture vault, rebuilt from scratch before every check.

vault_reset() {
  rm -rf "$VAULT" "$EXP"
  mkdir -p "$VAULT/sub" "$EXP"

  convert -size 40x30 xc:'#3a7bd5' -fill white -draw 'rectangle 5,5 20,20' "$VAULT/logo.png"
  # a distinct image for clipboard paste (outside the vault)
  convert -size 48x32 xc:'#d53a3a' -fill yellow -draw 'circle 24,16 30,16' "$RG_ROOT/paste.png"

  cat >"$VAULT/index.md" <<'EOF'
# Index Note

Inline math $E=mc^2$ here.

$$
\int_0^1 x^2\,dx=\frac13
$$

| A | B |
|---|---|
| 1 | 2 |

```mermaid
graph TD
  A[Start] --> B[End]
```

![logo](logo.png)

Some **bold** text and a list:

- one
- two
EOF

  {
    echo "# Long note"
    echo
    for i in $(seq 1 60); do
      if [ "$i" = 45 ]; then echo "Paragraph $i has the third marker word."; else echo "Paragraph $i filler text for scrolling."; fi
      echo
    done
  } >"$VAULT/long.md"

  cat >"$VAULT/badmermaid.md" <<'EOF'
# Bad mermaid

```mermaid
graph TD
  A[] -->
```

After the diagram.
EOF

  printf '# 校对\n\n运行 调试开关.ps1 然后解压 压缩包.tar.gz，待续...\n' >"$VAULT/proof.md"
  printf '# 对照\n\n对照组：你好,世界的的结果。\n' >"$VAULT/proofctl.md"

  printf 'UTF16 測試 line\n' | iconv -f UTF-8 -t UTF-16LE | { printf '\xff\xfe'; cat; } >"$VAULT/u16.txt"

  printf 'alpha one\nalpha two\nalpha three\n' >"$VAULT/replace.md"

  cat >"$VAULT/roundtrip.md" <<'EOF'
# Round trip

Some **bold words** and *italic* here.

1. first item
2. second item
3. third item

- [ ] open task
- [x] done task

See [Example Site](https://example.com/page) for more.
EOF

  printf 'Hello\n' >"$VAULT/sub/a.md"
  printf 'plain note\n' >"$VAULT/plain.md"
}
