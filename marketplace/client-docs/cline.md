# `solomd-mcp` in Cline (VS Code)

[Cline](https://github.com/cline/cline) reads MCP server config from its
`cline_mcp_settings.json` file. Access via:

- **macOS**: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Linux**: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Windows**: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

Or just open Cline's MCP Servers tab and click "Edit settings".

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

## Config

```json
{
  "mcpServers": {
    "solomd": {
      "command": "solomd-mcp",
      "args": ["--workspace", "/Users/you/notes"],
      "disabled": false,
      "autoApprove": ["list_notes", "read_note", "search", "get_outline", "get_backlinks", "list_tags"]
    }
  }
}
```

**`autoApprove`** lets you skip the "Approve tool call?" prompt for read
tools while keeping the write tools manual. Recommended.

Restart Cline. The MCP Servers tab should show `solomd` with a green dot
and 13 tools listed.

## Try it

> Search my notes for "decision" and group by month. For each group, show the
> commit author and date of the most recent edit using the autogit_log tool.

## Allow writes

Add `--allow-write` to args. Add `"write_note"` and `"append_to_note"` to
`autoApprove` only if you really want Cline writing without per-call
confirmation (recommend leaving them manual).

## About SoloMD

[**SoloMD**](https://solomd.app) is the Markdown editor that ships this MCP
server pre-wired. Get the desktop app for the Agent panel UI:

[📥 Download SoloMD for macOS / Windows / Linux](https://github.com/zhitongblog/solomd/releases/latest)
