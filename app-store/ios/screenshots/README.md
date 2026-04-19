# iPad Screenshots

All images are **2752 × 2064** landscape PNG — the required size for 13-inch iPad Pro (M5) in App Store Connect.

## Captured

| File | Shows | Caption idea (EN / zh) |
|---|---|---|
| `01-split-view.png` | Main split layout with welcome content, KaTeX math, syntax-highlighted Python code block, and a Mermaid flowchart starting to render below | "Live preview. Beautiful Markdown." / "实时预览 漂亮的 Markdown" |
| `02-mermaid-code.png` | Mermaid flowchart fully rendered in preview plus syntax-highlighted code block | "Diagrams and code, rendered instantly" / "图表与代码 即时渲染" |
| `03-outline.png` | Three-pane layout: outline sidebar + editor + preview; outline item highlighted as current section | "Navigate with the outline" / "用大纲秒速跳转" |
| `04-settings.png` | Settings modal with language, theme, font family/sizes, feature toggles | "Tune every detail" / "每个细节都可以调" |

Four screenshots meet Apple's 3–10 per-device minimum.

## Known caveats (please review before upload)

1. **iOS keyboard assistant bar** — a small `[A ^ v 🎤]` floating toolbar appears at the bottom of every screenshot where the editor had focus. This is the iPad hardware-keyboard input assistant; on a real device it disappears when no text field is focused. Two options:
   - Accept as-is (many legitimate iPad productivity apps ship shots with the bar — Apple does not reject on this alone).
   - Re-capture on a real iPad with the keyboard bar dismissed (tap the down-arrow on the bar before screenshot).
2. **Status bar** — the simulator status bar still shows `22:57 4月17日周五` and battery 100%. Apple's marketing guidelines recommend overriding via `xcrun simctl status_bar booted override --time "9:41"`. Re-run `scripts/ipad-screenshots.sh` (TODO) or override the bar manually before the next capture pass.
3. **Missing shots that would be nice to add**:
   - Preview-only mode (requires `⌘⇧P` binding on iOS — not currently wired up, would need a toolbar tap instead)
   - Dark theme (requires tapping the moon icon or switching Theme in Settings)
   - Image pinch-zoom overlay (requires adding an image to the demo doc then double-tapping)
   - File tree with real folders (requires granting Files permission)

## How these were captured

Demo Markdown (see `/tmp/demo.md` — check git for the version used) was pasted into a fresh SoloMD tab in the iPad Pro 13-inch (M5) Simulator, then the simulator was driven via `osascript`/`cliclick` to toggle outline, open settings, etc. Each screenshot was taken with `xcrun simctl io booted screenshot` (produces 2064 × 2752 portrait buffer) and rotated `-90°` via `sips` to the final landscape 2752 × 2064.
