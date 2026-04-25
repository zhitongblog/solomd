# Hero demo media

The Hero component on the homepage references:

- `solomd-demo.mp4` — the autoplay/loop demo video
- `solomd-demo.jpg` — the poster frame (also the `<noscript>` fallback)

These two files are intentionally **not committed** (the SVG below is used as
a placeholder until a real recording is dropped in).

## Recording recipe

1. Open SoloMD with a sample markdown doc (use `Welcome.md` from the welcome tour).
2. Set window to 1280×800 (16:10) for clean aspect ratio.
3. Record 20–30 s with these beats:
   - Type a few lines (live preview kicks in)
   - Cycle view modes (`Ctrl+Shift+P`)
   - Open command palette (`Ctrl+K`)
   - Trigger slideshow (`Ctrl+Alt+P`)
4. Export:
   - `solomd-demo.mp4` — H.264, ~2–3 MB target, 1280×800
   - `solomd-demo.jpg` — first-frame poster
5. Drop both into this folder and they'll be picked up automatically.

The CSS sets `aspect-ratio: 16/10` so anything matching that ratio will look correct.
