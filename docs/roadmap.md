# SoloMD product roadmap (post-v2.0)

Last updated: 2026-04-25 · Owner: solo · Status: working draft

This document is the source of truth for what we're building, in what order, and **why**. Each version has a single theme, a small ranked feature list, an effort budget, the risk we're taking, and the metric we're trying to move. If something isn't here, it isn't on the plan — file an issue or update this file.

---

## Strategic principles (the lens for every "yes / no" decision)

1. **One window, one writer.** SoloMD is a tool for the *single* author at the keyboard. We don't pivot to teams (CRDT collab) or to community (forums, social). When in doubt, we make the writer's day better, not the team's.
2. **Local-first, plain `.md`.** Files stay yours. No proprietary database, no required cloud, no lock-in. Sync is opt-in (and a paid tier later); the core experience never depends on it.
3. **Cross-platform is the moat.** Most credible competitors (Tolaria, Moraya, Bear, MiaoYan, iA Writer) are Mac-only or Mac+Linux. We ship Mac + Windows + Linux x64/ARM64 + iPad. **Don't sacrifice this for any feature.**
4. **CJK first-class.** Encoding auto-detect, simplified↔traditional, pinyin export, multi-language UI. SiYuan dominates simplified-Chinese power users; we own writer/academic Chinese, plus Japanese/Korean/Traditional which SiYuan does less well.
5. **Privacy by default.** No telemetry without explicit consent. App Store builds disable it entirely. AI features are opt-in; keys live in OS keychain.
6. **Combination > single feature.** No single feature wins (Tolaria has AutoGit, Moraya has MCP, Khoj has RAG, AFFiNE has canvas). The *combination* of small-installer + 14 AI + Pandoc + iPad + AutoGit + MCP — that's the moat.
7. **Write less code that we have to maintain forever.** Prefer Hunspell / Pandoc / git2 / rmcp over rolling our own.

---

## Versioning policy

- **Patch (`v2.x.Y`)** — bug fixes only, ship within hours of finding the bug.
- **Minor (`v2.X.0`)** — single-theme drops, ~6-8 weeks of design + build.
- **Major (`v3.0`)** — architectural shifts (sync, plugin runtime, scripting). Reserved.

We do **not** ship features piecemeal. Every minor version lands with: bilingual UI, settings panel control, help dialog entry, browser smoke test, no console errors at idle, real Tauri Mac build verified before tag.

---

## v2.2 — "External agents, internal history" · IN PROGRESS

**Theme:** treat the workspace as a first-class tool surface for outside AI agents (MCP) and as a versioned recoverable thing (AutoGit). UX cleanup carry-over from v2.0.

| Feature | Status | Why |
|---|---|---|
| **MCP server** (standalone `solomd-mcp` binary, stdio) — 8 tools (list / read / search / backlinks / tags / outline / write / append) | 🔵 in dev | Tolaria + Moraya + Blinko shipped MCP first. We're catching up; this is now table stakes. |
| **AutoGit per-note history** (libgit2 + History panel + diff + rollback) | ✅ ready (worktree branch) | Tolaria differentiator. Pairs naturally with our existing workspace_index. |
| AI Settings always-visible + Toolbar AI ✨ button | ✅ on `main` | UX fix — users couldn't find AI in v2.0. |
| OpenRouter as 14th provider | ✅ on `main` | Aggregator — one key, hundreds of models. Highest "key-to-models" leverage. |
| Real model lineups (verified vs official docs) | ✅ on `main` | Initial v2.0 used training-data estimates that were stale. |

**Effort:** ~2-3 weeks of agent + integration time (mostly agent-built). 
**Risk:** medium — rmcp SDK is moving fast; libgit2 has platform-specific gotchas (Linux libssl) we mitigate with `vendored-libgit2`. 
**Success metric:** v2.2 download count surpasses v2.0 within 2 weeks of release. README CTR from "MCP server" / "AutoGit" search terms.

---

## v2.3 — "Ask your vault" · target: 4-6 weeks after v2.2

