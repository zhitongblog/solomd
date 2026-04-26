# SoloMD Web Clipper

Send the page you're reading — or just your text selection — to your local SoloMD inbox over a 127.0.0.1 HTTP endpoint. Local-only: no remote servers, no telemetry, no accounts.

Ships as a single codebase that builds two store-loadable artefacts:

- `dist/chrome.zip` — Chrome / Edge / Brave (Manifest V3)
- `dist/firefox.zip` — Firefox 115+ (Manifest V2)

## Three actions

| Action          | Toolbar popup | Right-click menu | Keyboard shortcut |
| --------------- | ------------- | ---------------- | ----------------- |
| Clip whole page | yes           | yes (page)       | (use selection shortcut on no selection) |
| Clip selection  | yes           | yes (selection)  | `Ctrl/Cmd+Shift+S` |
| Save link       | yes           | yes (link)       | `Ctrl/Cmd+Shift+L` |

Every action ends with a desktop notification — "Saved to SoloMD inbox: <title>" on success, a specific error string on failure (endpoint not running, wrong token, no workspace open, etc.).

## How it talks to SoloMD

- The desktop app exposes a token-gated `POST http://127.0.0.1:7777/capture` endpoint (see `app/src-tauri/src/capture_endpoint.rs`).
- The clipper extracts the page's main content via [Mozilla Readability](https://github.com/mozilla/readability) and converts it to Markdown via [Turndown](https://github.com/mixmark-io/turndown), with a SoloMD-tuned preset (preserves headings / lists / tables / fenced code with language hint / blockquotes / links / images, strips scripts/styles/cookie banners, rewrites relative URLs to absolute).
- A YAML front matter block is prepended:
  ```yaml
  ---
  source_url: <full URL>
  captured_at: <ISO 8601 with offset>
  title: <document.title>
  inbox: true
  ---
  ```
- The receiver re-wraps that body inside its own front matter, derives a slug from the title, and writes `<workspace>/inbox/<YYYY-MM-DD-HHMM>-<slug>.md`.

## First-time setup (pairing)

1. Open SoloMD on your desktop, go to **Settings → Integrations → HTTP capture endpoint**, toggle it on, and click **Show / Copy** to grab the bearer token.
2. Open the clipper's **Settings** (toolbar popup → "Settings" button, or `chrome://extensions` → Details → Extension options).
3. Paste the token. Endpoint URL stays at the default `http://127.0.0.1:7777` unless you changed it on the SoloMD side.
4. Click **Test connection**. On success it shows the workspace path SoloMD currently has open. On failure it shows the exact server message.
5. Save. You're paired.

## Build

```bash
pnpm install
pnpm build           # produces dist/chrome.zip + dist/firefox.zip + dist/source.zip
pnpm build:chrome    # only Chrome zip (faster for iterative dev)
pnpm build:firefox   # only Firefox zip
pnpm typecheck       # tsc --noEmit
```

Output layout:

```
dist/
├── chrome/             # unpacked Chrome MV3 — load via chrome://extensions → "Load unpacked"
├── chrome.zip          # store-ready
├── firefox/            # unpacked Firefox MV2 — load via about:debugging → "Load Temporary Add-on"
├── firefox.zip         # store-ready (xpi-equivalent)
└── source.zip          # full source tree minus node_modules — for AMO reviewer requirements
```

## Load unpacked (development)

### Chrome / Edge / Brave

1. Run `pnpm build:chrome`.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `web-clipper/dist/chrome/`.
3. Pin the extension to the toolbar.

### Firefox

1. Run `pnpm build:firefox`.
2. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `web-clipper/dist/firefox/manifest.json`.

(Reload after every rebuild.)

## End-to-end smoke test

Two test scripts, both run without a built SoloMD desktop app:

```bash
pnpm test:markdown   # JSDOM-driven test of the Readability + turndown pipeline
pnpm smoke           # full HTTP round-trip vs the real Rust capture_endpoint
```

`pnpm smoke` builds `cargo run --example capture_drive`, points it at `/tmp/wclip-test-vault`, and POSTs the same wire-format the extension produces. Asserts three notes land in `inbox/` with the right YAML.

If you want to verify against the live Chrome runtime (loads `dist/live-driver.js` into a real fixture page in DevTools-attached Chrome), build the live driver:

```bash
node scripts/build-live-driver.mjs
```

…then call `window.__solomdClipFor(endpoint, token, mode)` from the page console.

## Privacy

The extension's manifest declares **only** `http://127.0.0.1/*` and `http://localhost/*` host permissions. There is no remote analytics, no error reporting, no auto-update beyond the store's own. Your bearer token lives in `browser.storage.local` and is sent only to the loopback endpoint you configured.

If you change the endpoint URL to something non-loopback (`http://192.168.1.5:7777`, say), the extension will let you — but you're now broadcasting your token over your LAN. Don't.

## License

MIT — same as the parent SoloMD project.
