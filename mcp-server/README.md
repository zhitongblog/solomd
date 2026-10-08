# solomd-mcp — Model Context Protocol server for SoloMD vaults

`solomd-mcp` lets Claude Code, Codex CLI, Cursor, Continue, and any other
MCP client read (and optionally edit) a SoloMD Markdown notes folder. Your
vault becomes a first-class tool the assistant can call.

It is a **standalone Rust binary**. The desktop app bundles a copy (on
macOS: `/Applications/SoloMD.app/Contents/MacOS/solomd-mcp`) but never runs
it itself; it only runs when an MCP client starts it. It reports the same
version as the app (`solomd-mcp --version`).

```
solomd-mcp --workspace /Users/me/Documents/Notes
# stdin / stdout: JSON-RPC 2.0 (stdio transport, the default)
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
| `list_tasks` | Every `- [ ]` / `- [x]` checkbox in the vault, with file, line and done state; `done` filters. | always |
| `autogit_log` | Commit history of one note from the AutoGit repo, newest first. | always |
| `autogit_diff` | Unified diff of one note between two AutoGit commits. | always |
| `sync_status` | GitHub-sync state from `.solomd/sync.json` (remote, branch, encryption). | always |
| `share_url` | Public solomd.app/share URL for a note in a linked repo. | always |
| `read_agent_trace` | Steps of one agent run from `.solomd/agent-runs/<run_id>/trace.jsonl`; an unknown run id is an error. | always |
| `write_note` | Create a `.md` / `.markdown` / `.txt` note (missing folders inside the workspace are created). Replaces an existing note only with `allow_overwrite: true`. | `--allow-write` |
| `append_to_note` | Append text to an existing note (newline-safe). | `--allow-write` |
| `autogit_rollback` | Restore a note's content from an AutoGit commit. | `--allow-write` |
| `export_note` | Export a note to html / md / txt / docx. `output_path` may be outside the workspace (its folder must exist); an existing file is replaced only with `overwrite: true`. | `--allow-write`, and listed only when the Node backend is found (below) |

That is 16 tools. Read-only by default. Write tools are also offered
through the MCP `tools/list` response so clients can show them, but
invocations fail with a clear "restart with --allow-write" message until
you opt in.

Every line number (`get_outline`, `get_backlinks`, `read_note` headings and
wikilinks, `list_tasks`, `search`) is a 1-based line in the file as it sits
on disk, front matter included, so the tools agree with each other and with
an editor. `search` columns count characters, not bytes.

**`export_note` needs Node.js and a SoloMD source checkout.** It runs
`app/scripts/solomd-export.mjs` (the same engine as `solomd export`) with
the app's `node_modules`. The installed app ships neither, so the tool is
only listed when `node` is on `PATH` and the script is found: via
`SOLOMD_EXPORT_SCRIPT=/path/to/solomd/app/scripts/solomd-export.mjs`, or
automatically when the binary or the working directory is inside a
checkout where `pnpm install` has been run in `app/`.

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

Easiest route is the CLI — it writes the user-scope config (`~/.claude.json`)
for you:

```bash
claude mcp add --scope user solomd-vault -- \
  solomd-mcp --workspace /Users/me/Documents/Notes
```

To scope the server to one project instead, drop an `.mcp.json` in the project
root:

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
`solomd-mcp` and pass `--workspace <path>`. The `solomd` CLI
(`scripts/install-cli.sh`) can do this for you: `solomd mcp install`
writes the entry into every AI client it finds, `solomd mcp-config` prints
it.

### Hosted clients (Streamable HTTP)

For clients that can't spawn a local binary (Smithery, Claude.ai remote
MCP, ChatGPT connectors), run the HTTP transport:

```bash
solomd-mcp --workspace /Users/me/Documents/Notes \
  --transport http --bind 127.0.0.1:8765 --auth-token "$TOKEN"
```

It binds to loopback by default, so nothing outside the machine can reach
it until you change `--bind`. With `--auth-token` (or `SOLOMD_MCP_TOKEN`)
every request must send `Authorization: Bearer <token>`; without one the
endpoint is open to anything that can reach the address.

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
  --allow-write       Enable write_note + append_to_note + autogit_rollback
                      + export_note. Off by default.
  --transport <stdio|http>
                      stdio (default) or Streamable HTTP.
  --bind <ADDR>       HTTP listen address (default 127.0.0.1:8765).
  --auth-token <TOKEN>
                      HTTP bearer token [env: SOLOMD_MCP_TOKEN].
  -v, --verbose       Debug-level stderr logs.
  -V, --version       Print version.
  -h, --help          Print help.
```

Set `SOLOMD_MCP_LOG=trace` (or any `tracing-subscriber` filter expression)
for finer-grained control.

## Safety

* Every input path is canonicalised and verified to live inside the
  workspace before any read/write. Both `..` segments and absolute paths
  outside the workspace are rejected. The one tool that may write outside
  the workspace is `export_note`, and only with `--allow-write`; it never
  creates folders there and never replaces an existing file unless the call
  passes `overwrite: true`.
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

You should see 16 tools listed (15 if `export_note`'s Node backend isn't
available).

## License

MIT — same as SoloMD.
