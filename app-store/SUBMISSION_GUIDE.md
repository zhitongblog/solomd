# SoloMD — App Store Submission Guide

End-to-end walkthrough for submitting SoloMD to the **iPad App Store** and the **Mac App Store**. Follow top-to-bottom once; use as a reference afterwards.

**Time budget (first-time submission):**
- iPad: ~2 hours build + ~30 min metadata + ~1–3 day review
- Mac: ~4–6 hours (sandbox work) + ~30 min metadata + ~1–3 day review

**Assumptions:**
- You already have an active paid **Apple Developer Program** membership (`$99/year`, team `6NQM3XP5RF`, individual account `slushy@139.com`).
- Local dev works: `cd app && pnpm tauri dev` launches the app, `pnpm tauri ios dev` builds for the iPad simulator, `pnpm tauri build` produces a Developer ID-signed Mac DMG.
- You have access to the Mac signing keychain with the existing Developer ID cert.

---

## Table of contents

1. [Prerequisites — one-time setup](#1-prerequisites--one-time-setup)
2. [iPad App Store — build & submit](#2-ipad-app-store--build--submit)
3. [Mac App Store — sandbox build & submit](#3-mac-app-store--sandbox-build--submit)
4. [App Store Connect — creating the app record](#4-app-store-connect--creating-the-app-record)
5. [Uploading the build via Xcode / Transporter](#5-uploading-the-build-via-xcode--transporter)
6. [Filling in the metadata](#6-filling-in-the-metadata)
7. [Privacy, age rating, and export compliance](#7-privacy-age-rating-and-export-compliance)
8. [Submitting for review](#8-submitting-for-review)
9. [Common rejection reasons — and how to fix them](#9-common-rejection-reasons--and-how-to-fix-them)
10. [After approval — release, updates, and analytics](#10-after-approval--release-updates-and-analytics)
11. [Troubleshooting cheat sheet](#11-troubleshooting-cheat-sheet)

---

## 1. Prerequisites — one-time setup

### 1.1 App Store Connect access

1. Go to https://appstoreconnect.apple.com and sign in with `slushy@139.com`.
2. Accept any pending Program License Agreement and Paid Apps Agreement (required even for free apps — the contract governs tax/banking, not money).
3. In **Users and Access**, verify your role is `Account Holder` or `Admin`.

### 1.2 Certificates (download, install, verify)

In https://developer.apple.com/account → **Certificates, Identifiers & Profiles**.

**For iPad:**

- `Apple Development` (for running on your iPad) — already in your keychain from dev work.
- `Apple Distribution` (for App Store upload). Create via **+** → Apple Distribution → upload a CSR from Keychain Access. Download the `.cer`, double-click to install.

**For Mac App Store (extra two certs):**

- `Mac App Distribution` a.k.a. `3rd Party Mac Developer Application: xiangdong li (6NQM3XP5RF)` — signs the `.app` binary.
- `Mac Installer Distribution` a.k.a. `3rd Party Mac Developer Installer: xiangdong li (6NQM3XP5RF)` — signs the `.pkg` installer.

Create both via **+** → choose the Mac App types. After download + install, verify:

```bash
security find-identity -p codesigning -v | grep -E '(Apple Distribution|3rd Party Mac Developer)'
```

You should see three identities: one Apple Distribution and two 3rd Party Mac Developer ones.

### 1.3 Identifiers (bundle IDs)

In **Identifiers**, create two if they don't exist:

| Identifier | Bundle ID | Platform | Capabilities |
|---|---|---|---|
| SoloMD iOS | `app.solomd` | iOS, iPadOS | (none — leave all unchecked) |
| SoloMD macOS | `app.solomd` *(or `app.solomd.mac`)* | macOS | App Sandbox |

If you want **Universal Purchase** (one price/purchase covers both iPad and Mac), use the **same bundle ID** `app.solomd` for both. Otherwise give the Mac version its own ID.

### 1.4 Provisioning profiles

Xcode manages these automatically in most cases. To create manually:

- iPad: `App Store` type, bundle `app.solomd`, signed by Apple Distribution cert.
- Mac: `Mac App Store` type, bundle `app.solomd` (or `.mac`), signed by 3rd Party Mac Developer Application.

Download both `.mobileprovision` / `.provisionprofile` files and install by double-clicking.

### 1.5 Publish the privacy policy

Apple requires a **public Privacy Policy URL** before the app is approved. Our policy is already drafted — see `ios/PRIVACY.md`. You need to publish it at `https://solomd.app/privacy` **before** submitting.

```bash
# Copy the policy into the website source and deploy
cp app-store/ios/PRIVACY.md web/src/content/privacy.md   # adjust path to your Astro/content layout
cd web && pnpm build && pnpm deploy                        # your usual Cloudflare Pages flow
```

Verify it's live: `curl -sSI https://solomd.app/privacy | head -n 1` should return `200`.

---

## 2. iPad App Store — build & submit

### 2.1 Pre-flight code changes

Open `app/src-tauri/gen/apple/project.yml` and confirm:

```yaml
properties:
  CFBundleShortVersionString: 0.1.12
  CFBundleVersion: "0.1.12"
  ITSAppUsesNonExemptEncryption: false   # ← ADD this line
  LSRequiresIPhoneOS: true
  NSLocalNetworkUsageDescription: ...    # already present, keep for dev
```

**Important for App Store build (not dev):** the dev build's `NSAllowsArbitraryLoads: true` and `NSAllowsLocalNetworking: true` under `NSAppTransportSecurity` are fine — we only use local loopback for live reload, which is automatically stripped from a release archive because `tauri ios build` uses bundled assets. But if Apple's automated review ever flags these keys, remove them for the archive and keep a separate dev-only variant.

Also confirm `app/src/lib/platform.ts` already gates `checkForUpdates()` on `!isIOS()` (it does, per earlier work).

### 2.2 Build the archive

```bash
cd app
# Clean first so nothing stale leaks through
rm -rf src-tauri/gen/apple/build
# Build for device (App Store archives need arm64 device target)
pnpm tauri ios build --export-method app-store-connect
```

Tauri calls `xcodebuild archive` under the hood and produces:
- `app/src-tauri/gen/apple/build/arm64/SoloMD.ipa`

If the build fails with signing errors, open the project in Xcode and let it fix signing automatically:

```bash
open app/src-tauri/gen/apple/solomd.xcodeproj
```

In Xcode: select the `solomd_iOS` target → **Signing & Capabilities** → ensure team is `xiangdong li (6NQM3XP5RF)` and "Automatically manage signing" is checked. Then `Product → Archive`.

### 2.3 Validate & upload

With an Xcode archive (Organizer will show after archiving):

1. Xcode → Window → **Organizer** → select the SoloMD archive.
2. Click **Distribute App** → **App Store Connect** → **Upload**.
3. Xcode re-signs, validates, and uploads. 5–15 min for the build to show up under "TestFlight" in App Store Connect.

Alternative CLI path (no Xcode GUI):

```bash
xcrun altool --upload-app -f app/src-tauri/gen/apple/build/arm64/SoloMD.ipa \
  -t ios -u slushy@139.com -p "@keychain:solomd"
```

The `@keychain:solomd` is the app-specific password profile you stored earlier.

### 2.4 Wait for processing

In App Store Connect → **Apps → SoloMD → TestFlight → Builds**, the new build appears as "Processing" for 5–30 minutes. Once it turns into a version number with a green check, proceed to [section 4](#4-app-store-connect--creating-the-app-record).

---

## 3. Mac App Store — sandbox build & submit

This is **not a simple rebuild of the existing Mac app**. The App Store build requires sandboxing, different signing, and must not hit any network. Plan 4–6 hours for the first pass.

### 3.1 Add the sandbox entitlements file

Create `app/src-tauri/entitlements.mas.plist`:

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

Deliberately **no** `network.client` — the App Store build must not make outbound connections. If you ever need it (e.g., for image upload to a CDN), add it explicitly and declare the use in App Review Notes.

### 3.2 Add a MAS build flag

Gate the auto-update check. Edit `app/src/App.vue`:

```ts
// In the setup block, before the auto-update check:
if (import.meta.env.VITE_MAS_BUILD !== '1' && !isIOS()) {
  checkForUpdates();
}
```

And in `app/src/components/SettingsPanel.vue`, hide the auto-update toggle:

```vue
<section v-if="!isMobilePlatform && import.meta.env.VITE_MAS_BUILD !== '1'">
  <!-- auto-update toggle -->
</section>
```

### 3.3 Build & sign

```bash
cd app
# Universal binary + MAS-specific code path
VITE_MAS_BUILD=1 pnpm tauri build --target universal-apple-darwin
```

Tauri produces `app/src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloMD.app` signed with the Developer ID cert. **Re-sign for MAS:**

```bash
APP=app/src-tauri/target/universal-apple-darwin/release/bundle/macos/SoloMD.app
IDENTITY="3rd Party Mac Developer Application: xiangdong li (6NQM3XP5RF)"
ENTITLEMENTS=app/src-tauri/entitlements.mas.plist

# Remove existing signature and re-sign with MAS cert + entitlements
codesign --deep --force --options=runtime \
  --sign "$IDENTITY" \
  --entitlements "$ENTITLEMENTS" \
  "$APP"

# Verify
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP"   # ok - satisfies its Designated Requirement
```

### 3.4 Wrap in a signed pkg installer

```bash
INSTALLER_IDENTITY="3rd Party Mac Developer Installer: xiangdong li (6NQM3XP5RF)"
PKG=SoloMD-MAS-0.1.12.pkg

productbuild \
  --sign "$INSTALLER_IDENTITY" \
  --component "$APP" /Applications \
  "$PKG"

# Verify the pkg
pkgutil --check-signature "$PKG"
```

### 3.5 Test locally before uploading

```bash
sudo installer -pkg "$PKG" -target /
open /Applications/SoloMD.app
```

Manually exercise every file-touching flow:
- Open a file (⌘O)
- Open a folder (⌘⇧O)
- Save, Save As
- Paste an image, verify it saves to `_assets/`
- Export PDF / HTML / DOCX
- Quit and relaunch — confirm "recently opened" still works (tests `files.bookmarks.app-scope`)

If any file operation silently fails, the sandbox is blocking it. Open **Console.app** and filter by SoloMD to see the denied operation; add the matching entitlement or switch to a user-selected dialog for that flow.

### 3.6 Upload

```bash
xcrun altool --upload-app -f "$PKG" -t macos \
  -u slushy@139.com -p "@keychain:solomd"
```

Or upload via **Transporter.app** (available in the Mac App Store — free) for a GUI. Wait 5–30 min for processing.

---

## 4. App Store Connect — creating the app record

You do this once per app. If the iPad and Mac versions share the bundle ID `app.solomd`, create one app record with both platforms; otherwise create two.

1. https://appstoreconnect.apple.com → **Apps → + → New App**
2. Fill in:

| Field | Value (iPad) | Value (Mac) |
|---|---|---|
| Platforms | ☑ iOS | ☑ macOS (check both if Universal Purchase) |
| Name | SoloMD | SoloMD |
| Primary Language | English (U.S.) | English (U.S.) |
| Bundle ID | `app.solomd` | `app.solomd` *(or `app.solomd.mac`)* |
| SKU | `solomd-ios-001` | `solomd-mac-001` |
| User Access | Full Access | Full Access |

3. Click **Create**.

### 4.1 Add Simplified Chinese localization

In the app record: **App Information → Localizable Information → +** → **Chinese (Simplified)**. This unlocks the zh fields for Subtitle / Description / Keywords / What's New / Promotional Text.

---

## 5. Uploading the build via Xcode / Transporter

Already covered in sections 2.3 and 3.6. After upload + processing, the build appears under:

- **iOS → TestFlight → iOS Builds → 0.1.12 (1)**
- **macOS → TestFlight → macOS Builds → 0.1.12 (1)**

Back in **App Store → iOS App / macOS App**, scroll to **Build** and click **+** to attach the processed build to the version you're preparing.

If the build never shows up after 60 minutes, check your email — Apple sends "ITMS-xxxxx" errors to the account holder with specific fixes (usually missing `ITSAppUsesNonExemptEncryption`, icon-size mismatch, or a disallowed entitlement).

---

## 6. Filling in the metadata

All the copy is already drafted in this repo. Match fields exactly:

### 6.1 iPad

| App Store Connect field | Source file | Notes |
|---|---|---|
| Subtitle (EN) | `ios/SUBTITLE_en.md` | 30 char max |
| Subtitle (zh) | `ios/SUBTITLE_zh.md` | |
| Promotional Text (EN) | `ios/PROMOTIONAL_TEXT_en.md` | 170 char max, editable any time |
| Promotional Text (zh) | `ios/PROMOTIONAL_TEXT_zh.md` | |
| Description (EN) | `ios/DESCRIPTION_en.md` | 4000 char max |
| Description (zh) | `ios/DESCRIPTION_zh.md` | |
| Keywords (EN) | `ios/KEYWORDS_en.md` | 100 char max, comma-separated |
| Keywords (zh) | `ios/KEYWORDS_zh.md` | |
| What's New (EN) | `ios/WHATS_NEW_en.md` | 4000 char max |
| What's New (zh) | `ios/WHATS_NEW_zh.md` | |
| Marketing URL | `https://solomd.app` | optional |
| Support URL | `https://github.com/zhitongblog/solomd/issues` | required |
| Privacy Policy URL | `https://solomd.app/privacy` | **required** |
| Copyright | `© 2026 xiangdong li` | |

### 6.2 Mac

Same structure — point each field at the corresponding `macos/*.md` file.

### 6.3 Screenshots — upload order matters

App Store Connect shows screenshots in the order you upload them. Front-load the strongest shot:

- **iPad — 13" iPad display, 2752 × 2064 landscape**, upload in this order:
  1. `01-split-view.png` (main hero shot)
  2. `02-mermaid-code.png` (proof of feature breadth)
  3. `03-outline.png` (navigation)
  4. `04-settings.png` (tunability)

- **Mac — 2880 × 1800**, upload in this order:
  1. `01-split-view.png`
  2. `02-mermaid-code.png`
  3. `04-dark.png` (theme)
  4. `05-diagram-zoom.png` (delight)
  5. `03-settings.png`

Apple auto-scales the screenshots down to smaller iPad/Mac sizes. You only need the largest size.

### 6.4 Category & pricing

- Primary category: **Productivity**
- Secondary category: **Developer Tools**
- Price tier: **Free** (Tier 0)
- Availability: **All countries/regions** (or pick subset if you want to exclude specific markets)

### 6.5 App icon

Apple requires a **1024 × 1024 PNG, no alpha, no rounded corners, no transparency**. This is separate from the icons bundled in the app.

```bash
# Assuming your master icon is at app/src-tauri/icons/icon.png
sips -z 1024 1024 app/src-tauri/icons/icon.png --out app-store/icon-1024.png
sips -s format png --setProperty hasAlpha false app-store/icon-1024.png --out app-store/icon-1024-noalpha.png
```

Upload under **App Information → App Icon** (separate upload per platform).

---

## 7. Privacy, age rating, and export compliance

### 7.1 App Privacy (nutrition label)

In **App Privacy → Get Started** → answer:

- **Do you or your third-party partners collect data from this app?** → **No**

That's it. All downstream questions collapse. This matches the content in `ios/PRIVACY.md`.

### 7.2 Age rating

**App Information → Age Rating → Edit**. Answer all 14 questions with **"None"** or **"No"**. The calculated rating will be **4+**.

Full answers are documented in `ios/METADATA.md` under "Age Rating questionnaire".

### 7.3 Export compliance

Under the version (not app-level), **Build → Export Compliance Information**:

- **Does your app use encryption?** → **Yes**
- **Does your app qualify for any exemptions provided in Category 5, Part 2 of the U.S. Export Administration Regulations?** → **Yes**
- **Does your app implement any proprietary encryption algorithms?** → **No**
- **Does your app implement any standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system?** → **No**

SoloMD only uses Apple's system TLS (HTTPS via WKWebView/URLSession). This qualifies for the mass-market exemption.

Set `ITSAppUsesNonExemptEncryption = false` in Info.plist (iOS) and tauri.conf.json (Mac) to skip this question on future uploads.

### 7.4 Content rights

**App Information → Content Rights** → check:

> "Does your app contain, show, or access third-party content?" → **No**

SoloMD only edits the user's own text files.

---

## 8. Submitting for review

With all fields filled and a build attached:

1. Scroll to the top of the version page.
2. Click **Add for Review** (first submission) or **Submit for Review** (subsequent).
3. Answer the final three questions:
   - **Export compliance** — already filled (see 7.3)
   - **Content rights** — "No" (matches 7.4)
   - **Advertising Identifier** — "No" (SoloMD does not use IDFA)
4. Click **Submit**.

Review typically takes **24–48 hours** for simple productivity apps. You'll get email notifications at each state change:

- `Waiting for Review` → queued
- `In Review` → a reviewer picked it up (usually means decision in <2 hours)
- `Pending Developer Release` → approved, waiting for you to hit the Release button (if you chose manual release)
- `Ready for Sale` → live
- `Rejected` → see section 9

### 8.1 Manual vs. automatic release

Under **Version Release**, choose **"Manually release this version"** for the first submission. That way if anything looks off after approval, you can fix before going live.

---

## 9. Common rejection reasons — and how to fix them

Based on Apple's public App Review Board rulings and past productivity-app rejections. SoloMD is designed to sidestep most of these, but here's the list:

| Guideline | Why it would fail SoloMD | Mitigation already in place |
|---|---|---|
| **2.1** App Completeness | Crashes or broken features | Test the archive build on a real iPad before upload. Tauri archives ≠ dev builds — if you skip this, you risk a day of review then a rejection |
| **2.3.7** Accurate metadata | Screenshots showing unreleased features | Our screenshots are captured from the 0.1.12 build that's being submitted — don't swap in a newer Mermaid/KaTeX demo from a future version |
| **2.4.5(iii)** Mac/iOS apps must not install software or behave outside sandbox | Auto-update feature | Already gated off on iOS; gate off in MAS build via `VITE_MAS_BUILD=1` |
| **2.5.2** Software requirements | Running executable code downloaded at runtime | SoloMD bundles KaTeX, Mermaid, highlight.js at build time — no runtime fetch. Do not add features that pull in JS from a CDN |
| **3.2.2** Acceptable business model | Mystery in-app purchases | None — set price Free with no IAP |
| **4.0** Design | "Minimum functionality" — app is just a website wrapper | SoloMD has real native features: system file associations, sandboxed file bookmarks, native menus, multi-window. Highlight these in Review Notes |
| **4.1** Copycats | Name/icon too similar to another app | SoloMD is distinct — verified via App Store search |
| **5.1.1** Data collection and storage | Any tracking without disclosure | Zero data collection; App Privacy answer is "No" |
| **5.1.1(v)** Account deletion | If you add accounts, you must let users delete them | N/A — no accounts |
| **5.2.3** Third-party content | Embedding a browser / news aggregator | N/A |

### 9.1 If rejected

1. Read the rejection message in **Resolution Center** carefully — it quotes a specific guideline.
2. Reply *in the Resolution Center* first with clarifying questions if the reason is ambiguous. Reviewers respond within 24h.
3. Fix the issue (code change, metadata change, or clarification in Review Notes).
4. For **metadata-only rejections** (description/screenshots): edit the field and hit **Resubmit** — no new build needed.
5. For **binary rejections**: increment build number (`CFBundleVersion`: `0.1.12` → `0.1.12.1`), rebuild, re-upload, re-attach, resubmit.

### 9.2 iPad-specific gotchas we've already guarded against

- **Local Network permission prompt** only appears in the dev build (live-reload uses Bonjour). The archive build disables dev URL so this prompt does not fire in production.
- **Missing CJK glyphs on iPad** was fixed by the bundled STHeiti woff2 subset (`app/src/styles/cjk-font.css`). If Apple runs on a pristine device this renders correctly.
- **External keyboard shortcut list** — Apple doesn't require this, but if you want to publish shortcuts to the iPad `⌘` overlay, add UIKeyCommand definitions in the Swift shell. Not needed for approval.

### 9.3 Mac-specific gotchas

- **Sandbox violations** surface only at runtime. Test every file flow locally before upload (section 3.5).
- **"Copy as Image" on Mac** uses the pasteboard — works inside sandbox, no extra entitlement.
- **Mermaid/KaTeX rendering** happens in the embedded WebView, entirely in-process — no network, no sandbox issue.

---

## 10. After approval — release, updates, and analytics

### 10.1 Releasing

If you chose manual release: click **Release This Version** on the version page. It goes live in all territories within a few hours (sometimes minutes).

### 10.2 Version updates

For future 0.1.13+ releases:

1. Bump `CFBundleShortVersionString` and `CFBundleVersion` in `project.yml` (iPad) and `tauri.conf.json` (Mac).
2. Build + upload the new archive.
3. In App Store Connect: **+ Version or Platform** → new version → attach build → update `WHATS_NEW_*.md` copy → submit.

Metadata from the previous version carries over — only What's New + screenshots (if features changed) need updating.

### 10.3 TestFlight (optional)

Before a public release, you can invite internal testers:

- **TestFlight → Internal Testing → App Store Connect Users → + Testers**
- Up to 100 internal testers, available immediately after build processes (no review).
- External TestFlight (up to 10,000 testers) requires a one-time TestFlight review (~24h) but then you can push new builds instantly.

Useful for catching issues with real iPad hardware before public launch.

### 10.4 Analytics

**App Store Connect → Analytics** shows downloads, crashes, sessions, device/country mix. No code needed — Apple collects this server-side from the Mac/iPad OS. Don't add any analytics SDK to the app; this data is free and doesn't require a Privacy label change.

---

## 11. Troubleshooting cheat sheet

### "ITMS-90683: Missing Purpose String"

You referenced a restricted API (e.g., Photos) without a `NSPhotoLibraryUsageDescription` in Info.plist. Add the key, rebuild, re-upload.

### "ITMS-90125: The binary is invalid — Code object is not signed at all"

Common on first MAS build — your re-sign step (section 3.3) missed a nested framework. Run:

```bash
find SoloMD.app -name "*.dylib" -o -name "*.framework" | while read f; do
  codesign --force --sign "$IDENTITY" --entitlements "$ENTITLEMENTS" "$f"
done
```

Then re-sign the outer `.app`.

### "ITMS-91053: Missing API declaration"

Apple now requires declaring privacy-sensitive API usage in a `PrivacyInfo.xcprivacy` file. Tauri 2.x generates a conservative one by default; if you see this error, add or edit `app/src-tauri/gen/apple/solomd_iOS/PrivacyInfo.xcprivacy` and re-upload.

### Build processing stuck >2 hours

Check your email for ITMS errors (they're sent to the account holder, not always surfaced in App Store Connect). If no email, write to App Review via **Contact Us → Ask a Question**.

### Xcode: "No Account for Team 6NQM3XP5RF"

Xcode → Settings → Accounts → **+** → sign in with `slushy@139.com`. Team should appear automatically.

### App Store Connect shows old build as "Latest"

Builds expire after 90 days without being attached to a submission. Upload a fresh build.

### Localization field won't save

Switch to **Chinese (Simplified)** in the top-right locale dropdown of the version page. The EN fields don't save zh text — you edit each locale separately.

---

## Final checklist — use before hitting Submit

- [ ] Build uploaded, processed, and attached to the version
- [ ] Version number matches bundle version (`0.1.12`)
- [ ] All English fields filled: subtitle, promo, description, keywords, what's new
- [ ] All Simplified Chinese fields filled (same four)
- [ ] 4–5 screenshots uploaded in the recommended order, all at the correct size
- [ ] 1024×1024 icon uploaded (no alpha)
- [ ] Marketing URL, Support URL, Privacy Policy URL all filled
- [ ] Privacy Policy page is live at `https://solomd.app/privacy`
- [ ] App Privacy: "No data collected"
- [ ] Age Rating: 4+
- [ ] Content Rights: No third-party content
- [ ] Export Compliance: Exempt (standard HTTPS only)
- [ ] Review Notes pasted from `REVIEW_NOTES.md`
- [ ] Contact email filled (slushy@139.com)
- [ ] Release: Manually
- [ ] Price tier: Free
- [ ] Categories: Productivity / Developer Tools

Hit **Submit for Review**. See you on the other side.

---

## Contact during review

If Apple reaches out via Resolution Center, respond within 24h — unanswered threads can delay approval by days. Messages arrive as email to `slushy@139.com` and appear in **App Store Connect → Resolution Center**.

Good luck!
