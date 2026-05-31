# `solomd-mcp` in Cursor

[Cursor](https://cursor.com)'s built-in MCP support reads
`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in the workspace.

## Install the server

```bash
# macOS — bundled in SoloMD.app, or:
cargo install solomd-mcp

# Linux x64
curl -L https://github.com/zhitongblog/solomd/releases/latest/download/solomd-mcp-linux-x64.tar.gz \
  | tar -xz -C /usr/local/bin

# Linux arm64
curl -L https://github.com/zhitongblog/solomd/releases/latest/download/solomd-mcp-linux-arm64.tar.gz \
  | tar -xz -C /usr/local/bin

# Windows x64 / arm64 — unzip and put on PATH.
```

## Config — `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "solomd": {
      "command": "solomd-mcp",
      "args": ["--workspace", "/Users/you/notes"]
    }
  }
}
```

Restart Cursor. **Settings → MCP** should list `solomd` with 13 tools.

## Try it

In Cursor's chat (`Cmd+K` / `Ctrl+K`):

> Use the SoloMD MCP to find every note that links to `[[architecture]]`
> and give me a 3-bullet summary of each.

## Allow writes

Add `--allow-write` to the args. Then Cursor can call `write_note` /
`append_to_note` to create/update notes from chat.

```json
"args": [
  "--workspace", "/Users/you/notes",
  "--allow-write"
]
```

## About SoloMD

[**SoloMD**](https://solomd.app) is the Markdown editor that ships this MCP
server pre-wired. Get the desktop app for the Agent panel UI, the pending
write accept/reject screen, and AutoGit history navigation:

[📥 Download SoloMD for macOS / Windows / Linux](https://github.com/zhitongblog/solomd/releases/latest)
