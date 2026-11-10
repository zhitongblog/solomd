---
trigger: always_on
description: Mandatory end-to-end SoloMD release checklist — never stop after ./scripts/release.sh
---

# SoloMD Mandatory Release Checklist

When the user asks to `release` a new version (e.g. `X.Y.Z`), **NEVER** consider the release finished after merely running `./scripts/release.sh X.Y.Z` or pushing the Git tag!

 Why:
1. `./scripts/release.sh X.Y.Z` only bumps the version and triggers GitHub Actions (`release.yml`), which builds Windows + Linux + Clipper + MCP Linux/Win and creates a **Draft** GitHub Release (`draft: true`).
2. Meanwhile, pushing `web/` with `VERSION = 'X.Y.Z'` updates `solomd.app` download links immediately via Cloudflare Pages. If the GitHub Release remains a **Draft** or lacks the locally built macOS `.dmg` and Android `.apk` assets, **all download buttons on `solomd.app` will 404**!

## Required End-to-End Steps for Every Release (`vX.Y.Z`)

1. **Commit Code Changes Only (DO NOT Update `web/` Yet!)**:
   - Commit all `app/`, `mcp-server/`, and `scripts/` changes so the working tree is clean.
   - **CRITICAL**: Do **NOT** bump `VERSION` in `web/` before Step 6! Pushing `web/` to `main` early will cause Cloudflare Pages (or any early build) to point `solomd.app` download buttons at `vX.Y.Z` before the GitHub Release and Gitee mirror assets exist.

2. **Bump Version & Push Tag**:
   - Run `./scripts/release.sh X.Y.Z` to bump `app/package.json`, `app/src-tauri/Cargo.toml`, `app/src-tauri/tauri.conf.json`, `mcp-server/Cargo.toml`, `mcp-server/mcpb/manifest.json`, and `scripts/solomd`, tag `vX.Y.Z`, and push to `origin`.

3. **Wait for GitHub Actions `Release` Workflow to Create the Release & Build Local Assets**:
   - Build the signed & notarized macOS universal DMG locally:
     ```bash
     ./scripts/build-mac.sh
     ```
     Output: `app/src-tauri/target/universal-apple-darwin/release/bundle/dmg/SoloMD_X.Y.Z_universal.dmg`
   - Build the signed Android APKs & AAB locally:
     ```bash
     ./scripts/build-android.sh
     ```
     Outputs in `dist-android/`:
     - `SoloMD_X.Y.Z_universal.apk`
     - `SoloMD_X.Y.Z_arm64-v8a.apk`
     - `SoloMD_X.Y.Z_armeabi-v7a.apk`
     - `SoloMD_X.Y.Z_x86_64.apk`
     - `SoloMD_X.Y.Z.aab`
   - Build the Skill Pack & MCPB bundle (once CI's `solomd-mcp-win-x64.zip` and `solomd-mcp-linux-x64.tar.gz` are uploaded to `vX.Y.Z`):
     ```bash
     ./scripts/build-skill-pack.sh
     ./scripts/build-mcpb.sh X.Y.Z
     ```

4. **Upload All Local Assets & Regenerate `SHA256SUMS.txt`**:
   ```bash
   ./scripts/upload-release-assets.sh vX.Y.Z \
     app/src-tauri/target/universal-apple-darwin/release/bundle/dmg/SoloMD_X.Y.Z_universal.dmg \
     dist-android/SoloMD_X.Y.Z_universal.apk \
     dist-android/SoloMD_X.Y.Z_arm64-v8a.apk \
     dist-android/SoloMD_X.Y.Z_armeabi-v7a.apk \
     dist-android/SoloMD_X.Y.Z_x86_64.apk \
     dist-android/SoloMD_X.Y.Z.aab \
     dist/solomd-skills-vX.Y.Z.zip \
     dist/solomd-mcp-X.Y.Z.mcpb
   ./scripts/checksums.sh vX.Y.Z
   ```

5. **Publish (Undraft) the GitHub Release & Verify Download Links**:
   - Update the release notes and set `--draft=false --latest`:
     ```bash
     gh release edit vX.Y.Z --draft=false --latest --title "SoloMD vX.Y.Z" --notes-file <notes.md>
     ```
   - Verify with `gh release view vX.Y.Z` that the release is **Published (Latest)** (NOT `Draft`) and that all assets (`.dmg`, `.msi`, `-portable.zip`, `.deb`, `.rpm`, `.AppImage`, `.apk`, `.aab`, `.mcpb`, `SHA256SUMS.txt`) are present.

6. **Sync to Gitee & AtomGit China Mirrors, THEN Update & Deploy Website (`web/`)**:
   - First sync all release assets to Gitee & AtomGit:
     ```bash
     ./scripts/release-to-gitee.sh vX.Y.Z
     ./scripts/release-to-atomgit.sh vX.Y.Z
     ```
   - **Only AFTER GitHub Release is Published (Latest) and Gitee/AtomGit mirrors are synced**, update `web/`:
     - Add the `vX.Y.Z` changelog entry to `web/src/data/whats-new/zh.ts` and `web/src/data/whats-new/en.ts`.
     - Bump the version string in `web/src/components/Download.astro`, `web/src/components/Hero.astro`, `web/src/components/FactPack.astro`, `web/src/layouts/Layout.astro`, `web/src/i18n/translations.ts`, and `web/src/data/whats-new/{de,es,fr}.ts`.
     - Commit `web/`, push `main`, and deploy to Cloudflare Pages:
     ```bash
     pnpm --dir web build && (cd web && npx wrangler pages deploy dist --project-name solomd --branch main)
     ```

7. **Build, Upload & Submit to Apple App Store (macOS MAS & iOS)**:
   - Prepare localized release notes in `app-store/release-notes/X.Y.Z/` (`zh-Hans.txt`, `zh-Hant.txt`, `en-US.txt`, `de-DE.txt`, `es-ES.txt`, `fr-FR.txt`, `it.txt`, `ja.txt`, `ko.txt`, `nl-NL.txt`, `pl.txt`, `pt-BR.txt`, `ru.txt`, `sv.txt`, `tr.txt`, `uk.txt`).
   - Build and upload macOS MAS `.pkg` & iOS `.ipa`:
     ```bash
     ./scripts/build-mas.sh && ./scripts/submit-mas.sh
     ./scripts/build-ios.sh && ./scripts/submit-ios.sh
     ```
   - Wait for processing and submit both platforms for review via the App Store Connect API:
     ```bash
     ./scripts/submit-for-review.sh --platform macos --version X.Y.Z --notes-dir app-store/release-notes/X.Y.Z --yes
     ./scripts/submit-for-review.sh --platform ios   --version X.Y.Z --notes-dir app-store/release-notes/X.Y.Z --yes
     ```