**Theme:** local RAG. The biggest feature gap surfaced by the April 2026 competitive sweep — Khoj, Blinko, Moraya, Reor all ship vault-wide semantic search. SoloMD's AI today is per-document only. Closing this gap is the v2.3 hero.

| Feature | Why | Effort estimate |
|---|---|---|
| **Local embeddings** of every `.md` in workspace (BGE-small / mxbai-embed-xsmall via `candle` or ONNX runtime, ~200 MB model bundled or download-on-first-enable) | RAG without the cloud round-trip | L (8-10 days) |
| **Vector store** in `<workspace>/.solomd/index.sqlite` (sqlite-vec or hnsw-rs) | Persistent, fast, per-workspace | M (4 days) |
| **Semantic search box** in the existing Global Search dialog — "find by meaning" alongside "find literal text" | Discovery without forced learning | M (3 days) |
| **"Ask my vault" panel** — chat-style, streams the AI provider's response with citations to the source notes (`[[note]]` deep links inline) | The headline UX | L (7 days) |
| **Auto-reindex** on file save / via the existing notify watcher | Keep results fresh | S (2 days) |
| **Settings panel:** model picker (BGE / mxbai / disable), index size budget, "rebuild index" button | Power users + transparency | S (1 day) |

**Total:** ~5-6 weeks. **Risk:** moderate — embedding model bundling is heavy (200-400 MB); we test "download-on-first-enable" vs bundled to keep installer at 15 MB. **Success metric:** 30 % of new users enable vault chat in their first 7 days. Net Promoter Score among power users.

**Why not block-editor / canvas:** AFFiNE / SiYuan / Anytype already won that lane. We're text-first; that's the brand. Don't blur it.

---

## v2.4 — "Bridge to anywhere" · target: ASAP after v2.3 (single-day rollouts authorized)

**Theme:** SoloMD becomes interoperable with everything else the user already has — a vault that talks to other tools, both inbound (web pages, iOS, scripts) and outbound (Claude Desktop, Cursor, terminal). Originally scoped as "Capture from anywhere"; rebadged 2026-04-26 once we realized CLI / MCP first-class shipping is the same arc as inbound capture — they're all *bridges* across SoloMD's boundary.

| Feature | Why | Effort |
|---|---|---|
| **CLI first-class** — `solomd` CLI surfaced in Settings → Integrations panel with status check + reinstall button + copy-to-clipboard install command | Today the CLI is curl-bash only; users don't know it exists | S (1 day) |
| **MCP server bundled in the desktop app** — `solomd-mcp` as Tauri sidecar (`/Applications/SoloMD.app/Contents/MacOS/solomd-mcp` etc.), Settings → Integrations shows path + ready-to-paste Claude Desktop config | `install-mcp.sh` 404s today because CI doesn't produce tarballs; bundling solves both UX + distribution at once | M (3 days) |
| **CI publishes solomd-mcp tarballs** — `solomd-mcp-<platform>-<arch>.tar.gz` per release, so `install-mcp.sh` actually works | Standalone install path for users who don't want the desktop app | S (1 day) |
| **HTTP capture endpoint** in the desktop app — `POST localhost:7777/capture` with markdown body, returns the new note's path. Webhooks-ready. Token auth, 127.0.0.1 only — same security posture as the dev-bridge but release-grade. | Lets `curl` / shortcuts / iOS shortcuts / shell scripts capture | S (3 days) |
| **Inbox workflow** (Tolaria-inspired) — `inbox: true` YAML field, `Cmd+E` marks organized, sidebar inbox count badge | Structured triage without forcing folders; pairs with capture endpoint | S (2 days) |
| **Browser web clipper** (Chrome + Firefox WebExtension) — sends selected text or whole page → local Tauri HTTP endpoint → new note in inbox | Joplin / Obsidian / Notesnook all have it; lowest-effort capture-loop closure | M (5 days) |
| **iOS Shortcuts integration** for iPad app — "Append to today's daily note" / "New quick capture" actions, hits the same capture endpoint | iPad story gets stronger | M (4 days) |
| **Public reading mode** — single-doc preview without editor chrome, for screen-share / class-reading | Tiny but high-impact for teachers; can split off as v2.5 if v2.4 inflates | S (1 day) |

