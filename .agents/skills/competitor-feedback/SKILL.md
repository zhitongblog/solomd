---
name: competitor-feedback
version: 1.0.0
description: |
  Scan competing markdown editors' user feedback (GitHub issues/discussions/releases
  + closed-source forums) and synthesize themes cross-referenced against SoloMD's
  own gaps and roadmap. Surfaces unmet demand SoloMD could win on, and features
  competitors ship that SoloMD lacks. Supports a "subscribe" mode that reports only
  what's new since the last scan. Use when asked to "check competitor feedback",
  "what are users complaining about in Obsidian/Logseq/etc.", "competitor watch",
  or "subscribe to competitors' GitHub".
triggers:
  - competitor feedback
  - competitor watch
  - what are competitors' users complaining about
  - subscribe to competitor github
  - scan competitor issues
allowed-tools:
  - Bash
  - Read
  - Write
  - WebSearch
  - WebFetch
---

# Competitor feedback watch

Pulls real user feedback from SoloMD's competitors and turns it into a product
signal: **what their users want that we could win on**, and **what they ship
that we lack**.

## Channels (which tools actually work)

The global AGENTS.md mentions an `unzoo` browser. The `mcp__unzoo__*` **MCP tools
are not installed** — but unzoo IS available as a **local REST API at
`http://127.0.0.1:9399`** (a real headless Chromium: JS rendering, anti-bot,
cookies). Use it via the bundled `unzoo.sh` wrapper, not MCP calls.

- **GitHub (primary, structured):** the `gh` CLI, driven by `scan.sh` — gives
  reaction-sorted issue lists (best unmet-demand signal). This is the main channel.
- **Closed-source competitors (Typora, Obsidian, Bear, iA Writer, Tolaria…):** no
  public issue API → use **`unzoo.sh`** to read their forums/Reddit:
  `unzoo.sh fetch-web <forum-url>` and `unzoo.sh search-web "<name> bug …"`.
  `unzoo.sh discover-rss <site>` can find a feed to poll. `WebSearch`/`WebFetch`
  are fine fallbacks.
- **GitHub fallback:** if `gh`/the GitHub API is rate-limited or EOFs (CN network),
  `unzoo.sh search-github "<query>"` / `unzoo.sh fetch-github <owner> <repo>` reach
  GitHub through the browser backend and often succeed when `gh` doesn't.
- Check it's up first: `unzoo.sh health` → `{"status":"ok"}`. Endpoints accept
  `url` / `query` / `owner`+`repo`; responses are `{success, data}` JSON.

## Steps

1. **Pick mode.**
   - Full scan (default): `bash .Codex/skills/competitor-feedback/scan.sh`
   - Subscribe / incremental (only issues opened since last run):
     `bash .Codex/skills/competitor-feedback/scan.sh new`
   - Restrict to some competitors: `scan.sh full Logseq SiYuan`
   - Tune volume with `LIMIT=12 scan.sh`.

   The competitor registry is `competitors.json` (edit to add/remove). GitHub-hosted
   ones are fetched directly; the script prints the GitHub digest and then lists the
   closed-source competitors for you to handle in step 2. It also writes `.last-scan`
   so the next `new` run is truly incremental — that's the "subscribe" behaviour.

2. **Web channel for closed-source competitors** (via unzoo — the real browser).
   `unzoo.sh health` first. Then for each closed-source competitor `scan.sh` listed:
   `unzoo.sh fetch-web <forum/reddit url from competitors.json>` and
   `unzoo.sh search-web "<name> bug OR missing feature OR complaint <year>"`.
   (`WebSearch`/`WebFetch` are fallbacks if unzoo is down.) Extract recurring
   themes — don't dump raw posts.

3. **Synthesize — this is the point, not the raw list.** Group everything into
   recurring *themes* (e.g. "sync conflicts", "mobile parity", "large-vault perf",
   "plugin breakage"). For each theme note which competitors it hits and rough volume
   (top-voted issue = strong signal).

4. **Cross-reference against SoloMD.** Read `docs/roadmap.md` and recent SoloMD
   issues (`gh issue list --repo zhitongblog/solomd --state open`). Then output two
   ranked lists:
   - **Win-on:** pains competitors' users repeatedly hit that SoloMD already does
     better or could cheaply own (these are positioning/marketing + wedge opportunities).
   - **Gaps:** things competitors ship that SoloMD lacks and users clearly value
     (candidate roadmap items). Be honest about effort.
   - Flag any theme that overlaps SoloMD's *own* recent complaints (shared weak spot).

5. **Write the report** to `docs/competitor-feedback/YYYY-MM-DD.md` (create the dir).
   Structure: TL;DR (3-5 bullets) → themes table → Win-on → Gaps → raw per-competitor
   appendix (the scan.sh output + web findings, for traceability). Keep the synthesis
   tight and opinionated; the founder reads the TL;DR first.

## Notes
- CN network flakes on the GitHub API — `scan.sh` already retries; if a competitor
  shows "(fetch failed)", just re-run it for that one (`scan.sh full <name>`).
- This is a *read-only research* skill. It never posts to competitors' trackers.
- Cadence suggestion: run `scan.sh new` weekly; it stays incremental via `.last-scan`.
