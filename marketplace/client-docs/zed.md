# `solomd-mcp` in Zed

[Zed](https://zed.dev)'s built-in agent reads MCP servers from
`~/.config/zed/settings.json` under `context_servers`.

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
```

(Zed doesn't yet officially ship for Windows. Use the WSL build if you need
it there.)

## Config — `~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "solomd": {
      "command": {
        "path": "solomd-mcp",
        "args": ["--workspace", "/Users/you/notes"]
      },
      "settings": {}
    }
  }
}
```

Cmd+Shift+P → "zed: reload context servers" (or restart Zed). The agent
panel should list `@solomd` with the 13 tools.

## Try it

In Zed's chat panel:

> @solomd find every note in my vault tagged #book and give me the
> outline (H1 / H2) of each.

## Allow writes

```json
"args": [
  "--workspace", "/Users/you/notes",
  "--allow-write"
]
```

## About SoloMD

[**SoloMD**](https://solomd.app) is the Markdown editor that ships this MCP
server pre-wired. Get the desktop app for the Agent panel UI:

[📥 Download SoloMD for macOS / Windows / Linux](https://github.com/zhitongblog/solomd/releases/latest)
