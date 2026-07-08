# SoloMD product roadmap

Last updated: 2026-04-29 · Owner: solo · Status: working draft

This document is the source of truth for what we're building, in what order, and **why**. Each version has a single theme, a small ranked feature list, an effort budget, the risk we're taking, and the metric we're trying to move. If something isn't here, it isn't on the plan — file an issue or update this file.

---

## Strategic principles (the lens for every "yes / no" decision)

1. **One window, one writer.** SoloMD is a tool for the *single* author at the keyboard. We don't pivot to teams (CRDT collab) or to community (forums, social). When in doubt, we make the writer's day better, not the team's.
2. **Local-first, plain `.md`.** Files stay yours. No proprietary database, no required cloud, no lock-in. Sync is opt-in (and a paid tier candidate later); the core experience never depends on it.
3. **Cross-platform is the moat.** Most credible competitors (Tolaria, Moraya, Bear, MiaoYan, iA Writer) are Mac-only or Mac+Linux. We ship Mac + Windows + Linux x64/ARM64 + iPad. **Don't sacrifice this for any feature.**
4. **CJK first-class.** Encoding auto-detect, simplified↔traditional, pinyin export, multi-language UI. SiYuan dominates simplified-Chinese power users; we own writer/academic Chinese, plus Japanese/Korean/Traditional which SiYuan does less well.
5. **Privacy by default.** No telemetry without explicit consent. App Store builds disable it entirely. AI features are opt-in; keys live in OS keychain.
6. **Combination > single feature.** No single feature wins (Tolaria has AutoGit, Moraya has MCP, Khoj has RAG, AFFiNE has canvas). The *combination* of small-installer + 14 AI + Pandoc + iPad + AutoGit + MCP — that's the moat.
7. **Write less code that we have to maintain forever.** Prefer Hunspell / Pandoc / git2 / rmcp / Ollama over rolling our own.

---

## Versioning policy

- **Patch (`v3.6.Y`)** — bug fixes only, ship within hours of finding the bug.
- **Minor (`vX.Y.0`)** — single-theme drops. **Currently skipped:** see "v4.0 quiet phase" below.
- **Major (`v4.0`)** — architectural / capability-wave shifts. Reserved for theme-defining moments.

We do **not** ship features piecemeal. Every minor version lands with: bilingual UI, Settings panel control, Help dialog entry, browser smoke test, no console errors at idle, real Tauri Mac build verified before tag.

### v4.0 quiet phase rules (current)

The project is in **"憋大招" mode** through v4.0 release. Operating rules:

1. `main` is **patch-only** — bug fixes / security / docs / CI only. **No new features merged to main.**
2. v3.7 / v3.8 are **skipped entirely**. Next minor tag is **v4.0**. Patches continue as v3.6.3 / v3.6.4 / etc. on demand.
3. v4.0 has **no hard deadline**. Soft target Q3 2026 (Sep). Done = all 5 v4.0 pillars self-tested + bilingual + Tauri release build verified. **Quality gate before timeline.**
4. **Patches still ship fast** for real bugs — data loss / crash → same-day patch. 憋大招 ≠ ignore bugs.
5. Public visibility during quiet phase: **monthly dev log** to Telegram / V2EX / WeChat / 小报童; GitHub Discussions tracker for the 5 pillars; visible v3.6.x patches when warranted.

**Why this phase exists:** the v3.x cadence (5 minor releases in ~2 months: 3.5 / 3.5.5 / 3.6 / 3.6.1 / 3.6.2) over-trained "rapid release" muscle. The user-perceived signal flipped from "new feature" to "instability." v4.0 is the natural pause point — feature surface is already strong; time to bake the next capability wave properly.

---

## v3.6.x — current state (April 2026)

Latest tag: **v3.6.2**. Project is feature-stable. `main` accepts only patches until v4.0 ships.

Shipped foundation (any v4.0 work assumes this is in place):

