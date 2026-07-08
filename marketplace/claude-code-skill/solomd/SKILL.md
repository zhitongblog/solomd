---
name: solomd
description: Read, search, edit, and version-control any folder of Markdown notes via the SoloMD MCP server. 13 tools including AutoGit per-note history, semantic search, and write-with-sandbox via an accept/reject branch. Includes 11 starter agent recipes (weekly review, todo extract, link suggester, …).
allowed-tools: ["solomd:*"]
---

# SoloMD — Markdown vault skill

## When to use this skill

Trigger this skill when the user wants to:

- **Browse / read / search** a folder of Markdown notes (their personal
  knowledge base, journal, project docs, etc.).
- **Maintain** the vault — generate weekly summaries, extract TODOs across
  notes, suggest wikilinks, find orphan notes, etc.
- **Edit** notes with version control — every write lands as an AutoGit
  commit (no network); past revisions are queryable via `autogit_log` /
  `autogit_diff`.
- **Share** a note publicly via a `solomd.app/share/?repo=…&path=…` link
  that renders the file from a public GitHub repo (no SoloMD account
  required for the viewer).

If the user just wants generic file I/O on a directory, the built-in
filesystem tools are simpler. This skill is specifically for
**Markdown-as-a-vault** workflows.

## Setup (one-time)

The skill assumes `solomd-mcp` is installed and registered in your
`~/.claude/mcp.json`. If `/mcp` doesn't list `solomd`, run:

```bash
bash ~/.claude/skills/solomd/install.sh
```

