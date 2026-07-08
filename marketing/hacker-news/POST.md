# Hacker News - Show HN Post

## Title (80 chars max)

```
Show HN: SoloMD – A 15 MB Markdown editor built with Tauri 2 and Rust
```

## URL

```
https://solomd.app
```

## Text (for Show HN, leave URL empty and paste this)

```
I built a Markdown editor because I wanted something that:

- Starts instantly (no Electron, no bundled Chromium)
- Works fully offline with zero telemetry
- Doesn't require an account or subscription

SoloMD is the result. It's ~15 MB installed (vs Typora 80 MB / Obsidian 250 MB).

**What makes it different:**

• Live preview – Markdown markers hide when cursor leaves the line
• Multi-encoding – Auto-detects GBK/Big5/Shift_JIS (useful for legacy CJK files)
• "Clean AI Artifacts" – One click to strip [cite_start], curly quotes, and zero-width chars from ChatGPT/Claude paste
• KaTeX math, Mermaid diagrams, focus mode, typewriter mode
• Export to HTML/PDF/DOCX

**Tech stack:** Tauri 2 + Vue 3 + CodeMirror 6 + Rust backend

MIT licensed, fully open source: https://github.com/zhitongblog/solomd

I'd love feedback on the editor experience. What features would make you switch from your current Markdown tool?
```

## Posting Tips

1. **Best time:** Tuesday/Wednesday 9-11am PST (midnight Beijing time)
2. **Respond to every comment** in the first 2 hours – this is crucial for ranking
3. **Don't ask friends to upvote** – HN detects vote rings
4. **Be humble** – HN appreciates technical depth over marketing speak
5. **Prepare for criticism** – Have answers ready for:
   - "Why not just use VS Code?"
   - "What's wrong with Obsidian?"
   - "Tauri is still immature"

## Follow-up Comments to Prepare

### On "Why Tauri?"
```
Tauri lets us use the system webview instead of bundling Chromium. On macOS that's WKWebView, on Windows it's WebView2. The result is a ~15 MB app vs 100+ MB for Electron apps. The trade-off is some cross-platform quirks, but for a text editor the webview differences are minimal.
```

### On "Why not VS Code?"
```
VS Code is great if you already live in it. SoloMD is for when you want to open a single .md file, write, and close – without loading an entire IDE. Think Notepad, but with Markdown rendering.
```

### On "What about Obsidian?"
```
Obsidian is excellent for knowledge management and linking notes. SoloMD is intentionally simpler – it's a single-file editor, not a vault system. Different tools for different workflows.
```

## Attached Images

- `og-image.png` – For social sharing if linked elsewhere
- `comparison-en.png` – Can be linked in comments if someone asks for comparison
