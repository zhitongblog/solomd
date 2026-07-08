# Per-client install snippets

Copy-paste install instructions for each major MCP client. Designed to be
linked from each client's "Where can I find MCP servers?" docs / README and
to be self-contained for users finding us via Smithery / Google.

| Client | File |
|---|---|
| Claude Desktop | [`claude-desktop.md`](claude-desktop.md) |
| Claude Code (CLI) | [`claude-code.md`](claude-code.md) |
| Cursor | [`cursor.md`](cursor.md) |
| Cline (VS Code) | [`cline.md`](cline.md) |
| Continue.dev | [`continue.md`](continue.md) |
| Zed | [`zed.md`](zed.md) |

Each file embeds the same "Get SoloMD" download CTA at the bottom — the
desktop app is the GUI upgrade path for users who land here via the MCP.

## Source-of-truth conventions

- All binary download URLs hit `releases/latest/download/…` so they don't
  rot when we cut a new version.
- All snippets default to **read-only** (`--allow-write` is documented as
  an opt-in, not enabled by default).
- All snippets show **at least one workspace** in the args — the server
  errors out if `--workspace` is missing, and there's no sensible default.
