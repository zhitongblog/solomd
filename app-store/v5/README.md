# App Store listing for 5.0

Description per platform (`ios.<locale>.md`, `macos.<locale>.md`) and
subtitle / keywords / promotional text (`shared.json`) for 16 locales —
the 14 we had plus **zh-Hant** and **ru**, new in 5.0.

Release order (both platforms):

1. `scripts/asc-apply-metadata.py --platform ios --version 5.0.0 --dir app-store/v5`
   (creates the version and the two new locales; `--dry-run` first)
2. `scripts/submit-for-review.sh --platform ios --version 5.0.0 --notes-dir app-store/release-notes/5.0.0`
   — the notes folder needs `zh-Hant.txt` and `ru.txt` too, or the
   submit stops on the missing What's New.
3. Same for `--platform macos`.

Subtitles are shared by iOS and macOS (app info), so step 1 writes them once
whichever platform runs first. The App Store builds send no usage data
(`IS_APP_STORE_BUILD`), which is why the privacy paragraph can say so; do
not copy it into website, Play or Microsoft Store text.
Screenshots still show 4.x — replace them in App Store Connect with 5.0 ones.
