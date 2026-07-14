#!/usr/bin/env python3
"""Regenerate public/llms-full.txt (llms.txt + full docs text, one file).

Run from web/ AFTER `astro build` (it extracts from dist/), then build again
so the fresh file lands in dist — or just run it and commit; the next deploy
picks it up. Part of the per-release GEO sweep alongside the VERSION bump.
"""
import html
import re
from pathlib import Path

DOCS = [
    ('Keyboard shortcuts', 'dist/docs/shortcuts/index.html'),
    ('CLI (`solomd` command)', 'dist/docs/cli/index.html'),
    ('MCP server setup', 'dist/docs/mcp/index.html'),
    ('Markdown syntax reference', 'dist/docs/markdown-syntax/index.html'),
    ('Export (Pandoc)', 'dist/docs/export/index.html'),
    ('Sync setup', 'dist/sync/index.html'),
    ('Privacy policy', 'dist/privacy/index.html'),
    ('Security model', 'dist/security/index.html'),
    ('Agents & recipes (v4)', 'dist/agents/index.html'),
    ("What's new (v4.0 – v4.8 release notes)", 'dist/whats-new/index.html'),
]


def extract(path: str) -> str:
    h = Path(path).read_text()
    m = re.search(r'<main>(.*?)</main>', h, re.S) or re.search(r'<article[^>]*>(.*?)</article>', h, re.S)
    if not m:
        return ''
    t = m.group(1)
    t = re.sub(r'<script[^>]*>.*?</script>', '', t, flags=re.S)
    t = re.sub(r'<style[^>]*>.*?</style>', '', t, flags=re.S)
    t = re.sub(r'<nav class="breadcrumbs".*?</nav>', '', t, flags=re.S)
    for i in range(1, 5):
        t = re.sub(
            rf'<h{i}[^>]*>(.*?)</h{i}>',
            lambda mm, i=i: '\n' + '#' * (i + 1) + ' ' + re.sub(r'<[^>]+>', '', mm.group(1)).strip() + '\n',
            t,
            flags=re.S,
        )
    t = re.sub(r'<(td|th)[^>]*>', ' | ', t)
    t = re.sub(r'</tr>', '\n', t)
    t = re.sub(r'<li[^>]*>', '\n- ', t)
    t = re.sub(r'<(p|div|section|pre)[^>]*>', '\n', t)
    t = re.sub(r'<br[^>]*>', '\n', t)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()


def main() -> None:
    base = Path('public/llms.txt').read_text()
    out = [
        base,
        '\n---\n\n# Full documentation\n\nThe sections below are the full text of the docs pages on '
        'https://solomd.app, concatenated for deep context (llms-full.txt convention).\n',
    ]
    for title, p in DOCS:
        if not Path(p).exists():
            print(f'MISSING {p} — run `astro build` first')
            continue
        out.append(f'\n\n# {title}\n\n{extract(p)}\n')
    full = '\n'.join(out)
    Path('public/llms-full.txt').write_text(full)
    print(f'public/llms-full.txt: {len(full)} chars')


if __name__ == '__main__':
    main()
