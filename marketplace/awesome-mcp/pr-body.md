<!-- Reuse across all 3 awesome-mcp PRs. Replace {LIST} / {SECTION} per
     submission. -->

## Adding SoloMD to {LIST}

### What it is

`solomd-mcp` is the MCP server bundled with [SoloMD](https://solomd.app),
a free MIT-licensed Markdown editor with a built-in agent surface. The
server also runs standalone against any plain folder of `.md` files — no
SoloMD account, no SoloMD-hosted servers.

13 tools over stdio (JSON-RPC):

- **8 generic Markdown-vault tools** — `list_notes`, `read_note`, `search`
  (literal + regex), `get_backlinks` (wikilink graph),
  `list_tags` (`#tag` aggregation with counts), `get_outline`,
  `write_note`, `append_to_note`.
- **5 SoloMD-specific tools** — `autogit_log`, `autogit_diff`,
  `autogit_rollback`, `sync_status`, `share_url`. These exist because
  SoloMD's vault carries per-note AutoGit history (every save is a commit
  in a `.git` inside the workspace). Most other Markdown MCP servers
  don't have these.
- **1 trace replayer** — `read_agent_trace` for replaying past agent
  recipe runs.

Read-only by default; `--allow-write` opt-in for the 3 write tools.

### Multi-vault federation

```bash
solomd-mcp --workspace work=/Users/me/work-notes \
           --workspace home=/Users/me/diary
```

One MCP session can serve multiple vaults — tool calls take an optional
`workspace` argument to disambiguate, and a missing argument falls back
to the first registered workspace (back-compat with single-vault clients).

### Tested with

Claude Desktop, Claude Code, Cursor, Cline (VS Code), Continue.dev, Zed.
Per-client install snippets at
https://github.com/zhitongblog/solomd/tree/main/marketplace/client-docs.

### Where it fits

Section: **{SECTION}** — Markdown / Note Taking / Knowledge & Memory
seems like the closest match. Happy to move it if there's a better fit.

### Distribution

- **Prebuilt binaries** on [every GitHub release](https://github.com/zhitongblog/solomd/releases/latest)
  for linux-x64, linux-arm64, win-x64, win-arm64 (~4 MB each, signed).
- **macOS**: `cargo install solomd-mcp` (crate published to crates.io as
  `solomd-mcp`), or use the binary bundled inside SoloMD.app from
  https://solomd.app.
- **Docker** for unsupported platforms / CI:
  https://github.com/zhitongblog/solomd/blob/main/marketplace/smithery/Dockerfile.

### Maintainer

@zhitongblog (Alex / lixd220@gmail.com) — same as the SoloMD repo owner.
License: MIT. Issues + PRs welcome at https://github.com/zhitongblog/solomd.
