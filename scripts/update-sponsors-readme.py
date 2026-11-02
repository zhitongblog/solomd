#!/usr/bin/env python3
"""Regenerate the sponsor section and the contributors table of README.md and README.zh.md.

    python3 scripts/update-sponsors-readme.py

The list lives in web/public/sponsors.json (nicknames, added with consent).
The website builds from it and the app's About dialog fetches it from
solomd.app, so after editing the JSON the only other step is this script.
"""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
data = json.loads((root / "web/public/sponsors.json").read_text())
names = [s["name"] for s in data["sponsors"]]

TEXT = {
    "README.md": ("## Sponsors",
                  "Thank you to everyone who sponsors SoloMD: ",
                  "No sponsors listed yet. Be the first: [solomd.app/#sponsor](https://solomd.app/#sponsor).",
                  "\n\n*(Note: This is a partial opt-in list — WeChat Pay, Alipay, and App Store / Google Play in-app tips are anonymous by default. If you supported SoloMD and would like your name listed, please open an issue or see [solomd.app/thanks](https://solomd.app/thanks).)*"),
    "README.zh.md": ("## 赞助者",
                     "感谢这些朋友对 SoloMD 的赞助：",
                     "还没有赞助者。欢迎成为第一位：[solomd.app/#sponsor](https://solomd.app/#sponsor)。",
                     "\n\n*（注：此处仅展示主动登记署名的部分赞助者——微信/支付宝扫码打赏及 App Store / Google Play 应用内支持者徽章默认匿名。若您曾打赏支持并希望留名，欢迎随时通过 Issue 告知，完整名单见 [solomd.app/zh/thanks](https://solomd.app/zh/thanks)。）*"),
}
START, END = "<!-- sponsors:start -->", "<!-- sponsors:end -->"

for fname, (heading, lead, empty, note) in TEXT.items():
    p = root / fname
    src = p.read_text()
    body = ((lead + " · ".join(f"**{n}**" for n in names)) if names else empty) + note
    block = f"{START}\n{heading}\n\n{body}\n{END}"
    if START in src:
        a, b = src.index(START), src.index(END) + len(END)
        src = src[:a] + block + src[b:]
    else:
        # First run: place the section just before the licence line.
        anchor = "\n## License" if "\n## License" in src else "\n## 许可证"
        if anchor not in src:
            raise SystemExit(f"{fname}: no licence heading to anchor the sponsor section")
        i = src.index(anchor)
        src = src[:i] + "\n" + block + "\n" + src[i:]
    p.write_text(src)
    print(f"{fname}: {len(names)} sponsor(s)")


# --- Contributors table (All Contributors spec, https://allcontributors.org) ---
# GitHub's own "Contributors" list only counts commit authors and cannot be
# edited, so non-code contributors are credited here instead: sponsors as
# 💵 (financial), testers as 🐛 (bug reports) + 🤔 (ideas) and promoters as
# 📣 (promotion), same data file as above.
import html

people = {}
def person(entry):
    p = people.setdefault(entry["name"], {"name": entry["name"], "github": None, "url": None, "kinds": []})
    p["github"] = p["github"] or entry.get("github")
    return p

for s in data["sponsors"]:
    person(s)["kinds"].append(("💵", "Financial", "https://solomd.app/thanks"))
for t in data.get("testers", []):
    p = person(t)
    p["kinds"].append(("🐛", "Bug reports", "https://solomd.app/thanks"))
    p["kinds"].append(("🤔", "Ideas", "https://solomd.app/thanks"))
for c in data.get("contributors", []):
    p = person(c)
    kind = c.get("kind", "code")
    if kind == "theme":
        p["kinds"].append(("🎨", "Theme & Design", "https://solomd.app/thanks"))
    elif kind == "packaging":
        p["kinds"].append(("📦", "Packaging", "https://solomd.app/thanks"))
    else:
        p["kinds"].append(("💻", "Code", "https://solomd.app/thanks"))
for pr in data.get("promoters", []):
    p = person(pr)
    p["url"] = p["url"] or pr.get("url")
    p["kinds"].append(("📣", "Promotion", pr["url"]))

def cell(p):
    profile = f"https://github.com/{p['github']}" if p["github"] else (p["url"] or "https://solomd.app/thanks")
    img = (f'<img src="https://github.com/{html.escape(p["github"])}.png?size=100" width="100px;" alt=""/><br />'
           if p["github"] else "")
    marks = " ".join(f'<a href="{html.escape(u)}" title="{t}">{e}</a>' for e, t, u in p["kinds"])
    return (f'<td align="center" valign="top" width="14.28%"><a href="{html.escape(profile)}">{img}'
            f'<sub><b>{html.escape(p["name"])}</b></sub></a><br />{marks}</td>')

rows = list(people.values())
if rows:
    trs = ["<tr>" + "".join(cell(p) for p in rows[i:i + 7]) + "</tr>" for i in range(0, len(rows), 7)]
    table = "<table>\n  <tbody>\n    " + "\n    ".join(trs) + "\n  </tbody>\n</table>"
else:
    table = ""

CTEXT = {
    "README.md": ("## Contributors",
                  "Thank you to everyone who helps make SoloMD better — sponsors 💵, testers 🐛🤔, code/theme/packaging contributors 💻🎨📦 and promoters 📣 ([All Contributors](https://allcontributors.org) spec). Full wall of thanks: [solomd.app/thanks](https://solomd.app/thanks) · Promote SoloMD: [solomd.app/promote](https://solomd.app/promote)"),
    "README.zh.md": ("## 贡献者",
                     "感谢每一位让 SoloMD 变得更好的朋友——赞助者 💵、深度测试者 🐛🤔、代码/主题/打包贡献者 💻🎨📦 和推广者 📣（按 [All Contributors](https://allcontributors.org) 规范）。完整鸣谢名单：[solomd.app/zh/thanks](https://solomd.app/zh/thanks) · 成为推广者：[solomd.app/zh/promote](https://solomd.app/zh/promote)"),
}
CSTART = "<!-- ALL-CONTRIBUTORS-LIST:START - generated by scripts/update-sponsors-readme.py -->"
CEND = "<!-- ALL-CONTRIBUTORS-LIST:END -->"
for fname, (heading, lead) in CTEXT.items():
    p = root / fname
    src = p.read_text()
    block = f"{CSTART}\n{heading}\n\n{lead}\n\n{table}\n{CEND}" if table else f"{CSTART}\n{heading}\n\n{lead}\n{CEND}"
    if CSTART in src:
        a, b = src.index(CSTART), src.index(CEND) + len(CEND)
        src = src[:a] + block + src[b:]
    else:
        i = src.index(END) + len(END)
        src = src[:i] + "\n\n" + block + src[i:]
    p.write_text(src)
    print(f"{fname}: {len(rows)} contributor(s) in the table")
