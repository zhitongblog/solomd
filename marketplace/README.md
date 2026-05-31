# SoloMD on the MCP marketplaces

Submission materials + listing assets for getting `solomd-mcp` and the SoloMD
Skill Pack onto the major Model Context Protocol marketplaces. Each
sub-directory is a self-contained submission packet that another maintainer
(or a future you) can copy-paste from.

Every listing leads back to **[solomd.app](https://solomd.app)** so MCP /
agent users discover the desktop editor that ships the same MCP server with
a real GUI (Agent panel, accept/reject pending writes, AutoGit, BYOK keys
in OS keychain, 14 language UI).

## Status

| Target | Path | What it ships | Status |
|---|---|---|---|
| **Smithery** ([smithery.ai](https://smithery.ai)) | [`smithery/`](smithery/) | `smithery.yaml` + Dockerfile + listing copy | ⏸️ **Deferred** — Smithery's web publish flow now requires an HTTP-accessible MCP endpoint (`https://your-server.com/mcp`); `solomd-mcp` is stdio JSON-RPC only. Revisit after we ship an HTTP/SSE transport wrapper. The `smithery.yaml` at repo root stays in place for any future passive discovery. |
| **Awesome MCP Servers** (×3 community indices) | [`awesome-mcp/`](awesome-mcp/) | PR entries for `punkpeye/`, `appcypher/`, `wong2/` awesome-mcp-servers (~14k forks combined). Replaces the now-deprecated `modelcontextprotocol/servers` community section. | ⏳ Ready to submit |
| **Claude Code Skills** ([anthropic.com/claude-code](https://anthropic.com/claude-code)) | [`claude-code-skill/`](claude-code-skill/) | `solomd/SKILL.md` — installs `solomd-mcp` + documents the 11 recipes | ⏳ Ready to submit |
| **Per-client install docs** (Cursor / Cline / Continue / Claude Desktop / Zed) | [`client-docs/`](client-docs/) | One copy-paste `mcp.json` snippet per client | ✅ Live on README |
| **PulseMCP / MCP.so / community lists** | (auto-crawl) | Root README badges + GitHub topics | ✅ Live |
| **Skill Pack zip** (`solomd-skills-vX.Y.Z.zip`) | (GitHub release artifact) | 11 cookbook YAML + README, drops into `<vault>/.solomd/agents/` | ✅ Shipping in v4.4.1+ |

## What lives in `_shared/`

Single-source-of-truth blocks the per-market READMEs copy from, so the tool
list and the SoloMD pitch don't drift:

- [`_shared/tools.md`](_shared/tools.md) — the 13 MCP tools (8 generic + 5
  SoloMD-only). Copy into any listing.
- [`_shared/about-solomd.md`](_shared/about-solomd.md) — the "What is
  SoloMD?" block + download CTA. Goes at the top of every listing.
- [`_shared/badges.md`](_shared/badges.md) — shields.io badges (download
  count, release, MCP version, license).

## Submission recipe

For each marketplace:

1. **Read** `<market>/README.md` for the per-market quirks (Smithery wants a
   `Dockerfile`, mcp-servers wants a PR against their root README, …).
2. **Copy** the listing copy (which already embeds `_shared/about-solomd.md`
   + `_shared/tools.md`).
3. **Submit** per the market's process (PR, web form, etc.).
4. **Update the Status table above** when accepted.

## Updating after a SoloMD release

When you cut a new SoloMD version (e.g. v4.4.2):

```bash
# 1. Rebuild the Skill Pack zip + upload to the new release
bash scripts/build-skill-pack.sh
gh release upload v4.4.2 dist/solomd-skills-v4.4.2.zip

# 2. Smithery + mcp-servers entries auto-track the GitHub release URL —
#    nothing to do unless the schema changed.

# 3. If you added/removed an MCP tool, update _shared/tools.md and the
#    per-market listings will pick it up next time you re-paste.
```

## Why a Skill Pack zip

`solomd-mcp` knows nothing about recipes — recipes are interpreted by the
SoloMD app's recipe runner, OR by hand-adapting the YAML to whatever your
MCP client supports. So the Skill Pack is a documentation + portability
artifact, not an executable. It's the entry-point for people who find the
MCP server on Smithery and want to know "what can I actually do with this?"
