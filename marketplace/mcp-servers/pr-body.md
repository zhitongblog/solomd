## Adding SoloMD MCP to Community Servers

### What it is

`solomd-mcp` is the MCP server bundled with [SoloMD](https://solomd.app), a
free MIT-licensed Markdown editor with a built-in agent surface. The server
also runs standalone against any plain folder of `.md` files.

13 tools over stdio (JSON-RPC):

- **8 generic** — `list_notes`, `read_note`, `search`, `get_backlinks`,
  `list_tags`, `get_outline`, `write_note`, `append_to_note`.
- **5 SoloMD-specific** — `autogit_log`, `autogit_diff`, `autogit_rollback`,
  `sync_status`, `share_url`. These leverage SoloMD's per-note AutoGit
  history (every save is a commit in a `.git` inside the workspace).
- **1 trace replayer** — `read_agent_trace` for replaying past
  agent recipe runs.

Read-only by default; `--allow-write` opt-in for the 3 write tools.

### Multi-vault federation

```bash
solomd-mcp --workspace work=/Users/me/notes --workspace home=/Users/me/diary
```

Tool calls take an optional `workspace` argument; without one, the first
workspace registered is the default (back-compat with single-vault clients).

### Distribution

- Prebuilt binaries on [every GitHub release](https://github.com/zhitongblog/solomd/releases/latest)
  for linux-x64, linux-arm64, win-x64, win-arm64 (~4 MB each).
- macOS users install via `cargo install solomd-mcp` or use the bundled
  binary inside the SoloMD app distribution.
- A [Dockerfile](https://github.com/zhitongblog/solomd/blob/main/marketplace/smithery/Dockerfile)
  is also available for unsupported platforms or containerised deploys.

### Tested with

- Claude Desktop (macOS, Windows)
- Claude Code
- Cursor
- Cline (VS Code)
- Continue.dev
- Zed (via its `mcp` block)

Per-client install snippets at
https://github.com/zhitongblog/solomd/tree/main/marketplace/client-docs.

### Where it goes

I've placed the entry under "🌎 Community Servers" in alphabetical order.
Happy to move it if there's a better section — let me know.

### Maintainer

- Owner: @zhitongblog (Alex / lixd220@gmail.com)
- Repo: https://github.com/zhitongblog/solomd
- License: MIT
- Issues + PRs welcome.

### Verification

- 28 release assets per build (Mac dmg + 8 Windows + 6 Linux + 4 Android +
  4 web-clipper + 4 MCP sidecar + 1 Skill Pack).
- All builds signed: macOS Developer ID + notarised, Android v2+v3
  keystore, Mozilla AMO signing for the Firefox web-clipper.
- v4.4.1 was verified end-to-end on three platforms (Mac dmg, Win11 ARM64
  VM, Ubuntu 24.04 arm64 VM) before publishing.