- **Editor.** WYSIWYG live-edit (incl. image+table widgets in v3.6), tabs+splits, KaTeX+Mermaid, image paste to `_assets/`, slideshow (`⌘⌥P`), Vim mode, Hunspell+CJK proofread, semantic search (`⌘⇧F`), wikilinks+backlinks, Pandoc export, CJK encoding auto-detect (GBK / Big5 / Shift-JIS).
- **AI.** 14 BYOK providers — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · **Ollama**. Per-document rewrite, AI Settings + Toolbar AI button, real verified model lineups.
- **Sync.** GitHub-backed push-on-save, optional E2EE (Argon2id + XChaCha20-Poly1305), GitLab/Gitea/any HTTPS git URL, public read-only share at `solomd.app/share/?repo=…&path=…`.
- **Agent endpoint.** `solomd-mcp` bundled (13 tools, 5 SoloMD-only: `autogit_log` / `autogit_diff` / `autogit_rollback` / `sync_status` / `share_url`); `solomd agent <prompt>` CLI handoff to claude / codex.
- **AutoGit.** Per-note libgit2 commits inside the workspace, `vendored-libgit2` (no system git needed), History panel + diff + rollback.
- **Capture.** HTTP localhost endpoint (token auth, 127.0.0.1 only), browser web clipper (Chrome MV3 + Firefox MV2), iOS Shortcuts integration on iPad.
- **Polish.** ⌘P quick switcher, word goals + writing stats, Pomodoro/Zen, theme marketplace, slash commands (20-block catalog), reading mode, recent-edits store, file-tree right-click + inline rename.
- **Distribution.** macOS universal dmg (~32 MB, notarized) + Homebrew tap · Windows MSI/NSIS/portable + winget · Linux AppImage/deb/rpm (x86_64+aarch64) + AUR · iPad App Store · **Gitee mirror** for CN.

---

## v4.0 — "Agent-native author" · NEXT MAJOR · target Q3 2026

**Theme.** SoloMD has the strongest agent surface of any local-first markdown editor (5 SoloMD-only MCP tools nobody else has). v4.0 brings that capability **inside** the app and turns the workspace into a place where agents work **continuously**, not just on-demand. Brand evolves from *"the editor + the MCP endpoint"* to ***"the editor where agents live."***

### The 5 pillars

#### 1. Inline Agent Panel · ~2 weeks · branch `feat/v4-panel`

Right-side first-class panel (peer to Outline / Backlinks). Streamed chat-with-vault routed through in-process `solomd-mcp` + the existing 14-provider AI stack. Citations resolve to `[[note]]` deep links. Tool-call cards (Cursor-style) show every MCP read/write inline, expandable for full args + result. Run history persists as plain markdown in `<workspace>/.solomd/agent-runs/<ts>.md` — grep-able, git-trackable.

**Why:** today users either run external Claude Code (lose vault UI context) or per-document rewrite (too narrow). Vault chat is the missing middle.

#### 2. Agent Recipes / Scheduled Runs · ~2.5 weeks · branch `feat/v4-recipes`

Declarative agent jobs as YAML in vault: `<workspace>/.solomd/agents/*.yml`.

```yaml
name: Weekly review
schedule: "0 18 * * SUN"           # cron
trigger: schedule                  # | on-save | on-commit | on-tag
match: "daily/**/*.md"
prompt: |
  Read this week's daily/ notes.
  Write weekly/{{date:YYYY-WW}}.md: themes / decisions / open threads.
allow-write: true
write-cap: 5
provider: claude                   # or `local` for Ollama
```

Triggers: `schedule` (cron) · `on-save` · `on-commit` · `on-tag-add` · command-palette manual.

**Safety rails (non-negotiable):**
- Every run gets its own AutoGit branch `agent/<recipe>/<run-id>`. Writes are **review-able**, accept/reject UI mandatory before merge to main.
- `write-cap` default 5; hard upper bound configurable.
- Rejected run = `git branch -D`; never pollutes main.