**Total:** ~4 weeks if done sequentially; sub-day if multiple worktree agents run in parallel (the CLI/MCP + capture-endpoint + clipper layers are mostly independent files). **Risk:** low — all standard patterns. **Success metric:** count of users with `aiEnabled = false` who use web clipper (proves capture works for non-AI users).

---

## v2.5 — "Polish the writer's day" · target: 1 month after v2.4

**Theme:** the boring-but-loved features. Quality-of-life improvements that don't make the press but keep daily users.

| Feature | Why | Effort |
|---|---|---|
| **Recent files quick switcher** (`⌘P`) — VSCode-style fuzzy finder, surfaces frequently-edited + recently-edited | Hot path for multi-file workflows | S (2 days) |
| **Word goals + writing stats** per doc (YAML `goal: 1500`, status-bar progress bar) — Ulysses-inspired | Long-form writers want this | S (2 days) |
| **Better export defaults** — page size / margin / font picker for print + PDF, remember per-document | Pandoc-less PDF still matters | M (4 days) |
| **Zen / focus session timer** (Pomodoro built into the focus mode) — opt-in, no nagging | Modest, popular | S (1 day) |
| **Theme marketplace** — curated `.css` files from community, click-install (just downloads CSS to settings folder) | Lightweight plugins-without-plugins | M (5 days) |
| **CJK proofread mode** — flags common Chinese typos (errant 的/地/得, half/full-width punctuation), one-click fix | We own the CJK lane; no competitor does this well | M (5 days) |

**Total:** ~3-4 weeks. **Risk:** low. **Success metric:** retention at 30 days after install.

---

## v3.0 — "Sync, optionally" · target: 4-6 months after v2.5 (Q3 2026)

**Theme:** SoloMD's biggest moat against Obsidian. Sync as paid tier (~$3-5/month or $30/year), with always-free local + git options.

| Feature | Why | Effort |
|---|---|---|
| **Git-based sync** (free) — built-in client, push/pull on save, conflict resolution UI | Already ~70 % of "sync" demand. Free tier. | M (built on AutoGit) |
| **iCloud Drive / Dropbox / OneDrive folder integration** (free) — just point at synced folder, hands off | Even simpler than git for non-technical users | S (3 days) |
| **SoloMD Sync** (paid) — CRDT-based, real-time, end-to-end encrypted (XChaCha20-Poly1305) | Obsidian Sync is $96/year and mediocre. We undercut at $30. | XL (12-16 weeks) |
| Encrypted-at-rest keys via OS keychain | E2EE without user pain | M (built on existing keyring) |
| Web client (read-only, view-only) for sharing a note via link | "Show my note" on phone / shared link | M (3 weeks) |
| Cross-device session restore | "Pick up where I left off on the other device" | M (1 week) |

**Total:** 4-6 months. **Risk:** **HIGH** — billing infrastructure, server ops, support burden, regulatory (data residency). This is where SoloMD becomes a business, not just a project. Decision needed *before* starting v3.0: do we want to be a business, or stay a hobby OSS project?

**Alternative:** ship the *git-based sync* + *iCloud folder* subset as v2.6, defer the paid CRDT sync until we have evidence of $/willingness-to-pay (e.g. via a "join the waitlist" landing page during v2.5).

**Success metric:** 5 % of MAU convert to paid sync within 6 months of launch.

---

## v3.x — "Open the platform" · target: post-v3.0

**Theme:** controlled extensibility. Users who want more than CSS theming can write code without us shipping a full Obsidian-style plugin marketplace (which is a 10x maintenance tax).

