---
title: "I Built a 15 MB Markdown Editor with Tauri 2 and Rust"
published: true
description: "Why I built SoloMD, a lightweight alternative to Electron-based editors, and what I learned along the way."
tags: rust, tauri, opensource, markdown
cover_image: og-image.png
---

# I Built a 15 MB Markdown Editor with Tauri 2 and Rust

I've been using Markdown editors for years. Typora, MarkText, Obsidian, VS Code with extensions – they all work, but something always bothered me.

**Why does a text editor need 250 MB of disk space?**

So I built my own. It's called [SoloMD](https://solomd.app), and the installer is about 15 MB.

## The Problem with Electron

Most cross-platform desktop apps today use Electron. It's a great framework – you write web code and it runs everywhere. But there's a catch: every Electron app bundles its own copy of Chromium.

That means:
- 100-200 MB just for the runtime
- 300-500 MB RAM usage for a text editor
- Slow startup times

For a full IDE like VS Code, the trade-off makes sense. For a simple Markdown editor? It felt like overkill.

## Enter Tauri

[Tauri](https://tauri.app) takes a different approach. Instead of bundling Chromium, it uses the operating system's built-in webview:

- **macOS**: WKWebView (Safari's engine)
- **Windows**: WebView2 (Edge's engine)
- **Linux**: WebKitGTK

The backend is written in Rust, which handles file I/O, system integration, and heavy lifting.

The result? A ~15 MB app that starts instantly.

## What I Built

SoloMD is a Markdown editor focused on simplicity:

### Live Preview
Markdown markers (`#`, `**`, etc.) hide when your cursor leaves the line. No split pane, no preview mode – just write and see.

### The Features That Matter
- **KaTeX math**: `$E=mc^2$` renders inline
- **Mermaid diagrams**: Flowcharts, sequence diagrams, Gantt charts
- **Multi-encoding**: Auto-detects GBK, Big5, Shift_JIS (essential for CJK users)
- **Focus mode**: Dims everything except the current paragraph
- **Typewriter mode**: Keeps the cursor centered vertically

### For the AI Era
One feature I added out of personal frustration: **Clean AI Artifacts**.

If you've ever pasted text from ChatGPT or Claude, you know the pain: `[cite_start]`, curly quotes, zero-width characters everywhere. One button strips all that junk.

### Privacy by Default
- Zero telemetry
- No accounts
- No cloud sync
- Files stay on your machine

## Tech Stack

```
Frontend: Vue 3 + TypeScript + Vite
Editor:   CodeMirror 6
Markdown: markdown-it + KaTeX + Mermaid
Backend:  Tauri 2 (Rust)
Encoding: chardetng + encoding_rs
```

### Why CodeMirror 6?

I evaluated several editor frameworks:
- **Monaco** (VS Code's editor): Too heavy for a simple Markdown editor
- **ProseMirror**: Great for rich text, overkill for Markdown
- **CodeMirror 6**: Perfect balance of features and performance

CodeMirror 6's extension system made it easy to build custom behaviors like the "hide markers on blur" feature.

### Why Vue 3?

I considered React and Svelte. Vue 3 with `<script setup>` felt the most productive for a solo developer. The Composition API is clean, and Pinia for state management is simple.

## Challenges Along the Way

### Cross-Platform File Encoding

Most editors assume UTF-8. But in East Asia, legacy files in GBK (Simplified Chinese), Big5 (Traditional Chinese), or Shift_JIS (Japanese) are still common.

I used `chardetng` (Rust) to auto-detect encoding and `encoding_rs` for conversion. It's not perfect – encoding detection never is – but it handles 95% of cases.

### WebView Differences

Tauri's promise of "write once, run everywhere" is mostly true, but there are quirks:

- **Font rendering** differs between platforms
- **Scrollbar styling** works on macOS, partially on Windows, barely on Linux
- **File drag-and-drop** needed platform-specific handling

Nothing insurmountable, but expect to write some conditional code.

### Code Signing

Getting rid of "Windows protected your PC" warnings requires an EV code signing certificate (~$400/year). For now, SoloMD relies on SmartScreen reputation building through downloads.

On macOS, notarization is free but requires an Apple Developer account ($99/year).

## What's Next

SoloMD is MIT licensed and fully open source. I'm actively maintaining it and have a roadmap:

- [ ] Vim keybindings
- [ ] Plugin system
- [ ] Better table editing
- [ ] WebDAV sync (optional)

## Try It

- **Website**: [solomd.app](https://solomd.app)
- **GitHub**: [github.com/zhitongblog/solomd](https://github.com/zhitongblog/solomd)
- **Downloads**: macOS (universal), Windows (x64), Linux (AppImage/deb/rpm)

If you're interested in Tauri 2 development, the codebase might be a useful reference. PRs and feedback welcome!

---

*What's your go-to Markdown editor? I'd love to hear what features matter most to you.*
