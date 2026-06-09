# SoloMD MCP

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd?label=SoloMD&color=blue)](https://github.com/zhitongblog/solomd/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total?color=brightgreen)](https://github.com/zhitongblog/solomd/releases)
[![License](https://img.shields.io/github/license/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/blob/main/LICENSE)
[![Get SoloMD](https://img.shields.io/badge/Get%20SoloMD-solomd.app-black)](https://solomd.app)

**MCP server for one or more Markdown notes folders.** 13 tools: read /
search / outline / wikilink backlinks / AutoGit history / share URLs / agent
trace replay. Read-only by default; `--allow-write` opt-in for the 3 write
tools.

Works against any plain folder of `.md` files. Pairs with the
[SoloMD](https://solomd.app) desktop editor for a real GUI agent surface,
but the editor isn't required.

## About SoloMD

[**SoloMD**](https://solomd.app) is a free, MIT-licensed Markdown + plaintext
editor that treats agents as first-class editor surfaces — not external CLI
handoffs. Same `.md` files as your favourite plain-text setup; the editor
adds a Wiki-link + backlink graph, semantic search across your whole vault,
per-note AutoGit history, a streamed Agent panel that cites notes with
`[[wikilinks]]`, and **the same `solomd-mcp` MCP endpoint that this listing
exposes — pre-wired**, so Claude Desktop / Cursor / Claude Code / Cline /
Continue can drive the same vault from outside the app.

You don't need the app to use the MCP server: `solomd-mcp` runs against any
plain folder of `.md` files. But if you want the **Agent panel**, **pending
write accept/reject UI**, **AutoGit branch sandbox per agent run**, and
**BYOK keys in the OS keychain** — get the app.

| | Download |
|---|---|
| 🍎 **macOS** (universal — Apple Silicon + Intel) | [`SoloMD_4.5.6_universal.dmg`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_universal.dmg) |
| 🪟 **Windows** (x64) | [`SoloMD_4.5.6_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_x64_en-US.msi) |
| 🪟 **Windows on ARM** (Snapdragon X / Copilot+ PCs) | [`SoloMD_4.5.6_arm64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_arm64_en-US.msi) |
| 🐧 **Linux** (Debian / Ubuntu) | [`.deb`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_amd64.deb) · [arm64](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_arm64.deb) |
| 🐧 **Linux** (Fedora / RHEL) | [`.rpm`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD-4.5.6-1.x86_64.rpm) · [aarch64](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD-4.5.6-1.aarch64.rpm) |
| 🐧 **Linux** (portable) | [`.AppImage`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_amd64.AppImage) · [aarch64](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_aarch64.AppImage) |
| 🤖 **Android / iPad** | See [solomd.app](https://solomd.app) |

All builds are signed (macOS Developer ID + notarised, Android v2 + v3
keystore). No telemetry account, no SoloMD-hosted servers — your notes, AI
keys, embeddings index, and git history stay on your machine.

## Tools

`solomd-mcp` exposes 13 JSON-RPC tools over stdio. Read tools are always
available; write tools require `--allow-write` at server startup.

### 8 generic Markdown-vault tools

| Tool | What it does |
|---|---|
| `list_notes` | List `.md` files under a workspace (optional `subdir`, `limit`). |
| `read_note` | Return the full contents of one note. |
| `search` | Substring or regex search across the workspace. Returns matches with line numbers. |
| `get_backlinks` | Find every note that contains `[[<name>]]` pointing at a given note. |
| `list_tags` | Aggregate `#tags` across the workspace with occurrence counts. |
| `get_outline` | Heading structure of a note (H1/H2/H3 with line numbers). |
| `write_note` *(needs `--allow-write`)* | Create or overwrite a note. Returns the new path and a diff against any prior version. |
| `append_to_note` *(needs `--allow-write`)* | Append to an existing note (idempotent — won't duplicate a block already present at the bottom). |

### 5 SoloMD-only tools

These exist because SoloMD's vault carries more than just markdown — every
save is an AutoGit commit in a `.git` inside the workspace, and v4.0 added a
trace file per agent run. Most other MCP servers don't have these.

| Tool | What it does |
|---|---|
| `autogit_log` | Per-note commit history (recent revisions, author/date, commit message). |
| `autogit_diff` | Diff between two revisions of one note (or "current vs N commits ago"). |
| `autogit_rollback` *(needs `--allow-write`)* | Restore a note to a specific past commit. |
| `sync_status` | Current sync state with the upstream git remote (ahead/behind, conflicts, dirty files). |
| `share_url` | Generate a `solomd.app/share/?repo=…&path=…` read-only link for a note in a public GitHub repo. |
| `read_agent_trace` | Replay a previous agent recipe run from its `.solomd/agent-runs/<run-id>/trace.jsonl`. |

### Workspace federation

Every tool takes an optional `workspace` argument. Start `solomd-mcp` with
multiple `--workspace` flags to serve more than one vault in a single
session:

```bash
solomd-mcp --workspace work=/Users/me/notes --workspace home=/Users/me/diary
```

Then a tool call with `{"workspace": "home"}` resolves to the right vault.
Without a `workspace` argument the first one registered is the default.

## Skill Pack — 11 ready-made agent recipes

Drop [`solomd-skills-v4.5.6.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/solomd-skills-v4.5.6.zip)
into any vault to seed `.solomd/agents/` with 11 starter recipes:

- `01-weekly-review` — schedule Sundays 18:00, summarise the week's daily/ notes.
- `02-todo-extract` — on-save, pull `- [ ]` lines into `todos.md`.
- `03-translate-zh-to-en` — on-tag-add `#translate`.
- `04-cjk-proofread` — on-save, local-Ollama punctuation + grammar.
- `05-citation-cleanup` — on-tag-add `#cite`.
- `06-meeting-notes-summary` — on-save, decisions / actions.
- `07-link-suggester` — on-save, propose wikilinks.
- `08-daily-summary` — schedule daily 22:00.
- `09-orphan-notes` — schedule weekly.
- `10-on-commit-changelog` — on-commit, maintain CHANGELOG.md.
- `11-tag-classifier` — on-save, suggest tags.

Recipes run inside SoloMD (with the accept/reject UI). For other MCP
clients, treat the YAML as documentation — adapt the prompts to your
client's convention.