| Feature | Why | Effort |
|---|---|---|
| **Scripting API** (JS sandboxed in webview) — limited tool surface (read note, write note, dispatch command). Not full plugins. | Trilium-style "I want to script my workflow." | L (6 weeks) |
| **Public REST API** (HTTP, opt-in, localhost-only by default) — same surface as MCP server but for any client | Power users wire up Alfred / Raycast / Tasker | M (4 weeks) |
| **`solomd` CLI v2** — extends to call AI rewrite / commit / search semantic | Terminal-first users go deeper | M (2 weeks) |

**Skip:** full plugin runtime (Wasm / V8 with capability scopes). It's the right v4 direction if v3 takes off, not now.

---

## Continuous (every release, every week)

- **README rewrite for SEO + GitHub star traffic** — concrete numbers vs Obsidian/Typora, "iPad native" badge, "no telemetry" badge, inline `vs-X` table. (Task #134.)
- **App Store presence** — MAS resubmission as soon as cert clears (#89). iPad app metadata localizations (en + zh now; ja / ko / fr / de queued).
- **Community surfaces** — closing 80 % of issues within 7 days. PR contributors named in release notes (current: @beihai23 / @luckylew23 — keep momentum).
- **Comparative pages on solomd.app** — every credible competitor gets a `/compare/vs-X` page (currently: Typora, Obsidian, MarkText, Tolaria). To add: SiYuan, Moraya, Heynote, AFFiNE. Homepage compare table stays focused on the names users *search for* — Typora / Obsidian / MarkText only.
- **Twitter / V2EX / 小报童 / HN** posts at every minor release. Lead with the *combination* angle, not single feature.
- **Issue triage rules:** P0 (data loss / crash) within 4h; P1 (broken feature) within 48h; P2 within the next minor. Don't let the issue tracker grow a backlog tail.

---

## What we explicitly skip

| Feature | Why we skip |
|---|---|
| **Block editor** (Notion-style) | AFFiNE / SiYuan / Anytype own this. Different brand. Switching paradigms = 6 months of rewrite for unclear ROI. |
| **Infinite canvas / whiteboard** | Same. Plus we don't have the right team. |
| **Real-time collaboration** | Off-mission for "solo." Reconsider only as part of paid sync if a clear team market shows up. |
| **Graph view** (the spider-web of notes) | Eye candy. Low daily-use value. High effort. Obsidian users who want it can stay on Obsidian. |
| **Spaced repetition / Anki-style flashcards** | SiYuan + Logseq cover it. Niche. |
| **Native scripting in Lua / Python** | Plugin runtime adjacency; defer until v3.x. |
| **Mobile apps (Android)** | iPad covers the iOS side. Android takes a quarter of work for marginal mindshare gain. Reconsider when iPad MAU > 5k. |
| **Chinese cloud sync (e.g. via 阿里云盘)** | Folder integration works for any synced folder; no per-vendor adapters needed. |

---

## Decision log

- **2026-04-25** — Tolaria added to competitor tracking (memory: `competitor_tolaria.md`). Roadmap pivots: v2.2 adds AutoGit + MCP to match.
- **2026-04-25** — Moraya identified as direct architectural twin (Tauri 2 + Rust + MCP + keychain) via GitHub sweep. v2.2 narrative shifts from "MCP launch" to "MCP+AutoGit+iPad combination."
- **2026-04-25** — Local RAG promoted to v2.3 hero feature. Largest field-wide gap.
- **2026-04-25** — v3.0 scoped as "sync optional, paid tier candidate." Decision deferred until v2.5 ships.
- **2026-04-26** — v2.4 retitled from "Capture from anywhere" to "Bridge to anywhere"; added CLI / MCP first-class as the outbound half of the same arc. Same week as v2.3 release; user-authorized "连发多个版本" cadence.

---

## How to use this doc

- When the user asks "what's next?" → walk top to bottom, ~3 versions ahead.
- When PR adds a feature → either it fits a roadmap version, or PR description explains why we should add it.
- When competitor does X → add an entry under "Decision log" with date + reaction.
- When a roadmap item is "considered and skipped" → list under "What we explicitly skip" with the reason.
