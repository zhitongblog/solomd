# App Store Submission Kit

Content for submitting SoloMD to:

- **`ios/`** — iPad App Store (iPad Only, requires Apple Developer Program)
- **`macos/`** — Mac App Store (requires sandbox rebuild — see `macos/MAS_BUILD_NOTES.md`)

All user-facing copy is provided in English (`*_en.md`) and Simplified Chinese (`*_zh.md`). Paste these verbatim into App Store Connect when creating the app record — character limits are already enforced.

## File map

| File | Field in App Store Connect | Char limit |
|---|---|---|
| `DESCRIPTION_{en,zh}.md` | App Description | 4000 |
| `PROMOTIONAL_TEXT_{en,zh}.md` | Promotional Text | 170 |
| `KEYWORDS_{en,zh}.md` | Keywords | 100 |
| `WHATS_NEW_{en,zh}.md` | What's New in This Version | 4000 |
| `SUBTITLE_{en,zh}.md` | Subtitle | 30 |
| `REVIEW_NOTES.md` | App Review → Notes | 4000 |
| `PRIVACY.md` | Privacy Nutrition Label summary | — |
| `METADATA.md` | Category, age rating, pricing, URLs | — |
| `screenshots/` | Screenshots | device-specific |

## Quick submission checklist

1. Fill in App Information (name, subtitle, category, content rights, age rating)
2. Paste Description, Keywords, Promotional Text, Support URL, Marketing URL, Privacy Policy URL
3. Upload Screenshots (one set per required device)
4. Upload build via Xcode → Archive → Distribute App → App Store Connect
5. Fill in App Privacy (Data Not Collected — all categories)
6. Answer Export Compliance (No standard encryption / uses HTTPS only)
7. Paste Review Notes + demo instructions
8. Submit for Review

See `METADATA.md` for the exact answers to each App Store Connect form question.
