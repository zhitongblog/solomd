# `solomd-mcp` in Continue.dev

[Continue](https://continue.dev) (VS Code + JetBrains AI assistant) reads
MCP config from `~/.continue/config.json` under the `mcp` key.

## Install the server

```bash
# macOS
cargo install solomd-mcp

# Linux x64
curl -L https://github.com/zhitongblog/solomd/releases/latest/download/solomd-mcp-linux-x64.tar.gz \
  | tar -xz -C /usr/local/bin

# Linux arm64
curl -L https://github.com/zhitongblog/solomd/releases/latest/download/solomd-mcp-linux-arm64.tar.gz \
  | tar -xz -C /usr/local/bin

# Windows — unzip and put on PATH.
```

## Config — `~/.continue/config.json`

```json
{
  "models": [...],
  "mcp": [
    {
      "name": "solomd",
      "command": "solomd-mcp",
      "args": ["--workspace", "/Users/you/notes"]
    }
  ]
}
```

Reload Continue. The MCP block in the sidebar should show `solomd` with
13 tools.

## Try it

In Continue chat:

> /solomd search for "TODO" and group by directory.

Or just ask naturally — Continue will figure out which tool to call:

> Show me every note I've written this week and the headings inside them.

## Allow writes

```json
"args": [
  "--workspace", "/Users/you/notes",
  "--allow-write"
]
```

## About SoloMD

[**SoloMD**](https://solomd.app) is the Markdown editor that ships this MCP
server pre-wired. Get the desktop app for the Agent panel UI, AutoGit
history navigation, and the pending write accept/reject screen:

[📥 Download SoloMD for macOS / Windows / Linux](https://github.com/zhitongblog/solomd/releases/latest)
