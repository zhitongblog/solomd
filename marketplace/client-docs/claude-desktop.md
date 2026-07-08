# `solomd-mcp` in Claude Desktop

## Install the server

Pick one path:

### Path A — bundled in SoloMD.app (recommended)

Install [SoloMD](https://solomd.app) and the MCP server ships inside the
app bundle. Then in SoloMD: `Settings → Integrations → Print MCP config`
copies the right JSON snippet for Claude Desktop.

### Path B — standalone binary

1. Download from the
   [latest release](https://github.com/zhitongblog/solomd/releases/latest):
   - macOS arm64/x64: `cargo install solomd-mcp` (or grab the bundled
     binary from SoloMD.app)
   - Linux x64: `solomd-mcp-linux-x64.tar.gz`
   - Linux arm64: `solomd-mcp-linux-arm64.tar.gz`
   - Windows x64: `solomd-mcp-win-x64.zip`
   - Windows arm64: `solomd-mcp-win-arm64.zip`
2. Extract and put `solomd-mcp` on your `PATH` (or remember the absolute
   path for the config below).

## Wire into Claude Desktop

Open Claude Desktop's config:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add this under `mcpServers`:

```json
{
  "mcpServers": {
    "solomd": {
      "command": "solomd-mcp",
      "args": [
        "--workspace", "/Users/you/notes"
      ]
    }
  }
}
```

Multiple workspaces? Repeat the flag:

```json
{
  "mcpServers": {
    "solomd": {
      "command": "solomd-mcp",
      "args": [
        "--workspace", "work=/Users/you/work-notes",
        "--workspace", "home=/Users/you/diary"
      ]
    }
  }
}
```

Need writes (Claude can create / overwrite notes)? Add `--allow-write`:

```json
"args": [
  "--workspace", "/Users/you/notes",
  "--allow-write"
]
```

Restart Claude Desktop. The 🔌 icon in the bottom of the message box should
show "solomd" with all 13 tools.

## Try it

> Use the SoloMD MCP tools to list every note tagged `#project`, then show me
> the backlinks for the most-recently-modified one.

## About SoloMD

[**SoloMD**](https://solomd.app) is a free, MIT Markdown + plaintext editor.
Same `.md` files as your favourite plain-text setup; the editor adds a
Wiki-link + backlink graph, semantic search, per-note AutoGit history, a
streamed Agent panel that cites notes with `[[wikilinks]]`, and the same
`solomd-mcp` server you just installed — pre-wired.

You don't need the app to use the MCP server. But if you want the **Agent
panel**, **pending write accept/reject UI**, **AutoGit branch sandbox per
agent run**, and **BYOK keys in the OS keychain** — get the app.

[📥 Download SoloMD for macOS / Windows / Linux](https://github.com/zhitongblog/solomd/releases/latest)
