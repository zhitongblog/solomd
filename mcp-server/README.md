# solomd-mcp — Model Context Protocol server for SoloMD vaults

`solomd-mcp` lets Claude Code, Codex CLI, Cursor, Continue, and any other
MCP client read (and optionally edit) a SoloMD Markdown notes folder. Your
vault becomes a first-class tool the assistant can call.

It is a **standalone Rust binary**, not a Tauri sidecar. SoloMD launches
fine without it; you only run it when an MCP client connects.

```
solomd-mcp --workspace /Users/me/Documents/Notes
# stdin / stdout: JSON-RPC 2.0 (stdio transport)
# stderr:        human logs (use --verbose for debug)
```

### Multiple workspaces (v4.0+)

Pass `--workspace` once per vault. Each value is either a bare path (alias
defaults to the path's last component) or `<alias>=<path>`:

```
solomd-mcp \
  --workspace work=/Users/me/Documents/Work \
  --workspace home=/Users/me/Documents/Home
```

The first workspace is the **default** — tool calls without an explicit
`workspace` argument resolve to it. Existing single-`--workspace` clients
keep working unchanged. Tools that *want* to target a non-default workspace
pass an extra `workspace` argument:

```jsonc
// Default (first registered) workspace:
{ "name": "list_notes", "arguments": {} }

// Explicit alias:
{ "name": "list_notes", "arguments": { "workspace": "home" } }

// Or by absolute path (must match a registered workspace):
{ "name": "list_notes", "arguments": { "workspace": "/Users/me/Documents/Home" } }
```

Each workspace's AutoGit history (`autogit_log`, `autogit_diff`,
`autogit_rollback`) is independent — the per-workspace `.git` repo is
opened on demand for each call.

## Tools exposed

| Tool | Description | Gating |
|---|---|---|
| `list_notes` | Walk the vault and return metadata (path, name, title, mtime, size, summary). Defaults to 100 notes, sorted newest-first. | always |
| `read_note` | Full content of one note, plus parsed front matter, headings, tags, and outbound `[[wikilinks]]`. | always |
| `search` | Substring or regex search. Uses ripgrep when on PATH, otherwise a Rust regex walk. Caps at 200 hits with 3-line context. | always |
| `get_backlinks` | Every place that wikilinks the named note (case-insensitive on the file stem). | always |
| `list_tags` | Aggregated tag counts across the vault — body `#tag` plus front-matter `tags:`. | always |
| `get_outline` | Heading outline of a single note (level 1-6, text, line). | always |
| `write_note` | Create or overwrite a note. | `--allow-write` |
| `append_to_note` | Append text to an existing note (newline-safe). | `--allow-write` |

Read-only by default. Write tools are also offered through the MCP
`tools/list` response so clients can show them, but invocations fail with a
clear "restart with --allow-write" message until you opt in.

## Install

### One-line installer (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/zhitongblog/solomd/main/scripts/install-mcp.sh | bash
```

This downloads the right binary for your platform from the latest GitHub
release and drops it into `/usr/local/bin/solomd-mcp` (falling back to
`~/.local/bin/solomd-mcp` if the system path is not writable).

### Cargo

```bash
cargo install --git https://github.com/zhitongblog/solomd solomd-mcp
```

### Manual

Grab the right archive from
[github.com/zhitongblog/solomd/releases](https://github.com/zhitongblog/solomd/releases),
extract `solomd-mcp`, and put it on your `PATH`.

## Wire it up

### Claude Code

`~/.config/claude-code/mcp.json` (or `claude mcp add` if you prefer the
CLI):

```json
{
  "mcpServers": {
    "solomd-vault": {
      "command": "solomd-mcp",
      "args": ["--workspace", "/Users/me/Documents/Notes"]
    }
  }
}
```

Multi-workspace profile (one MCP server, several vaults):

```json
{
  "mcpServers": {
    "solomd-vaults": {
      "command": "solomd-mcp",
      "args": [
        "--workspace", "work=/Users/me/Documents/Work",
        "--workspace", "home=/Users/me/Documents/Home"
      ]
    }
  }
}
```

To enable writes:

```json
{
  "mcpServers": {
    "solomd-vault": {
      "command": "solomd-mcp",
      "args": ["--workspace", "/Users/me/Documents/Notes", "--allow-write"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.solomd-vault]
command = "solomd-mcp"
args = ["--workspace", "/Users/me/Documents/Notes"]
```

### Cursor / Continue / generic

Anything that speaks MCP over stdio works. Point its `command` at
`solomd-mcp` and pass `--workspace <path>`.

## CLI reference

```
solomd-mcp [OPTIONS] --workspace <ALIAS=DIR | DIR>...

  --workspace <ALIAS=DIR | DIR>
                      Path to a notes folder. Required. Canonicalised.
                      Repeat for multi-workspace mode. Form: `<alias>=<path>`
                      or just `<path>` (alias defaults to the path's last
                      component). The first workspace is the default — tool
                      calls without an explicit `workspace` argument resolve
                      to it (back-compat for single-workspace clients).
  --allow-write       Enable write_note + append_to_note + autogit_rollback.
                      Off by default.
  -v, --verbose       Debug-level stderr logs.
  -V, --version       Print version.
  -h, --help          Print help.
```

Set `SOLOMD_MCP_LOG=trace` (or any `tracing-subscriber` filter expression)
for finer-grained control.

## Safety

* Every input path is canonicalised and verified to live inside the
  workspace before any read/write. Both `..` segments and absolute paths
  outside the workspace are rejected.
* The watcher / index from the SoloMD desktop app is **not** used here —
  this is a stateless per-invocation server that walks the filesystem
  lazily.
* `list_notes` reads only an 8 KB prefix of each file (enough for title +
  summary), so even a vault with thousands of large notes is cheap to
  enumerate. Full file content only loads on `read_note`.

## Verifying

```bash
# Roundtrip handshake: initialize → tools/list.
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoketest","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 1
} | solomd-mcp --workspace ~/Documents/Notes
```

You should see eight tools listed.

## License

MIT — same as SoloMD.
