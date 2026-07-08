# `solomd-mcp` in Claude Code

[Claude Code](https://docs.anthropic.com/claude/docs/claude-code) reads
MCP server config from `~/.claude/mcp.json` (global) or `.mcp.json` in
the current project root.

## Install the server

```bash
# macOS — bundled in SoloMD.app, or install standalone:
cargo install solomd-mcp

# Linux x64
curl -L https://github.com/zhitongblog/solomd/releases/latest/download/solomd-mcp-linux-x64.tar.gz \
  | tar -xz -C /usr/local/bin

# Linux arm64
curl -L https://github.com/zhitongblog/solomd/releases/latest/download/solomd-mcp-linux-arm64.tar.gz \
  | tar -xz -C /usr/local/bin

# Windows (x64 / arm64) — extract from the zip and put on PATH.
```

## Config — `~/.claude/mcp.json` (global)

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

## Config — `.mcp.json` (per-project, so each project gets its own vault)

```json
{
  "mcpServers": {
    "solomd": {
      "command": "solomd-mcp",
      "args": [
        "--workspace", "notes=./notes",
        "--workspace", "design=./design-docs"
      ]
    }
  }
}
```

Multiple workspaces let Claude Code reach across folder boundaries inside
your repo. The alias (`notes=`, `design=`) is what shows up in tool
arguments.

## Allow writes

Add `--allow-write` to the `args` array to enable `write_note`,
`append_to_note`, and `autogit_rollback`. Default is read-only.

## Try it

```
> /mcp
# Should list "solomd" with 13 tools.

> Read my notes about the LRU cache design and summarise the open questions
  into a new note at design/lru-open-questions.md.
```

## Pairs especially well with

- **Codex CLI** — same MCP wire protocol; just point at the same binary.
- **The SoloMD app** — open the editor on the same vault Claude Code is
  driving. Watch agent writes land as pending branches; accept / reject
  from the GUI; tool-call cards show inline in the Agent panel.

## About SoloMD

[**SoloMD**](https://solomd.app) is a free, MIT Markdown + plaintext editor.
Same `.md` files; the editor adds a Wiki-link + backlink graph, semantic
search, per-note AutoGit history, a streamed Agent panel that cites notes
with `[[wikilinks]]`, and the same `solomd-mcp` server you just installed —
pre-wired.

[📥 Download SoloMD for macOS / Windows / Linux](https://github.com/zhitongblog/solomd/releases/latest)