**Why:** closes "agent capable" → "agent productive over time." Tolaria / Moraya / Obsidian don't have this.

#### 3. Agent Trace View · ~1 week · branch `feat/v4-trace`

Every run (Panel chat OR Recipe) emits `<workspace>/.solomd/agent-runs/<run-id>/trace.jsonl` — line-delimited so live-tail-able during long runs. Schema: step kind (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit` / `done`), timestamps, tool args, truncated results, token counts, cost estimate, AutoGit branch refs.

UI: collapsible step cards (Panel inline + Settings → Recipes history), step-detail drawer, replay-from-step button, cost breakdown per-step. New MCP tool `read_agent_trace(run_id)` — traces become introspectable by other agents → opens the door to self-correcting recipes.

**Why:** without this, Recipes are scary autonomous writes users disable. Trace view is what makes pillar 2 *usable*. Absorbs the standalone "audit log" line item from earlier scoping.

#### 4. Workspace Federation · ~1.5 weeks · branch `feat/v4-federation`

`solomd-mcp --workspace path1 --workspace path2 --workspace path3` (multi-workspace MCP session). Tool signatures gain optional `workspace` param; default = first-passed (back-compat). AutoGit branches isolated per workspace. Settings → Integrations adds **MCP profiles** — named workspace bundles with one-click "copy Claude Desktop config" buttons.

**Why:** natural evolution of *"the LLM only sees what you point the workspace at"* — now point at multiple, explicitly. Today users open multiple Claude Code sessions to bridge two vaults; v4.0 makes one session enough.

#### 5. Ollama first-class polish · ~0.5 weeks · branch `feat/v4-ollama-polish`

**Decision (2026-04-29): do NOT bundle a local LLM runtime.** Ollama is already in our 14-provider list and does this well. We polish the integration instead:

- Auto-detect Ollama at `localhost:11434` (green status indicator in Settings → AI).
- "Install Ollama" button if not detected (links to ollama.com — we don't proxy the download).
- Call `/api/tags` to list installed models; empty list → "Pull recommended (Qwen2.5 1.5B, ~1 GB)" inline button.
- 3 built-in presets: **rewrite** (qwen2.5:7b) / **quick** (qwen2.5:1.5b) / **CJK-friendly** (qwen2.5:14b).
- Recipes can specify `provider: local` as default → cheap autonomous loops.

**Why:** principle #7 ("write less code we maintain forever") + the 32 MB installer stays 32 MB. The privacy framing — *"your notes never leave the machine"* — is true today via BYOK Ollama; v4.0 just makes it discoverable.

### Bundled small extras

- **Public REST API** (localhost only, token auth) — same surface as MCP for Alfred / Raycast / n8n / clients that don't speak MCP. ~4 days.
- **BYOK cost meter** — per-provider running tokens-spent counter, opt-in. ~2 days.

### Quality bar (using freed 憋大招 budget)

The "save the announce" arc. New users meet v4.0 through these surfaces, not the pillars directly:

- **First-run wizard** — new install sees Panel within 60s; guides BYOK or Ollama setup. ~3 days.
- **Recipe Cookbook** — vault ships with 10+ ready-to-edit recipes (weekly review / 日志整理 / TODO 抽取 / 翻译 / 引用清理 / CJK proofread agent / …). ~3 days.
- **`docs/agents.md`** — write-your-own-recipe guide + prompt template cheatsheet. ~2 days.
- **Website rewrite** — `solomd.app` homepage shifts to agent-first narrative + embedded demo video. ~1 week.
- **2-week beta channel** — v4.0-rc.1 → rc.2 → tag. Telegram + WeChat groups notified. (Process, not engineering time.)
- **Localization** — ja / ko translations for README + iPad app metadata (queued in Continuous list). ~3 days.

### Effort budget

| Block | Weeks |
|---|---|
| Pillar 1 — Agent Panel | 2.0 |
| Pillar 2 — Recipes + scheduling | 2.5 |
| Pillar 3 — Trace View | 1.0 |
| Pillar 4 — Federation | 1.5 |
| Pillar 5 — Ollama polish | 0.5 |
| REST API + cost meter | 1.0 |
| Quality bar (wizard / cookbook / docs / website / ja+ko) | 3.0 |
| Bilingual UI + Settings/Help wiring + smoke-test pass + Tauri release build verify | 1.0 |
| **Total** | **~12 weeks** |

### Risks

| Risk | Mitigation |
|---|---|
| Recipe loops spam writes / corrupt vault | AutoGit branch sandbox + `write-cap` hard upper + accept/reject UI before main merge |
| MCP federation breaks single-workspace assumptions | Single-workspace remains default behavior; multiple `--workspace` is opt-in; back-compat tested |
| Scope creep — 5 pillars is heavy | Definition-of-done = all 5 self-tested + bilingual + Tauri release verified. **No "v4.1 will polish."** |
| Quiet phase reads as "project is dead" | Monthly dev log + GitHub Discussions tracker + visible v3.6.x patches |
| Ollama not installed on most users' machines | Quality-bar wizard makes the install path 1-click; BYOK cloud providers remain default |

### Success metrics

- **Agent Panel DAU** — ≥40% of AI-enabled installs use the panel weekly.
- **Recipes** — median active install runs ≥1 scheduled recipe.
- **Local LLM (via Ollama)** — ≥15% of AI-enabled installs select Ollama provider. Proves the privacy story landed.
- **First Panel chat** — ≥50% of new installs complete one within 7 days.

### What v4.0 explicitly skips

| Skipped | Why |
|---|---|
| Multi-user / team agents | Violates "one window, one writer." |
| Online recipe marketplace | Server ops + moderation = off-mission. |
| Copilot-style ghost-text autocomplete | Different brand, dilutes "writer first." |
| Anthropic / OpenAI cloud-agent platform integrations | Couples release cycle to vendor product. |
| Bundled local LLM runtime | Re-implements Ollama. Violates principle #7. |

---

## v4.x and beyond — open directions (not committed)

- **"Open the platform"** — sandboxed scripting API (JS in webview, capability-scoped), public REST surface evolution. Trilium-style "I want to script my workflow." Effort: L. Decision deferred until v4.0 lands and we know which extension shape users actually need.
- **CLI v2** — extends to AI rewrite / commit / semantic search / recipe-trigger from terminal. M.
- **Sync as paid tier** — original v3.0 question, still unanswered. SoloMD Sync (CRDT, E2EE, $30/yr challenger to Obsidian Sync $96). **XL** — billing + ops + support + regulatory. **Pre-decision required:** *"do we want to be a business?"* Don't start engineering until that's answered.
- **Plugin runtime** (Wasm / V8 with capability scopes) — defer until we see whether the v4.x scripting API covers 80% of demand.
- **Android** — reconsider when iPad MAU > 5k.

---

## Continuous (every release, every week)

- README + bilingual whats-new updates per release (in quiet phase: per *patch* and per *dev log*).
- App Store presence — MAS resubmission tracking, iPad app metadata localizations (en/zh shipped; **ja/ko slated for v4.0 quality bar**; fr/de queued).
- Community surfaces — closing 80% of issues within 7 days, PR contributors named in release notes.
- Comparative `/compare/vs-X` pages on solomd.app — currently: Typora, Obsidian, MarkText, Tolaria. Queued: SiYuan, Moraya, Heynote, AFFiNE.
- **In quiet phase:** monthly dev log to Telegram / V2EX / 小报童 / WeChat instead of release-driven posts. v3.6.x patches still get short notes.
- Issue triage: P0 (data loss / crash) within 4h; P1 (broken feature) within 48h; P2 within next minor (= v4.0 in current phase).

---

## What we explicitly skip

| Feature | Why we skip |
|---|---|
| **Block editor** (Notion-style) | AFFiNE / SiYuan / Anytype own this. Different brand. 6-month rewrite for unclear ROI. |
| **Infinite canvas / whiteboard** | Same. Plus we don't have the right team. |
| **Real-time collaboration** | Off-mission for "solo." Reconsider only as part of paid sync if a clear team market shows up. |
| **Graph view** | Eye candy. Low daily-use value, high effort. Obsidian users who want it stay on Obsidian. |
| **Spaced repetition / Anki-style flashcards** | SiYuan + Logseq cover it. Niche. |
| **Native scripting in Lua / Python** | See v4.x scripting API direction; defer until v3 ⇒ v4 ⇒ v4.x. |
| **Mobile (Android)** | iPad covers iOS. Android takes a quarter of work for marginal mindshare gain. Reconsider when iPad MAU > 5k. |
| **Chinese cloud-vendor sync adapters** (阿里云盘, 百度网盘, …) | Folder integration works for any synced folder; no per-vendor adapters. |
| **Bundled local LLM runtime** | Re-implements Ollama. Already supported as BYOK provider. Violates principle #7. |
| **Multi-user / team agents** | Violates "one window, one writer." |
| **Online recipe marketplace** | Server ops + moderation = off-mission. |
| **Copilot-style ghost-text autocomplete** | Different brand from "writer first." |

---

## Decision log

- **2026-04-25** — Tolaria added to competitor tracking. v2.2 adds AutoGit + MCP to match.
- **2026-04-25** — Moraya identified as architectural twin (Tauri 2 + Rust + MCP + keychain). v2.2 narrative shifts to "MCP+AutoGit+iPad combination."
- **2026-04-25** — Local RAG promoted to v2.3 hero feature. Largest field-wide gap.
- **2026-04-25** — v3.0 scoped as "sync optional, paid tier candidate." Decision deferred.
- **2026-04-26** — v2.4 retitled "Bridge to anywhere"; CLI/MCP first-class added.
- **2026-04-29** — **v3.x cadence retrospective.** 5 minor releases in ~2 months (3.5 / 3.5.5 / 3.6 / 3.6.1 / 3.6.2) over-trained "rapid release" muscle. User-perceived signal flipped from "new feature" to "instability." Conclusion: project is feature-stable; time to 憋大招.
- **2026-04-29** — **v4.0 theme: "Agent-native author."** 5 pillars (Panel + Recipes + Trace + Federation + Ollama polish) + REST + cost meter + quality bar. Soft target Q3 2026. ~12 weeks.
- **2026-04-29** — **Bundled local LLM runtime rejected.** Ollama already in 14-provider list; re-implementing violates principle #7. Pillar 5 reframed as "Ollama first-class polish" (~0.5 weeks instead of 3).
- **2026-04-29** — **Trace View promoted to its own pillar.** Originally a 2-day "audit log" line item; expanded to ~1 week because without trace visibility, Recipes (pillar 2) become scary writes that users disable. Trace is what makes Recipes safe to ship.
- **2026-04-29** — **`main` enters patch-only mode** until v4.0 tags. v3.7 / v3.8 skipped entirely. Patches as v3.6.3+ on demand. v4.0 work goes to `feat/v4-*` branches.
- **2026-04-29** — Stale `feat/v2*` and `worktree-agent-*` branches (38 visible, all features shipped to main) audited for deletion. Cleanup pending user review.

---

## How to use this doc

- When the user asks "what's next?" → walk top to bottom; focus on v4.0 pillars.
- When a PR lands → either it fits a v4.0 pillar or v3.6.x patch criteria, or the PR description explains why we should accept it anyway.
- When competitor does X → add a Decision log entry with date + reaction.
- When a feature is "considered and skipped" → list under "What we explicitly skip" with the reason.
- **During quiet phase: don't merge new features to main.** Route to `feat/v4-*`.
