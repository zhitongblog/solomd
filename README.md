# SoloMD

> Local-first, agent-native Markdown IDE and Model Context Protocol (MCP) knowledge engine.

[![Latest Release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-orange.svg)](https://solomd.app)

🌐 **[Translations](docs/translations/)** · [中文](docs/translations/README.zh.md) · [日本語](docs/translations/README.ja.md) · [한국어](docs/translations/README.ko.md) · [Deutsch](docs/translations/README.de.md) · [Français](docs/translations/README.fr.md) · [Español](docs/translations/README.es.md) · [Português](docs/translations/README.pt.md) · [Italiano](docs/translations/README.it.md) · [Polski](docs/translations/README.pl.md) · [Nederlands](docs/translations/README.nl.md) · [Türkçe](docs/translations/README.tr.md) · [Svenska](docs/translations/README.sv.md) · [Українська](docs/translations/README.uk.md)

---

## Engineering Case Study: Multi-Target Release Pipeline & Supply-Chain Hardening

> **Context:** Architectural refactoring of the compilation, packaging, and downstream distribution pipeline for a multi-component desktop ecosystem (Tauri v2 + Rust MCP Sidecar + Vue 3 / TypeScript + WebExtension + Homebrew Tap + Crates.io).

### 1. Objective
Replace fragmented, platform-specific build scripts with a deterministic, zero-credential 4-phase Directed Acyclic Graph (DAG) release pipeline supporting:
- Parallel multi-target cross-compilation across 5 operating systems and CPU architectures.
- Cryptographic supply-chain security (SLSA Level 3 build provenance, CycloneDX SBOM, Sigstore / Rekor attestation).
- Manifest-driven downstream distribution (automated Homebrew Tap Cask sync, RFC 8693 OIDC publishing to Crates.io).

### 2. Architecture & Implementation

```text
Phase 1: Satellites ────────► [ WebExtension (.zip) + AgentSkills (.zip) ]
Phase 2: Desktop Matrix ────► [ macOS Universal, Win x64/ARM64, Linux x64/ARM64 ]
                                            │
                                            ▼
Phase 3: Release Gate ──────► [ dist-manifest.json + CycloneDX SBOM + SLSA L3 (Sigstore) ]
                                            │
                                            ▼
Phase 4: Distribution ──────► [ Homebrew Tap Sync + Crates.io OIDC Publishing (RFC 8693) ]
```

- **Matrix Compilation Decoupling:** Separated native binary compilation from release creation to eliminate race conditions in multi-runner matrices.
- **Universal macOS Packaging:** Automated single-bundle Universal `.dmg` packaging (Apple Silicon `aarch64` + Intel `x86_64`) with Gatekeeper quarantine bypass instructions.
- **Supply-Chain Hardening:** Cryptographically signed all 20 binary assets with SLSA Level 3 provenance via GitHub Actions OIDC and Sigstore/Rekor; generated machine-readable CycloneDX JSON SBOMs (`solomd-app-bom.json`, `solomd-mcp-bom.json`).
- **Single Source of Truth (SSOT):** Standardized `dist-manifest.json` generation with SHA-256 digests, payload sizes, and Keep-a-Changelog AST extraction.
- **Zero-Static-Credential Distribution:** Implemented RFC 8693 OIDC Trusted Publishing for Crates.io with idempotent registry pre-checks; automated Homebrew Cask AST generation with `depends_on macos: :big_sur`.

---

## 1. Architectural Overview

SoloMD bridges local-first Markdown knowledge management with autonomous agent execution environments. It exposes an active local filesystem vault simultaneously to human interactive editing and LLM client tooling via an embedded Model Context Protocol (MCP) server.

```text
┌────────────────────────────────────────────────────────┐
│                   Local Markdown Vault                 │
│              (Plaintext .md files + Assets)            │
└───────────────▲────────────────────────▲───────────────┘
                │                        │
┌───────────────▼──────────────┐  ┌──────▼───────────────┐
│     Interactive Client       │  │  solomd-mcp Server   │
│  Tauri v2 + Vue 3 + CM6      │  │  (Rust / stdio / IPC)│
├──────────────────────────────┤  ├──────────────────────┤
│ • Hybrid WYSIWYG & Source    │  │ • RFC 8693 OIDC auth │
│ • YAML Frontmatter Inspector │  │ • 13 Core Vault Tools│
│ • Local AutoGit Versioning   │  │ • Multi-Vault Fed.   │
│ • Embedded Agent Runtime     │  │ • Git Rollback/Diff  │
└──────────────────────────────┘  └──────────▲───────────┘
                                             │
                                ┌────────────▼───────────┐
                                │   External LLM Engine  │
                                │ (Claude / Cursor / IDE)│
                                └────────────────────────┘
```

### Core Tenets
- **Zero Cloud Intermediaries:** Storage, vector indexing, version control, and cryptographic key management execute strictly on the local host.
- **Fail-Closed Security Model:** No inbound open network ports; all agent interactions run through authenticated stdio channels with path-traversal guards and dirty-tree execution gates.
- **Atomic Rollback Architecture:** Agent writes are isolated to transient AutoGit branches until explicitly reviewed and merged.

---

## 2. Technical Capabilities

### Editor & Knowledge Graph Subsystem
- **Editing Engine:** CodeMirror 6 modular architecture with live hybrid WYSIWYG, split-pane diffing, and Vim modal bindings.
- **Frontmatter Management:** AST-preserving YAML serialization that retains comments, inline dictionaries, and formatting integrity across writes (`⌘⇧I`).
- **Graph & Type Lenses:** Metadata-driven file classification (`type: Project`), directional relationship resolution (`belongs_to`, `related_to`), and interactive neighborhood topology graphs.
- **Formatting Support:** KaTeX mathematical typesetting, Mermaid diagram generation, Task list progress tracking, and CJK width-normalized tables.

### Autonomous Agent Runtime & MCP Engine
- **Bundled MCP Server (`solomd-mcp`):** Standalone native binary exposing 13 vault tools (including `autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`).
- **Multi-Vault Federation:** Connect multiple isolated repositories in a single agent session via `--workspace <path1> --workspace <path2>`.
- **Declarative Recipe Automation:** Trigger background autonomous workflows via YAML specifications (`<workspace>/.solomd/agents/*.yml`) anchored to `cron`, `on-save`, or `on-commit` triggers.
- **Execution Sandboxing:** Configurable write caps (default: 5 writes/run), dirty working-tree lockouts, and deterministic `trace.jsonl` audit logging.

### Security, Sync & Cryptography
- **OS Keychain Integration:** LLM provider credentials persist in native security layers (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- **Client-Side E2EE Synchronization:** Vault replication across custom Git remotes with Argon2id key derivation and XChaCha20-Poly1305 authenticated encryption.

---

## 3. Installation & Distribution

### macOS (Universal DMG)
```bash
brew install --cask zhitongblog/solomd/solomd
```
Or download [`SoloMD_4.12.0_universal.dmg`](https://github.com/zhitongblog/solomd/releases/latest) directly (supports Apple Silicon and Intel x86_64).  
*Note: If macOS Gatekeeper blocks launch ("damaged and can't be opened"), clear the quarantine flag:*
```bash
xattr -cr /Applications/SoloMD.app
```

### Windows
- **Installer:** [`SoloMD_4.12.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest) | [`SoloMD_4.12.0_arm64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest)
- **Standalone:** [`SoloMD_4.12.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest) | [`SoloMD_4.12.0_arm64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest)

```powershell
winget install zhitongblog.solomd
```

### Linux
- **Packages:** `.AppImage`, `.deb`, `.rpm`, `.tar.gz` for both `x86_64` and `aarch64` architectures available in [GitHub Releases](https://github.com/zhitongblog/solomd/releases/latest).

---

## 4. MCP Server Integration

To connect external AI agents (Claude Desktop, Cursor, Zed, Cline) to your vault:

```json
{
  "mcpServers": {
    "solomd": {
      "command": "/Applications/SoloMD.app/Contents/Resources/solomd-mcp",
      "args": [
        "--workspace", "/path/to/primary-vault",
        "--workspace", "/path/to/secondary-vault"
      ]
    }
  }
}
```

### Standalone MCP Binary via Crates.io
```bash
cargo install solomd-mcp
solomd-mcp --workspace /path/to/vault
```

---

## 5. Build from Source

### Prerequisites
- Rust 1.80+
- Node.js 20+ (LTS)
- pnpm 9+
- Linux build dependencies: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libdbus-1-dev`

```bash
# Clone repository
git clone https://github.com/zhitongblog/solomd.git
cd solomd

# Build desktop application
cd app
pnpm install
pnpm tauri build

# Build standalone MCP server
cd ../mcp-server
cargo build --release
```

---

## 6. Supply Chain & Verification

All release artifacts are validated through cryptographic attestations:
- **SLSA Level 3 Provenance:** Signed via Sigstore and Rekor public transparency log.
- **Software Bill of Materials (SBOM):** Generated in CycloneDX JSON format for all dependencies.
- **Verification:**
  ```bash
  gh attestation verify dist-manifest.json --repo zhitongblog/solomd
  ```

---

## 7. License

Distributed under the [MIT License](LICENSE). Copyright © 2026 xiangdong li & SoloMD contributors.

