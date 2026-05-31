# Smithery submission — `solomd-mcp`

## Status

⏳ **Ready to submit.** Smithery accepts `smithery.yaml` PRs into
[smithery-ai/registry](https://github.com/smithery-ai/registry) — that's
the inventory repo their indexer reads.

## What's here

| File | Purpose |
|---|---|
| [`smithery.yaml`](smithery.yaml) | The actual registry entry. Tells Smithery how to install the server (binary downloads per OS + arch), what tools it exposes, what the user has to configure, and which categories to file it under. |
| [`Dockerfile`](Dockerfile) | Fallback runtime — built from the repo root. Used by Smithery when the user opts into Docker mode or when their platform isn't covered by the prebuilt binaries (currently macOS arm64/x64 standalone — those users hit `cargo install` instead). |
| [`listing.md`](listing.md) | Long-form description that Smithery surfaces on the listing page. Embeds `_shared/about-solomd.md` + `_shared/tools.md`. |
| [`screenshots/`](screenshots/) | PNGs the listing references. **TODO** — capture from the desktop app's Agent panel + a Claude Desktop session driving the MCP. |

## Submitting

1. Fork [smithery-ai/registry](https://github.com/smithery-ai/registry).
2. Add `servers/solomd-mcp/smithery.yaml` — copy from this directory.
3. Add `servers/solomd-mcp/listing.md` — copy from this directory.
4. Open a PR with:

   **Title**: `Add solomd-mcp — MCP server for SoloMD Markdown vaults`

   **Body** (paste verbatim):

   ```markdown
   ## What

   solomd-mcp is the MCP server bundled with [SoloMD](https://solomd.app),
   a free MIT-licensed Markdown editor with a built-in agent surface.

   13 tools over stdio (JSON-RPC):
   - 8 generic Markdown-vault tools (list_notes, read_note, search,
     get_backlinks, list_tags, get_outline, write_note, append_to_note)
   - 5 SoloMD-only tools that leverage SoloMD's per-note AutoGit history
     (autogit_log, autogit_diff, autogit_rollback, sync_status, share_url)
   - 1 trace replayer (read_agent_trace)

   Read-only by default; --allow-write opt-in for the 3 write tools.

   ## Distribution

   - Prebuilt binaries on every GitHub release for linux-x64, linux-arm64,
     win-x64, win-arm64 (~4 MB each).
   - macOS users install via `cargo install solomd-mcp` or use the bundled
     binary inside the SoloMD.app distribution.
   - Dockerfile included for unsupported platforms / containerised deploys.

   ## Why it belongs on Smithery

   - Works against any folder of `.md` files — no SoloMD account or
     server required.
   - The 5 SoloMD-only tools (AutoGit + share URLs) are not available in
     any other MCP server we know of.
   - Bundled with a desktop GUI (Agent panel, accept/reject pending writes,
     trace replay) that drives the same server — gives Smithery users a
     "real-app" upgrade path beyond the CLI.

   ## Verification

   - `npm run lint` on smithery.yaml: passes locally.
   - Docker build from repo root: `docker build -t solomd-mcp -f marketplace/smithery/Dockerfile .` — completes in ~2 min.
   - `solomd-mcp --workspace /tmp/test-vault` followed by an MCP `initialize`
     handshake responds with the full tool list (verified against Claude
     Desktop, Claude Code, and Cline).

   ## Maintainer

   @zhitongblog (Alex / lixd220@gmail.com) — same as the SoloMD repo owner.
   ```

5. Once merged, Smithery's indexer picks it up within ~1 hour. The listing
   URL will be `https://smithery.ai/server/solomd-mcp`.

## After the listing is live

- Update [`../README.md`](../README.md)'s status table.
- Add the Smithery install badge to the root README:
  ```markdown
  [![Install on Smithery](https://smithery.ai/badge/solomd-mcp)](https://smithery.ai/server/solomd-mcp)
  ```
- Tweet / post to https://x.com/anthropic + r/ClaudeAI / r/LocalLLaMA with
  the listing URL.
