# Mac Screenshots

All images are **2880 × 1800** — the MacBook Pro 15" Retina App Store screenshot size. This is the preferred size and auto-scales to other Mac display sizes.

## Captured

| File | Shows | Caption idea (EN / zh) |
|---|---|---|
| `01-split-view.png` | Outline sidebar + editor + preview, light theme. Welcome content with live-preview checklist and KaTeX math rendered | "Live preview. Outline navigation." / "实时预览 大纲导航" |
| `02-mermaid-code.png` | Task list + Table + Chinese section in the editor, with Mermaid flowchart and rendered code block in the preview | "Mermaid, KaTeX, and 13+ code languages" / "Mermaid 图表、KaTeX 公式、13+ 语言代码高亮" |
| `03-settings.png` | Settings panel with Language / Theme / Font / feature toggles | "Tune every detail" / "每个细节都可以调" |
| `04-dark.png` | Full dark theme across outline + editor + preview | "Comfortable dark theme" / "舒适的深色主题" |
| `05-diagram-zoom.png` | Mermaid diagram opened in the pinch/click-to-zoom overlay | "Zoom into every diagram" / "任何图表都能放大" |

Five screenshots — above the 3-minimum, below the 10-maximum.

## Known caveats

1. **UI language**: screenshots were captured with SoloMD in Chinese mode (menu bar shows `SoloMD 编辑 视图 帮助`). For the English App Store Connect locale you should re-capture with SoloMD in English. The fastest path: open Settings → Language → English, then re-run the capture pass. The text content in the editor/preview is already bilingual.
2. **macOS menu bar + Dock visible**: the top menu bar and bottom Dock are in every shot. This is fine for Apple Store and signals "Mac-native app" — Apple does not reject on this. If you prefer a dock-free marketing version, use `⌥⌘D` to auto-hide the Dock before the capture pass.
3. **Desktop wallpaper**: the default macOS wallpaper shows through around window edges. Replace with a plain solid color before capture for cleanest shots.

## How these were captured

Demo Markdown (`/tmp/demo.md`) was pasted into `/Applications/SoloMD.app` after activating and resizing the window to a full-width bounds (0, 30) size (1440, 798). Each screenshot is a full-display capture via `screencapture -x -o` at native Retina resolution 2880×1800. State changes (open outline, open settings, toggle dark, open diagram zoom) were driven via `osascript`/`cliclick` against the app's menu hierarchy.
