# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.12.0] 2026-09-07

### What's new / 更新内容

https://solomd.app/whats-new · 中文

### Highlights
- Fold a heading and everything under it across plain-textarea and preview editors.
- Printing decoupling: print and PDF use dedicated light palette independently of app theme.
- Undoable delete: 8-second safety grace period before permanent filesystem flush.
- System-wide quick capture chord (`⌘⌥M` / `Ctrl+Alt+M`) to capture thoughts to Inbox.
- Workspace Tasks panel tracking all `- [ ]` checkboxes across markdown files.
- Visual Table grid editor with full CJK character width alignment.
- Standalone Model Context Protocol server (`solomd-mcp`) for local LLM integration.

### Install / 安装
- **macOS:** Download `.dmg`, drag SoloMD to `/Applications`. If Gatekeeper flags the unsigned binary ("damaged/can't be opened"), clear quarantine: `xattr -cr /Applications/SoloMD.app`
- **Windows:** Download `.msi`. On first launch you may see "Windows protected your PC" → click *More info* → *Run anyway*
- **Linux:** Download `.AppImage` (`chmod +x` and run) or `.deb` / `.rpm`
- **Homebrew:** `brew install --cask zhitongblog/solomd/solomd`

### Verify / 校验
- SLSA Level 3 Provenance cryptographically signed via GitHub OIDC & Sigstore.
- Checksums & manifest provided in `dist-manifest.json`.
