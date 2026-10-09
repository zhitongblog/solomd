#!/usr/bin/env python3
"""Write the fixture vault for the Windows regression suite into <outdir>.

The runner zips this, unpacks it in the VM as a pristine copy, and re-copies it to
Desktop\\regress-vault before EVERY check, so checks never see each other's edits.
Keep files ASCII-named (the checks pass paths on the SoloMD command line).
"""
import os
import sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

FILES = {
    # A4 open/type/save
    "save.md": "# Save test\n\nHello world.\n",
    # A1 / A6 / A7 tabs
    "tab-a.md": "# Tab A\n\nalpha file\n",
    "tab-b.md": "# Tab B\n\nbravo file\n",
    # C1 / C2 find + replace: "alpha" x3, "Hello" x2
    "find.md": "# Find test\n\nalpha beta alpha gamma alpha\n\nHello one. Hello two.\n",
    # B1 Ctrl+B
    "bold.md": "# Bold test\n\nword\n",
    # B5 formula editor
    "math.md": "# Math\n\n$$\nE=mc^2\n$$\n\nInline $a+b$ here.\n",
    # B9 Tab nests an ordered list item
    "list.md": "# List\n\n1. one\n2. two\n",
    # code block toggle
    "code.md": "# Code\n\nplain line\n",
    # proofread: file names must not be flagged, the half-width full stop after Chinese must
    "proof.md": "# 校对\n\n请运行 调试开关.ps1 然后解压 压缩包.tar.gz 再看 readme.txt 待续...\n\n这是中文.\n",
    # redo / pomodoro
    "redo.md": "# Redo\n\nbase\n",
    # Alt+F4 right after typing
    "quit.md": "# Quit\n\nbefore\n",
    # second window
    "win2.md": "# Window two\n\nbody\n",
    # invalid mermaid
    "mermaid.md": "# Mermaid\n\nAbove text.\n\n```mermaid\ngraph TD\n  A --> B -->\n  ((( broken\n```\n\nBelow text.\n",
    # export + DOCX import round trip
    "export.md": (
        "# Import test\n\n"
        "Intro paragraph with **bold** and a [link](https://example.com/target).\n\n"
        "- [ ] task one\n- [x] task two\n\n"
        "1. first\n2. second\n3. third\n"
    ),
    # view modes
    "views.md": "# Views\n\nSome **rendered** text for the preview.\n\n- item\n",
    # minimize -> restore
    "min.md": "# Minimize\n\nstart\n",
    # IME typing targets
    "ime.md": "",
    # menu
    "menu.md": "# Menu\n\nmenu text\n",
}

for name, text in FILES.items():
    with open(os.path.join(out, name), "w", encoding="utf-8", newline="") as f:
        f.write(text)

# A15 UTF-16LE with BOM and CRLF line endings
with open(os.path.join(out, "utf16.md"), "wb") as f:
    f.write(b"\xff\xfe" + "# UTF16 测试\r\n\r\n第一行\r\n".encode("utf-16-le"))

print(out)
