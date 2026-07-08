# App Store Connect Metadata — macOS

## App Information

| Field | Value |
|---|---|
| App Name | SoloMD |
| Subtitle (EN) | Minimalist Markdown editor |
| Subtitle (zh-Hans) | 极简 Markdown 编辑器 |
| Bundle ID | app.solomd (shared with iOS — or use `app.solomd.mac` if App Store Connect insists on a distinct record) |
| SKU | solomd-mac-001 |
| Primary Language | English (U.S.) |
| Additional Language | Simplified Chinese |
| Category — Primary | Productivity |
| Category — Secondary | Developer Tools |
| Content Rights | Does not contain, show, or access third-party content |
| Age Rating | 4+ (no objectionable content) |
| Price | Free |
| Availability | All countries/regions |

## URLs

| Field | Value |
|---|---|
| Marketing URL | https://solomd.app |
| Support URL | https://github.com/zhitongblog/solomd/issues |
| Privacy Policy URL | https://solomd.app/privacy |

## Platform

- **macOS 11.0+** (raise minimum from 10.15 to 11.0 for App Store — see `MAS_BUILD_NOTES.md`)
- **Architectures**: Universal (arm64 + x86_64)

## App Review

- Sign-in required: **No**
- Demo account: **not applicable**
- Contact email: slushy@139.com
- Notes: see `REVIEW_NOTES.md`

## Age Rating questionnaire answers

All "None" — result **4+**. See `../ios/METADATA.md` for the full questionnaire (answers are identical).

## Export Compliance

- Uses encryption? **Yes** (standard HTTPS / system TLS only)
- Qualifies for exemption? **Yes** (per 5D002)
- Add to `Info.plist`: `ITSAppUsesNonExemptEncryption = NO`

## In-App Purchases

None.

## Version Information

- Version: 0.1.12
- Copyright: © 2026 xiangdong li
- What's New: see `WHATS_NEW_en.md` / `WHATS_NEW_zh.md`

## Screenshots required

macOS screenshots are **required at 2880 × 1800** (16:10, native Retina MacBook Pro):

- Size: 2880 × 1800 (also accepted: 2560 × 1600, 1440 × 900, 1280 × 800)
- Quantity: 3–10 screenshots
- Format: PNG or JPEG, RGB, no alpha

See `screenshots/` directory for the captured set.