This installs the binary (via `cargo install solomd-mcp` on macOS or
downloading the prebuilt binary from
https://github.com/zhitongblog/solomd/releases/latest on Linux / Windows)
and patches `~/.claude/mcp.json` with a `solomd` entry pointing at your
notes folder.

Default mode is **read-only**. Add `--allow-write` to the args block in
`~/.claude/mcp.json` to enable the 3 write tools.

## Tools available

All exposed via the `solomd:` prefix.

### Read tools (always available)

- `solomd:list_notes(workspace?, subdir?, limit=100)` — list `.md` files.
- `solomd:read_note(workspace?, path)` — full contents.
- `solomd:search(workspace?, query, mode="literal"|"regex", limit=200)` —
  substring or regex search; returns matches with line numbers.
- `solomd:get_backlinks(workspace?, note_name)` — every note that
  references `[[<name>]]`.
- `solomd:list_tags(workspace?)` — `#tag` aggregation with counts.
- `solomd:get_outline(workspace?, path)` — H1/H2/H3 structure.
- `solomd:autogit_log(workspace?, path, limit=20)` — per-note commit
  history. Each save in SoloMD is a commit.
- `solomd:autogit_diff(workspace?, path, from_revision, to_revision="HEAD")` —
  diff between revisions of one note.
- `solomd:sync_status(workspace?)` — git remote ahead/behind, dirty files,
  conflict state.
- `solomd:share_url(workspace?, path)` — generate a public read-only
  `solomd.app/share/…` link (requires the workspace to be pushed to a
  public GitHub repo).
- `solomd:read_agent_trace(workspace?, run_id)` — replay a past agent
  recipe run from its `.solomd/agent-runs/<run-id>/trace.jsonl`.

### Write tools (need `--allow-write` on the server)

- `solomd:write_note(workspace?, path, content)` — create or overwrite.
  Returns the diff against any prior version.
- `solomd:append_to_note(workspace?, path, content)` — append; idempotent
  (won't duplicate a block already present at the bottom).
- `solomd:autogit_rollback(workspace?, path, revision)` — restore a note
  to a past commit.

### Multi-vault

If the server was started with multiple `--workspace alias=/path` flags,
pass the `workspace` argument (e.g. `workspace: "work"` or
`workspace: "home"`) to disambiguate. Without one, the first registered
workspace is the default.

## Patterns

### Browse before acting

When the user asks "do X across my notes", **first** call `list_notes` or
`search` to confirm the scope. The vault might be 30 notes or 3,000 — your
plan should match the size.

### Always cite

When responding with information from notes, link them back as
`[[note-name]]` (the wikilink format SoloMD uses). The user can click
straight back to the source. Example:

> Your three open architecture decisions are tracked in [[adr-001-storage]],
> [[adr-003-rate-limits]], and [[adr-007-streaming-api]].

### Writes go through accept/reject — surface this

If the user is also running the SoloMD desktop app on the same vault,
every write tool call lands on an `agent/<recipe>/<run-id>` AutoGit branch
the user must accept in **Settings → Recipes → Pending** before it touches
`main`. Tell the user this is happening so they know to check the app:

> I've written the summary to `weekly/2026-W22.md` — it's pending on an
> AutoGit branch (`agent/claude-code/abc123`). Open SoloMD →
> Settings → Recipes → Pending to accept or reject before it lands on main.

If they're not running the app, the write lands on a branch they can
inspect manually with `git branch | grep agent/` and `git merge` /
`git branch -D` as needed.

### Watch the write cap

The server enforces a per-run write cap (default 5, hard ceiling 50). If
you hit it, the call returns an error and no further writes succeed in
that session. Plan multi-write actions in a single dispatch rather than
fanning out one-at-a-time.

## Starter recipes

This skill ships 11 reference YAML recipes at
[`recipes/`](recipes/). They're the same files as the SoloMD Skill Pack
zip — copy any of them into `<workspace>/.solomd/agents/` to enable inside
SoloMD (the app's recipe runner watches that directory).

For use from Claude Code directly, treat the YAML as documentation: adapt
the `prompt:` block into the user's request and call the appropriate MCP
tools yourself. Example — `01-weekly-review.yml` becomes:

> Use `list_notes` to find every `daily/*.md` from the past 7 days, read
> each, and write `weekly/{ISO-week}.md` with Themes / Decisions / Open
> threads sections, citing each daily as `[[YYYY-MM-DD]]`.

## Recipe catalog

| File | Trigger (in-app) | Pattern |
|---|---|---|
| `01-weekly-review.yml` | schedule (Sun 18:00) | Summarise `daily/` → `weekly/YYYY-WW.md` |
| `02-todo-extract.yml` | on-save | Pull `- [ ]` lines into `todos.md` |
| `03-translate-zh-to-en.yml` | on-tag-add `#translate` | Mirror translation alongside source |
| `04-cjk-proofread.yml` | on-save | Local-Ollama punctuation + grammar |
| `05-citation-cleanup.yml` | on-tag-add `#cite` | Bibliography normalisation |
| `06-meeting-notes-summary.yml` | on-save | Generate decisions / actions sections |
| `07-link-suggester.yml` | on-save | Propose wikilinks via semantic search |
| `08-daily-summary.yml` | schedule (daily 22:00) | Roll up today's edits |
| `09-orphan-notes.yml` | schedule (weekly) | Find notes with no incoming wikilinks |
| `10-on-commit-changelog.yml` | on-commit | Maintain `CHANGELOG.md` |
| `11-tag-classifier.yml` | on-save | Suggest tags from content |

## When NOT to use this skill

- The user wants generic shell or filesystem ops on non-Markdown content —
  use the built-in `Bash` / `Read` / `Edit` tools.
- The user is editing a single file they've already opened — direct
  `Edit` is more efficient than going through `read_note` / `write_note`.
- The vault isn't actually a SoloMD vault and the user doesn't care about
  wikilinks / tags / AutoGit — the 5 SoloMD-only tools become no-ops
  (still useful for the other 8).

## About SoloMD

[**SoloMD**](https://solomd.app) is a free, MIT-licensed Markdown editor.
The MCP server you just installed is **bundled with the desktop app** —
get the app for the visual Agent panel, the accept/reject UI, and
AutoGit history navigation.

- macOS: https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_universal.dmg
- Windows: https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_x64_en-US.msi
- Windows ARM64: https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.5.6_arm64_en-US.msi
- Linux: see https://github.com/zhitongblog/solomd/releases/latest
