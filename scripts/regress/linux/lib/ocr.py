#!/usr/bin/env python3
"""Tiny tesseract wrapper for the Linux regression suite.

  ocr.py text IMAGE LANG             -> prints recognised text
  ocr.py has  IMAGE LANG PHRASE      -> exit 0 if PHRASE is on screen
  ocr.py find IMAGE LANG PHRASE [WxH+X+Y]
                                     -> prints "X Y" (screen coords) of the
                                        phrase centre, exit 1 if absent

The image is upscaled 2x and grey-scaled first; UI text at 1x is too small
for tesseract. Matching ignores case and whitespace, and folds the curly
apostrophe the app uses ("Don’t Save") to a straight one.
"""
import os
import re
import subprocess
import sys
import tempfile

SCALE = 2


def norm(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'").replace("`", "'")
    return re.sub(r"\s+", "", s).lower()


def prep(img: str, region: str | None) -> tuple[str, int, int]:
    ox = oy = 0
    fd, out = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    cmd = ["convert", img]
    if region:
        m = re.match(r"(\d+)x(\d+)\+(\d+)\+(\d+)", region)
        if m:
            ox, oy = int(m.group(3)), int(m.group(4))
        cmd += ["-crop", region, "+repage"]
    cmd += ["-colorspace", "Gray", "-resize", f"{SCALE * 100}%", out]
    subprocess.run(cmd, check=True)
    return out, ox, oy


def tsv(img: str, lang: str, region: str | None, psm: str):
    p, ox, oy = prep(img, region)
    try:
        r = subprocess.run(
            ["tesseract", p, "-", "-l", lang, "--psm", psm, "tsv"],
            capture_output=True, text=True,
        )
    finally:
        os.unlink(p)
    words = []
    for line in r.stdout.splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        try:
            conf = float(f[10])
        except ValueError:
            conf = -1
        if conf < 0:
            continue
        x, y, w, h = (int(v) for v in f[6:10])
        words.append({
            "key": (int(f[2]), int(f[3]), int(f[4])),  # block, par, line
            "text": f[11],
            "x": x / SCALE + ox, "y": y / SCALE + oy,
            "w": w / SCALE, "h": h / SCALE,
        })
    return words


def text(img: str, lang: str, region: str | None = None, psms=("11", "3")) -> str:
    out = []
    for psm in psms:
        p, _, _ = prep(img, region)
        try:
            r = subprocess.run(["tesseract", p, "-", "-l", lang, "--psm", psm],
                               capture_output=True, text=True)
        finally:
            os.unlink(p)
        out.append(r.stdout)
    return "\n".join(out)


def find(img: str, lang: str, phrase: str, region: str | None):
    target = norm(phrase)
    for psm in ("11", "3"):
        words = tsv(img, lang, region, psm)
        # group words into lines, then slide over consecutive words
        lines: dict = {}
        for w in words:
            lines.setdefault(w["key"], []).append(w)
        if psm == "11":  # sparse mode: every word is its own "line"; merge by y
            rows: list = []
            for w in sorted(words, key=lambda w: (round(w["y"] / 6), w["x"])):
                if rows and abs(rows[-1][-1]["y"] - w["y"]) < 6 and w["x"] - (rows[-1][-1]["x"] + rows[-1][-1]["w"]) < 30:
                    rows[-1].append(w)
                else:
                    rows.append([w])
            groups = rows
        else:
            groups = list(lines.values())
        for ws in groups:
            for i in range(len(ws)):
                acc = ""
                for j in range(i, len(ws)):
                    acc += norm(ws[j]["text"])
                    if target in acc:
                        a, b = ws[i], ws[j]
                        x1, y1 = a["x"], min(w["y"] for w in ws[i:j + 1])
                        x2 = b["x"] + b["w"]
                        y2 = max(w["y"] + w["h"] for w in ws[i:j + 1])
                        return int((x1 + x2) / 2), int((y1 + y2) / 2)
                    if len(acc) > len(target) + 40:
                        break
    return None


def lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def fuzzy_has(hay: str, phrase: str) -> bool:
    """Tesseract's chi_sim misreads one glyph of small UI text now and then
    (替 -> 蔡). Allow 1 edit for <=4 chars, 2 for longer phrases."""
    t = norm(phrase)
    h = norm(hay)
    k = 1 if len(t) <= 4 else 2
    for n in (len(t) - 1, len(t), len(t) + 1):
        if n <= 0:
            continue
        for i in range(0, max(1, len(h) - n + 1)):
            if lev(h[i:i + n], t) <= k:
                return True
    return False


def main():
    mode, img, lang = sys.argv[1], sys.argv[2], sys.argv[3]
    if mode == "text":
        region = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        print(text(img, lang, region))
        return 0
    phrase = sys.argv[4]
    region = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
    if mode == "has":
        for psm in ("11", "3"):
            if norm(phrase) in norm(text(img, lang, region, (psm,))):
                return 0
        return 1
    if mode == "hasf":
        for psm in ("11", "6", "3"):
            if fuzzy_has(text(img, lang, region, (psm,)), phrase):
                return 0
        return 1
    if mode == "find":
        r = find(img, lang, phrase, region)
        if not r:
            return 1
        print(r[0], r[1])
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
