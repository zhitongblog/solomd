# Mac App Store Build Notes — READ BEFORE SUBMITTING

The current Mac build of SoloMD is **Developer ID-signed for direct distribution**. Shipping to the Mac App Store requires several changes. None are one-line — expect to spend some time here before first submission.

## Required changes

### 1. Signing identities

The MAS build must be signed with:

- **`3rd Party Mac Developer Application: xiangdong li (6NQM3XP5RF)`** — app binary
- **`3rd Party Mac Developer Installer: xiangdong li (6NQM3XP5RF)`** — the `.pkg` uploaded via Transporter / altool

Create both certs in App Store Connect → Certificates, Identifiers & Profiles → Certificates → **+**.

### 2. Provisioning profile

Create a **Mac App Store Distribution** provisioning profile that matches bundle id `app.solomd` (or whatever you use for the MAS SKU). Download to `~/Library/MobileDevice/Provisioning Profiles/`.

### 3. Sandbox entitlements

MAS builds must be sandboxed. Add an entitlements file at `app/src-tauri/entitlements.mas.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.files.user-selected.read-write</key><true/>
  <key>com.apple.security.files.bookmarks.app-scope</key><true/>
  <key>com.apple.security.print</key><true/>
</dict>
</plist>
```

Avoid broad entitlements (no `files.all`, no `network.client` unless strictly needed — current production build has no outbound network calls, so leave network out).

### 4. Tauri config — MAS bundle

Add a MAS-only bundle target in `app/src-tauri/tauri.conf.json`:

```jsonc
"bundle": {
  "macOS": {
    "entitlements": "entitlements.mas.plist",
    "providerShortName": "6NQM3XP5RF",
    "signingIdentity": "3rd Party Mac Developer Application: xiangdong li (6NQM3XP5RF)",
    "minimumSystemVersion": "11.0"
  }
}
```

### 5. Disable the "check for updates" feature

The MAS handles updates. Gate the auto-update check on a `MAS_BUILD` compile-time flag (Rust feature or Vite env var) so the Settings panel hides it and `App.vue` never calls the update endpoint. Apple will reject the build otherwise.

Suggested approach:

- Add `MAS_BUILD` env var in the MAS-specific build command.
- In `App.vue`, gate `checkForUpdates()` on `import.meta.env.VITE_MAS_BUILD !== '1'`.
- In `SettingsPanel.vue`, hide the auto-update toggle when `VITE_MAS_BUILD === '1'`.

### 6. Add `ITSAppUsesNonExemptEncryption`

Add this to `tauri.conf.json → bundle.macOS.infoPlist` (or generate via Tauri):

```
"ITSAppUsesNonExemptEncryption": false
```

### 7. Build + upload

Once the above is in place:

```bash
cd app
# Build with MAS env
VITE_MAS_BUILD=1 pnpm tauri build --bundles app --target universal-apple-darwin
# Tauri produces SoloMD.app signed with the 3rd Party Mac Developer Application cert
# Create the pkg:
productbuild --sign "3rd Party Mac Developer Installer: xiangdong li (6NQM3XP5RF)" \
  --component src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloMD.app /Applications \
  SoloMD-MAS-0.1.12.pkg
# Upload via Transporter.app or:
xcrun altool --upload-app -f SoloMD-MAS-0.1.12.pkg -t macos \
  -u slushy@139.com -p "@keychain:solomd"
```

### 8. First-submission gotchas

- Sandbox violations surface only at runtime. Test the full MAS build locally (install the pkg, launch, edit/save a file from Finder drag, export PDF, copy as image) before upload.
- If file pickers fail silently, check `com.apple.security.files.bookmarks.app-scope` — you need it to remember recently opened documents.
- `convertFileSrc()` and the `assetProtocol` used in Preview.vue still work under sandbox because asset URLs are app-internal. No change needed.
- Mermaid and KaTeX resources are bundled inside the app — no runtime download, no network entitlement needed.

## Recommended order of operations

1. Decide if MAS build shares the iOS bundle id (`app.solomd`) or gets its own (e.g. `app.solomd.mac`). Sharing is fine for Universal Purchase later.
2. Register certs + provisioning profile on developer.apple.com.
3. Write the MAS entitlements file.
4. Add the `MAS_BUILD` flag and gate auto-update.
5. Local test of sandboxed build.
6. First archive upload — expect Apple to reject the first 1–2 times on minor metadata issues. That's normal.

Once the MAS build is green, submission itself is identical to the iOS flow (description, screenshots, review notes, privacy label — all provided in `DESCRIPTION_*.md` etc.).
