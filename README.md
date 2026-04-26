# SoloMD

> Local-first Markdown editor with semantic search, version history, and 14 AI providers.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

[**Download**](https://github.com/zhitongblog/solomd/releases/latest) · [**Website**](https://solomd.app) · [**Security**](https://solomd.app/security) · [**FAQ**](https://solomd.app/#faq) · [中文站点](https://solomd.app/zh)

![SoloMD editor](web/public/demo/solomd-demo.svg)

SoloMD is a desktop Markdown editor for people who keep their notes as a folder of plain `.md` files. Built on Tauri 2 + Vue 3 + CodeMirror 6, the universal macOS dmg is ~23 MB. Everything — your notes, your AI keys, the embeddings index, the git history — stays on your machine. No account, no cloud round-trip, MIT-licensed.

## Features

| | | |
|---|---|---|
| **Local RAG** semantic search over the workspace, off by default, no cloud | **WYSIWYG live edit** — Typora/Obsidian-style inline rendering as a fourth view mode | **AutoGit** version history — every save is a commit, restore atomically |
| **AI rewrite** with 14 BYOK providers — OpenAI, Claude, Gemini, DeepSeek, Qwen, GLM, Kimi, Ollama, OpenRouter, etc. | **MCP server** — 1.5 MB sidecar binary, 8 tools, plug into Claude Desktop / Cursor | **Wikilinks & backlinks** — `[[note]]` autocomplete, backlinks panel, outline view |
| **Daily notes** with templated paths | **Pandoc export** — EPUB / ODT / LaTeX / RTF / DOCX / PDF / HTML | **CJK first-class** — auto-detect UTF-8 / GBK / Big5 / Shift-JIS, simplified⇄traditional, pinyin |

Plus the basics: tabs and split panes, KaTeX, Mermaid, image paste to `_assets/`, drag-import from `.docx` / `.pdf` / `.xlsx` / `.pptx`, slideshow mode (`⌘⌥P`), Vim mode, Hunspell spell-check, `solomd` CLI, OS file association.

## Install

Latest release: [v2.2.1](https://github.com/zhitongblog/solomd/releases/tag/v2.2.1).

### macOS — universal dmg (Apple Silicon + Intel, ~23 MB)

```
https://github.com/zhitongblog/solomd/releases/download/v2.2.1/SoloMD_2.2.1_universal.dmg
```

Or one-line install:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64 (~11 MB MSI, ~9 MB EXE)

- [`SoloMD_2.2.1_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/download/v2.2.1/SoloMD_2.2.1_x64_en-US.msi)
- [`SoloMD_2.2.1_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/download/v2.2.1/SoloMD_2.2.1_x64-setup.exe) (NSIS)

Or:

```powershell
irm https://solomd.app/install.ps1 | iex
```

SmartScreen may flag the installer on first run while the cert builds reputation; click **More info → Run anyway**.

### Linux — x86_64 + aarch64

- [`SoloMD_2.2.1_amd64.AppImage`](https://github.com/zhitongblog/solomd/releases/download/v2.2.1/SoloMD_2.2.1_amd64.AppImage) — universal
- [`SoloMD_2.2.1_amd64.deb`](https://github.com/zhitongblog/solomd/releases/download/v2.2.1/SoloMD_2.2.1_amd64.deb) — Debian/Ubuntu
- [`SoloMD-2.2.1-1.x86_64.rpm`](https://github.com/zhitongblog/solomd/releases/download/v2.2.1/SoloMD-2.2.1-1.x86_64.rpm) — Fedora/RHEL
- ARM64 builds also available — replace `amd64`/`x86_64` with `aarch64`

For "Copy as Image", install a clipboard tool: `sudo apt install wl-clipboard` (Wayland) or `xclip` (X11).

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — same engine, native iPad UI.

## What's new

**v2.3** (merged on `main`, 2026-04-25)

- Local RAG / semantic search panel (`⌘⇧F`), off by default — embeds every `.md` in the workspace, queries against a local vector index. No cloud.
- WYSIWYG live edit view mode — markdown formatting renders inline inside the editor, no preview pane needed.
- File tree ~10× faster on Windows (`file_type()` instead of full `metadata()` per entry).

**v2.2.1** (released 2026-04-25)

- MCP server — `solomd-mcp` sidecar binary, 8 tools, stdio. Default read-only.
- AutoGit — every save commits to a local `.git` inside your workspace; libgit2 vendored, no system git needed.
- AI rewrite — 14 BYOK providers (`⌘J` to rewrite / shorten / expand / translate / explain).
- New [/security](https://solomd.app/security) page documenting every place data flows.
- Hotfix: Win11 file-tree crash on slow filesystems ([#25](https://github.com/zhitongblog/solomd/issues/25)).

Full notes: <https://github.com/zhitongblog/solomd/releases>.

## MCP integration

Point any MCP-compatible client (Claude Desktop, Cursor, Codex CLI) at your notes folder. The `solomd-mcp` binary ships in the install bundle.

```json
{
  "mcpServers": {
    "solomd": {
      "command": "/Applications/SoloMD.app/Contents/Resources/solomd-mcp",
      "args": ["--workspace", "/path/to/your/notes"]
    }
  }
}
```

Tools: `list_notes`, `read_note`, `search`, `get_backlinks`, `list_tags`, `get_outline`, plus `write_note` and `append_to_note` (gated behind `--allow-write`). Path-traversal guarded, no network port.

## How it compares

| | SoloMD | Obsidian | Typora | Tolaria |
|---|---|---|---|---|
| License | **MIT** | proprietary (free) | paid ($14.99) | open source |
| Stack | Tauri 2 (Rust + WebView) | Electron | Electron | Tauri |
| Platforms | macOS · Win · Linux · iPad | macOS · Win · Linux · iOS · Android | macOS · Win · Linux | macOS · Linux |
| Installer | ~23 MB (mac) / ~11 MB (win) | ~120 MB | ~95 MB | ~25 MB |
| Built-in AI rewrite | ✅ 14 BYOK providers | plugin only | ❌ | via external MCP |
| Local RAG / semantic search | ✅ off by default | plugin only | ❌ | ❌ |
| Version history per note | ✅ AutoGit | plugin only | ❌ | ✅ |
| MCP server | ✅ 8 tools, sidecar | ❌ | ❌ | ✅ |
| Sync | ❌ (BYO git / Syncthing / iCloud) | paid add-on | ❌ | ❌ |
| CJK encodings (GBK / Big5) | ✅ auto-detect | ❌ | ❌ | ❌ |

Detailed breakdowns: [vs Obsidian](https://solomd.app/compare/vs-obsidian) · [vs Typora](https://solomd.app/compare/vs-typora) · [vs Tolaria](https://solomd.app/compare/vs-tolaria) · [vs Marktext](https://solomd.app/compare/vs-marktext).

## Privacy & security

Pure client-side. Your `.md` files stay in the folder you chose. API keys live in the OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret), never in `localStorage` or any config file. AI requests go direct from your machine to the provider you picked — no SoloMD relay. RAG embeddings and the AutoGit repo are local-only. The whole codebase is MIT and auditable.

Full writeup: <https://solomd.app/security>.

## Build from source

Prereqs: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # dev with hot reload
pnpm tauri build    # release artifacts → src-tauri/target/release/bundle/
```

Linux additionally needs `libdbus-1-dev` for the keychain backend.

The MCP server is a separate crate at `mcp-server/`; the dev MCP harness used for end-to-end testing lives at `dev-mcp/`.

## Contributing

Issues and PRs welcome — [open one](https://github.com/zhitongblog/solomd/issues). For a sense of direction, see [`docs/roadmap.md`](docs/roadmap.md).

## Contact / 联系

One maintainer, two front doors. Async on [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Real-time chat:

- **Telegram (international):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — release announcements + chat
- **WeChat (中文):** scan to add me — note "SoloMD" 注明 SoloMD 直接通过

<a href="https://solomd.app/#contact"><img src="web/public/contact/wechat.jpg" alt="WeChat — 智通" width="180" /></a>
&nbsp;&nbsp;
<a href="https://t.me/SOLOMDAPP"><img src="web/public/contact/telegram.jpg" alt="Telegram @SOLOMDAPP" width="180" /></a>

## License & credits

[MIT](LICENSE) © 2026 xiangdong li. SoloMD stands on Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs`, and `rmcp`. Sponsor on [GitHub Sponsors](https://github.com/sponsors/zhitongblog) or via [solomd.app/#sponsor](https://solomd.app/#sponsor).
