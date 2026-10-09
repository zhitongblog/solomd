#!/usr/bin/env python3
"""Create the regression fixture vault: python3 make_fixture.py <dir>.

Line numbers matter: checks assert on them (e.g. the backlink in Table Note.md
is on file line 13, after 5 lines of front matter). Change a fixture file and
you change the checks that read it.
"""
import os
import struct
import sys
import zlib

root = sys.argv[1]
os.makedirs(root, exist_ok=False)


def w(rel, text=None, data=None):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data if data is not None else text.encode("utf-8"))


def png(width=64, height=32):
    raw = b""
    for y in range(height):
        raw += b"\x00" + bytes(
            [(x * 4) % 256 if (x // 8 + y // 8) % 2 else 40 for x in range(width) for _ in (0, 1, 2)]
        )

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


w("README.md", """# Fixture Vault

Intro paragraph with Note text and a link to [[Table Note]].

## Tasks

- [ ] open task one
- [x] done task
- [ ] task with #tag/project

## Section Two

Some text tagged #fixture.

### Deep heading

End of the readme.
""")

# Backlink to README is on FILE line 13 (body line 8).
w("Table Note.md", """---
status: draft
tags: [table, fixture]
type: reference
---
# Table Note

| Name | Qty | Price |
| --- | ---: | :---: |
| Apple | 3 | 1.5 |
| Pear | 2 | 2.0 |

Back to [[README]].
""")

w("notes/Math Note.md", """# Math Note

Inline $a^2+b^2=c^2$ math.

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

```mermaid
graph TD
  A[Start] --> B[Finish]
```
""")

w("notes/Chinese.md", """# 中文校对

这是测试:中文后面用了半角冒号,还有半角句号.
请下载 report.pdf 和 调试开关.ps1 以及 压缩包.tar.gz 这几个文件。
中文省略号……不应报告，英文省略号...也不应报告。
链接 https://example.com/a,b.html 不应报告。
""")

w("notes/convert.md", "发展头发后来，汉字转换测试。\n")

# Encodings
txt = "编码测试 encoding test 中文\n第二行\n"
w("enc/gbk.txt", data=txt.encode("gbk"))
w("enc/big5.txt", data="編碼測試 encoding test 中文\n第二行\n".encode("big5"))
w("enc/utf16le.txt", data=b"\xff\xfe" + txt.encode("utf-16-le"))
w("enc/utf16be.txt", data=b"\xfe\xff" + txt.encode("utf-16-be"))

# Long mixed document for split-view scroll sync: paragraphs, lists (incl. one
# right at a probe position), code, quotes and tables, so line heights differ
# between the editor and the preview.
parts = ["# Long Document", ""]
for i in range(1, 41):
    parts += [f"## Section {i}", ""]
    parts += [f"Paragraph {i}. " + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 3, ""]
    if i % 3 == 0:
        parts += [f"- list {i} item a", f"- list {i} item b", f"  - nested {i}", f"- list {i} item c", ""]
    if i % 4 == 0:
        parts += [f"1. ordered {i} one", f"2. ordered {i} two", f"3. ordered {i} three", ""]
    if i % 5 == 0:
        parts += ["```js", f"const s{i} = {i};", "console.log(s%d);" % i, "```", ""]
    if i % 7 == 0:
        parts += [f"> quote {i}", "> second line", ""]
    if i % 6 == 0:
        parts += ["| a | b |", "| --- | --- |", f"| {i} | x |", ""]
w("long.md", "\n".join(parts) + "\n")

w("inbox1.md", "---\ninbox: true\n---\n# Inbox One\n\nfirst\n")
w("inbox2.md", "---\ninbox: true\n---\n# Inbox Two\n\nsecond\n")

w("docx-src.md", """# Docx Round Trip

Intro with **bold** and a [link](https://example.com/x) here.

- bullet one
- bullet two

1. first
2. second
3. third

- [ ] open task
- [x] done task

Plain closing paragraph.
""")

w("assets/logo.png", data=png())
os.makedirs(os.path.join(root, "daily"), exist_ok=True)
os.makedirs(os.path.join(root, "empty"), exist_ok=True)
os.makedirs(os.path.join(root, "_work"), exist_ok=True)

