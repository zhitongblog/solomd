# App Privacy (Privacy Nutrition Label) — macOS

Paste these answers into **App Privacy** in App Store Connect.

## Does your app collect any data?

**No** — select "No, we do not collect data from this app".

## Rationale (for your own records, do not submit)

SoloMD:
- Has no account system, no login, no analytics SDK, no ad SDK, no crash reporting SDK.
- Does not transmit user content anywhere — all files stay in the user's local file system.
- Does not read the address book, photos, location, clipboard (beyond user-initiated cut/copy/paste), or any identifier beyond what macOS provides automatically.
- The App Store build makes no outbound network requests. (A "check for updates" feature that exists in the direct-distribution build is disabled in the App Store build since the store handles updates.)
- No third-party dependencies phone home at runtime.

## Privacy Policy URL

`https://solomd.app/privacy` (use the same policy page as the iOS submission — see `../ios/PRIVACY.md`)
