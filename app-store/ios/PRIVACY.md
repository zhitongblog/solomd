# App Privacy (Privacy Nutrition Label)

Paste these answers into **App Privacy** in App Store Connect.

## Does your app collect any data?

**No** — select "No, we do not collect data from this app".

## Rationale (for your own records, do not submit)

SoloMD:
- Has no account system, no login, no analytics SDK, no ad SDK, no crash reporting SDK.
- Does not transmit user content anywhere — all files stay in the app's local sandbox.
- Does not read the address book, photos, location, clipboard (beyond user-initiated cut/copy/paste), or any identifier beyond what iOS provides automatically.
- The production build makes no outbound network requests. (A "check for updates" feature that exists in the desktop version is disabled on iOS.)
- No third-party dependencies phone home at runtime.

## Privacy Policy URL

`https://solomd.app/privacy` (add page to web/ before submission — template below)

## Privacy Policy Template (publish at solomd.app/privacy)

```markdown
# SoloMD Privacy Policy

Last updated: 2026-04-17

## Summary

SoloMD is a local-first Markdown editor that collects no personal data of any kind. Your notes never leave your device.

## Data We Collect

None. SoloMD does not collect, store, transmit, or share any personal data or device identifiers. The app has no account system, no analytics, no advertising, and no telemetry.

## Data You Create

All text, images, and files you create or open in SoloMD are stored locally on your device inside the app's sandbox (iOS) or in folders you choose (macOS). SoloMD does not transmit this content to any server.

## Permissions We Request

SoloMD only uses iOS/macOS permissions required for its core editing function:
- **Local file access** — to open, read, and save files you choose.
- **Photos library** (only if you insert an image via the picker) — to read the single image you select.

We do not request contacts, location, microphone, camera, calendar, Bluetooth, or any other permission.

## Third Parties

SoloMD does not embed any third-party analytics, advertising, crash reporting, or social media SDKs. The app's source is open at github.com/zhitongblog/solomd (MIT).

## Children

SoloMD is suitable for all ages and does not knowingly collect data from children.

## Changes to This Policy

Any material changes will be reflected on this page and noted in the app's release notes.

## Contact

Questions? Email slushy@139.com or file an issue at github.com/zhitongblog/solomd/issues.
```
