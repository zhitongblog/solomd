# SoloMD iOS Shortcuts presets

Three ready-to-build Shortcuts that hit the SoloMD desktop app's `/capture` HTTP endpoint over your local network. They run on iPhone and iPad (iOS 15+) and need nothing more than the app's bearer token.

These are step-by-step recipes, not signed `.shortcut` files. The Shortcuts app guards every imported action against URL-scheme injection, and Apple's iCloud share links require the original author's developer account. Building once on your own device gives you ownership and avoids any third-party trust step.

## Before you start

1. Open **SoloMD on your Mac/Windows/Linux machine**.
2. Go to **Settings → Capture endpoint**.
3. Toggle **Enable** on. Note the URL (default `http://127.0.0.1:7777`) and the **bearer token** (tap the copy button).
4. Make sure your iPhone/iPad and your computer are on the **same Wi-Fi network**. Replace `127.0.0.1` in the URL below with your computer's LAN IP (System Settings → Network → look for `192.168.x.x` or `10.0.x.x`). If you only ever capture while at your desk, you can run a Shortcut over a cable + Personal Hotspot too.

The endpoint is bound to `0.0.0.0` only when you tick "Allow LAN access" in the same panel. Without that, iOS can't reach it; with that, your firewall will gate inbound 7777 to whatever subnets you allow.

## The three recipes

### 1. Quick capture — `solomd-quick-capture`

Action chain in Shortcuts:

1. **Ask for Input** — `Text`, prompt: `Capture to inbox`.
2. **Get Contents of URL**
   - URL: `http://YOUR-LAN-IP:7777/capture`
   - Method: `POST`
   - Headers:
     - `Authorization: Bearer YOUR-TOKEN`
     - `Content-Type: application/json`
   - Request Body: `JSON`
     - `body` → `Provided Input` (markdown text the user typed)
     - `title` → `Quick capture <Current Date>` (use the date variable, format = ISO 8601 short)
     - `inbox` → `1` (boolean true)
3. **If** the response status is `200`:
   - **Show Notification** with `Saved: <title>`.
   - Otherwise: **Show Notification** with `Capture failed: <Contents of URL>`.

Add to **Share Sheet** so any selected text on iOS triggers it. Add to **Home Screen** for a one-tap launcher.

### 2. Append to today's daily note — `solomd-append-daily`

Reuses v2.4's new `append_path` mode so you don't accumulate a new file per thought.

1. **Ask for Input** — `Text`, prompt: `Append to today`.
2. **Format Date** — current date, format `yyyy-MM-dd`.
3. **Get Contents of URL**
   - Same URL/headers as recipe #1.
   - Request Body JSON:
     - `body` → `\n- {{Provided Input}}` (the leading `\n- ` makes each entry a bullet item)
     - `append_path` → `daily/{{formatted-date}}.md`
4. Notification on success/failure as above.

If `daily/<date>.md` doesn't exist yet, the endpoint creates it. The directory layout matches the desktop app's daily-note convention.

### 3. Clip a URL from Safari — `solomd-clip-url`

Run this from Safari → Share → Shortcuts → SoloMD: Clip URL. Or paste a URL into Shortcuts manually.

1. **Get Contents of Web Page** (input: URL from share sheet).
2. **Make Rich Text from HTML** (article body extracted by iOS).
3. **Make Markdown from Rich Text**.
4. **Get Details of Web Page** (URL → keep) and **of Web Page** (Title → keep).
5. **Text** action that builds:
   ```
   ---
   source_url: {{URL}}
   captured_at: {{Current Date in ISO 8601}}
   title: {{Page title}}
   inbox: true
   ---

   {{Markdown body}}
   ```
6. **Get Contents of URL** with that text as `body`, no `append_path`. Use `title` of `{{Page title}}`.
7. Notification on success.

iOS's HTML-to-markdown is not great with code blocks; for technical articles prefer the desktop browser web clipper extension. For news, blog posts, and recipes it works well enough.

## Hand-build vs. iCloud share links

This README is the canonical source. If a future SoloMD release ships iCloud share links, they'll appear at <https://solomd.app/ios-shortcuts/> with QR codes. Until then, a 30-second hand-build is the fastest path. Built shortcuts are local to your iCloud account; nobody else's Shortcuts app can change them.

## Privacy

Every action goes to `http://YOUR-LAN-IP:7777/capture` on your own LAN. No third-party server is involved. No telemetry. The shortcuts only ever talk to the URL you typed into them, with the token you pasted, and only when you tap them. See <https://solomd.app/security/#capture> for the endpoint's full protocol.
