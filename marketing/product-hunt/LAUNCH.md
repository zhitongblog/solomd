# Product Hunt Launch Guide

## Basic Info

### Product Name
```
SoloMD
```

### Tagline (60 chars max)
```
A 15 MB Markdown editor. No bloat. No cloud. Just write.
```

### Topics
- Markdown
- Writing Tools
- Developer Tools
- Open Source
- Productivity

### Links
- Website: https://solomd.app
- GitHub: https://github.com/zhitongblog/solomd

---

## Description (260 chars max for short, 500 for full)

### Short Description
```
SoloMD is a lightweight, cross-platform Markdown editor built with Tauri 2 and Rust. At just 15 MB, it's 5-10x smaller than Electron alternatives. Features live preview, KaTeX math, Mermaid diagrams, and works fully offline. Free and open source (MIT).
```

### Full Description
```
SoloMD is a Markdown editor for people who want to write without distractions.

**Why SoloMD?**

Most Markdown editors bundle Chromium and weigh 100-250 MB. SoloMD uses Tauri 2 with your system's webview, keeping the install size around 15 MB.

**Core Features:**
• Live preview – Markdown markers hide when cursor leaves the line
• KaTeX math – Write $E=mc^2$ and see it rendered
• Mermaid diagrams – Flowcharts, sequence diagrams, Gantt charts
• Multi-encoding – Auto-detects GBK, Big5, Shift_JIS for legacy files
• Clean AI Artifacts – One click to remove [cite_start] and curly quotes from ChatGPT paste
• Focus mode – Dims everything except current paragraph
• Export – HTML, PDF, DOCX with tables and math

**Privacy-first:**
• Zero telemetry
• No accounts required
• Files never leave your machine
• Fully offline capable

**Open Source:**
MIT licensed. Audit the code, fork it, contribute.

Available for macOS (universal), Windows (x64), and Linux (AppImage/deb/rpm).
```

---

## Maker Comment (First Comment)

```
Hi Product Hunt! 👋

I'm the maker of SoloMD. I built this because I was frustrated with Markdown editors that:
- Take 5+ seconds to launch
- Use 500 MB of RAM for a text file
- Require cloud accounts or subscriptions

SoloMD is my answer: a simple, fast editor that respects your privacy and your disk space.

**Technical details for the curious:**
- Built with Tauri 2 (Rust backend)
- Vue 3 + TypeScript frontend
- CodeMirror 6 for the editor
- Uses system webview (WKWebView on macOS, WebView2 on Windows)

It's fully open source under MIT license. I'd love to hear your feedback and feature requests!

GitHub: https://github.com/zhitongblog/solomd
```

---

## Screenshots (Required: 5 images)

### Screenshot Specifications
- Dimensions: 1270 x 760 px (recommended)
- Format: PNG or JPG
- File size: < 3 MB each

### Screenshots Needed (YOU MUST CAPTURE THESE)

1. **Hero shot** – Main editor with Markdown content showing live preview
2. **Dark mode** – Same content in dark theme
3. **KaTeX math** – Document with math equations rendered
4. **Mermaid diagram** – Flowchart or sequence diagram visible
5. **Export dialog** – Showing HTML/PDF/DOCX options

### Screenshot Captions

1. `Live preview with syntax highlighting`
2. `Beautiful dark mode for late-night writing`
3. `KaTeX math rendering built-in`
4. `Mermaid diagrams for visual documentation`
5. `Export to HTML, PDF, or Word`

---

## Launch Checklist

### 2 Weeks Before
- [ ] Submit to Product Hunt "Upcoming" page
- [ ] Prepare all 5 screenshots
- [ ] Record 30-second product video (optional but recommended)
- [ ] Reach out to hunters if you want a top hunter to post

### 1 Day Before
- [ ] Schedule launch for 12:01 AM PST
- [ ] Prepare maker comment
- [ ] Draft responses to common questions
- [ ] Notify your community (Twitter, Discord, etc.)

### Launch Day
- [ ] Post maker comment immediately
- [ ] Respond to every comment within 1 hour
- [ ] Share on Twitter with #ProductHunt
- [ ] Don't ask for upvotes (against PH rules)

### Common Questions to Prepare

**Q: How is this different from Obsidian?**
```
Obsidian is a knowledge base with linking, graphs, and plugins. SoloMD is a simple editor for when you just want to write a single document. Different tools for different workflows!
```

**Q: Why not just use VS Code?**
```
VS Code is great if you're already in it. SoloMD is for opening a quick .md file without loading an entire IDE. Think Notepad++, but with proper Markdown rendering.
```

**Q: Is there a mobile version?**
```
Not yet! Desktop only for now (macOS, Windows, Linux). Mobile is something I'm considering for the future.
```

---

## Attached Images

- `solomd_icon.png` – Product icon (upload as thumbnail)
- `og-image.png` – Social share image
- `comparison-en.png` – For comments if asked about competitors
