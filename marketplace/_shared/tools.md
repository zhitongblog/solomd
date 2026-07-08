<!-- SHARED — paste into every market listing. Source of truth for the
     `solomd-mcp` tool inventory. Update here, repaste downstream. -->

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
Without a `workspace` argument the first one registered is the default
(back-compat with single-vault clients).
