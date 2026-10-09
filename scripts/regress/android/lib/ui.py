#!/usr/bin/env python3
"""uiautomator dump helpers for the Android regression suite.

  ui.py list  <dump.xml>                      every node with text/desc + bounds
  ui.py find  <dump.xml> <regex> [--nth N] [--exact] [--class C] [--within y0,y1]
          prints "cx cy x0 y0 x1 y1" of the Nth match (text or content-desc)
  ui.py count <dump.xml> <regex>              number of matching nodes
  ui.py webview-nodes <dump.xml>              nodes under the WebView (0 = a11y tree not built yet)
  ui.py bounds-all <dump.xml> <regex>         one line per match: "x0 y0 x1 y1 text"
"""
import re, sys
import xml.etree.ElementTree as ET


def nodes(path):
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError):
        return []
    out = []

    def walk(n, in_web):
        cls = n.get('class', '')
        web = in_web or cls == 'android.webkit.WebView'
        if n.tag == 'node':
            b = re.findall(r'-?\d+', n.get('bounds', '[0,0][0,0]'))
            x0, y0, x1, y1 = map(int, b)
            out.append(dict(text=n.get('text', ''), desc=n.get('content-desc', ''), cls=cls,
                            rid=n.get('resource-id', ''), pkg=n.get('package', ''),
                            x0=x0, y0=y0, x1=x1, y1=y1, web=in_web,
                            clickable=n.get('clickable') == 'true',
                            checked=n.get('checked') == 'true'))
        for c in n:
            walk(c, web)

    walk(root, False)
    return out


def label(n):
    return n['text'] or n['desc']


def match(ns, rx, exact=False, cls=None, within=None):
    r = re.compile(rx)
    res = []
    for n in ns:
        if n['x1'] <= n['x0'] or n['y1'] <= n['y0']:
            continue
        if cls and not n['cls'].endswith(cls):
            continue
        if within and not (within[0] <= (n['y0'] + n['y1']) / 2 <= within[1]):
            continue
        for s in (n['text'], n['desc'], n['rid']):
            if not s:
                continue
            if (exact and r.fullmatch(s)) or (not exact and r.search(s)):
                res.append(n)
                break
    return res


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    ns = nodes(path)
    if cmd == 'list':
        for n in ns:
            if label(n) or n['rid']:
                print(f"{n['cls'].split('.')[-1]:14} {label(n)[:60]!r:64} [{n['x0']},{n['y0']}][{n['x1']},{n['y1']}]"
                      f"{' web' if n['web'] else ''}{' rid=' + n['rid'] if n['rid'] else ''}")
        return
    if cmd == 'webview-nodes':
        print(sum(1 for n in ns if n['web']))
        return
    rx = sys.argv[3]
    args = sys.argv[4:]
    nth = 0; exact = False; cls = None; within = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--nth': nth = int(args[i + 1]); i += 2; continue
        if a == '--exact': exact = True; i += 1; continue
        if a == '--class': cls = args[i + 1]; i += 2; continue
        if a == '--within': within = tuple(map(int, args[i + 1].split(','))); i += 2; continue
        i += 1
    ms = match(ns, rx, exact, cls, within)
    if cmd == 'count':
        print(len(ms)); return
    if cmd == 'bounds-all':
        for n in ms:
            print(n['x0'], n['y0'], n['x1'], n['y1'], label(n).replace('\n', ' ')[:80])
        return
    if cmd == 'find':
        if nth >= len(ms) or nth < -len(ms):
            sys.exit(1)
        n = ms[nth]
        print((n['x0'] + n['x1']) // 2, (n['y0'] + n['y1']) // 2, n['x0'], n['y0'], n['x1'], n['y1'])
        return
    sys.exit(2)


if __name__ == '__main__':
    main()
