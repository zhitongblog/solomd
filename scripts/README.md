# Release scripts

## TL;DR

```bash
# 1. Cut a release (bumps version, tags, pushes — triggers CI)
./scripts/release.sh 0.2.0

# 2. (Optional) Build a signed mac .dmg locally for testing
#    Credentials come from .env.local — see "Apple credentials" below.
./scripts/build-mac.sh

# 3. Upload a build to App Store Connect
./scripts/submit-mas.sh          # newest dist-mas/*.pkg
./scripts/submit-ios.sh          # gen/apple/build/arm64/SoloMD.ipa

# 4. Submit an uploaded build for review (needs an API key)
./scripts/submit-for-review.sh --platform ios --version 4.12.0 --notes-file notes.txt
```

## Apple credentials

Two ways to authenticate. The scripts pick the API key whenever it is
configured and fall back to the Apple ID pair otherwise; the logic lives in
`scripts/lib/asc-auth.sh` and is shared by `build-mac.sh`, `submit-mas.sh` and
`submit-ios.sh`.

**App Store Connect API key — preferred.** It belongs to the team rather than
to a person, is not tied to anyone's 2FA, and survives a password change, so
uploads and notarization run unattended.

1. App Store Connect → **Users and Access → Integrations → App Store Connect API**
2. Generate a key with the **App Manager** role; download the `.p8` — Apple
   serves it exactly once
3. Put it somewhere durable and add to `.env.local`:

```bash
ASC_KEY_ID="ABCD1234EF"                                   # the key's ID
ASC_ISSUER_ID="11111111-2222-3333-4444-555555555555"      # shown above the key list
ASC_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_ABCD1234EF.p8"
```

`ASC_KEY_PATH` is optional if the file already sits in one of the four
directories `altool` searches (`./private_keys`, `~/private_keys`,
`~/.private_keys`, `~/.appstoreconnect/private_keys`). When it lives anywhere
else the helper symlinks it into the last of those, because `altool` takes no
path argument — it only finds keys by filename. A symlink, not a copy: the key
stays in one place on disk.

**Apple ID + app-specific password — fallback.** Still works, still needs
`APPLE_TEAM_ID`:

```bash
APPLE_ID="you@example.com"
APPLE_PASSWORD="abcd-efgh-ijkl-mnop"    # app-specific, not the account password
APPLE_TEAM_ID="6NQM3XP5RF"
```

## What each script does

### `release.sh <version>`
- Bumps version in `tauri.conf.json`, `package.json`, `Cargo.toml`
- Commits the bump
- Tags `vX.Y.Z`
- Pushes both the commit and the tag to `origin/main`
- The pushed tag triggers `.github/workflows/release.yml`, which builds three platforms in parallel and creates a draft GitHub Release

### `build-mac.sh`
- Local-only macOS build with Developer ID signing + notarization
- Useful for testing the signing pipeline without going through CI
- Needs `APPLE_SIGNING_IDENTITY` plus one of the credential sets above

### `build-ios.sh`
Local iOS App Store build. Needs `IOS_SIGNING_PROFILE_NAME` and
`APPLE_TEAM_ID`, and a distribution profile at
`app/src-tauri/SoloMD-iOS.provisionprofile`.

The Xcode project under `app/src-tauri/gen/apple/` is generated and gitignored,
but it is not the whole truth. Signing, the `.md` file associations, the #139
open-in-place fix, the extra link flags and the PATH the Rust build phase needs
are all ours, and they live in **`app/src-tauri/ios-project-overlay.yml`**,
re-applied on every build by `scripts/lib/ios_project_overlay.py`.

**Edit the overlay, never `gen/apple/project.yml`** — the latter is
overwritten. If you need something that is not in the overlay yet, generate a
clean project (`mv gen/apple/project.yml /tmp && pnpm tauri ios init`), diff it
against the patched one, and add the difference to the overlay.

`tauri ios init` writes `project.yml` **only when it is absent**, so changing
`bundle.iOS.minimumSystemVersion` in `tauri.conf.json` does nothing to an
existing project on its own; `build-ios.sh` reads the value out of the config
and applies it.

### `submit-mas.sh` / `submit-ios.sh`
- Validate, then upload a built `.pkg` / `.ipa` to App Store Connect
- Authenticate via the API key when configured, Apple ID otherwise
- These **upload**; they do not submit anything for review

### `submit-for-review.sh`
Takes an uploaded build the rest of the way: waits for Apple to finish
processing it, creates the version if it does not exist, writes the release
notes, attaches the build, and submits.

```bash
./scripts/submit-for-review.sh --platform ios   --version 4.12.0 --notes-file notes.txt
./scripts/submit-for-review.sh --platform macos --version 4.12.0 --dry-run
```

| Flag | Meaning |
|---|---|
| `--platform` | `ios` or `macos` |
| `--version` | marketing version, e.g. `4.12.0` |
| `--build` | `CFBundleVersion` of the upload, if it differs from `--version` |
| `--notes-file` | release notes, applied to every locale on the version |
| `--wait-build` | seconds to wait for processing (default 1800) |
| `--release-type` | `AFTER_APPROVAL` (default) or `MANUAL`; only applies to a version this run creates |
| `--uses-non-exempt-encryption` | answer export compliance with yes instead of the default no |
| `--dry-run` | read real state, print every write instead of making it |
| `--yes` | skip the confirmation prompt |

**API key only.** An Apple ID and app-specific password can upload but cannot
reach the submission API, so this script has no fallback and says so.

It stops rather than guessing when the version is already `WAITING_FOR_REVIEW`,
`IN_REVIEW`, `PENDING_DEVELOPER_RELEASE` or `READY_FOR_SALE`, and it refuses to
attach a build Apple reports as `FAILED`/`INVALID`.

If the build arrives with export compliance unanswered — "Missing Export
Compliance" in the web UI, which review will not accept — the script answers it
before attaching. `app/src-tauri/Info.plist` declares
`ITSAppUsesNonExemptEncryption` so new builds no longer arrive that way, but a
build uploaded before that landed still needs the answer.

Re-running is safe. Every write is either idempotent or finds what already
exists: an existing version is reused rather than recreated, and an open
`READY_FOR_REVIEW` submission is added to rather than duplicated. That is why
reads are retried on a dropped connection and writes are not.

### `upload-release-assets.sh <tag> <file> [...]`

Uploads the locally-built assets (dmg, APKs, AAB, skill pack) to a release —
normally while it is still a draft — with a watchdog around every attempt.

Plain `gh release upload` is not enough here. Everything leaves this machine
through a local proxy, and large files sometimes stall it outright: the socket
stays open, no bytes move, and gh's own timeout is long enough that it never
returns. A `cmd || retry` loop cannot rescue that — gh never exits, so the loop
never advances. One upload once sat like that for half an hour having logged
zero retries. Each attempt therefore runs in the background and is killed if it
goes quiet past the deadline; a fresh invocation almost always walks straight
through, because the stall is a one-off connection rather than a broken file.

Success is judged by the release's own asset list, **by name and byte size** —
never by gh's exit code, which lies in both directions here. Size matters
because a killed upload can leave a short asset behind, and `--clobber` then
makes the retry look like a no-op. Already-complete assets are skipped, so
re-running after a partial run costs nothing.

Draft-aware: a draft answers `releases/tags/{tag}` with 404 and is only
reachable through the releases list, so the id is resolved by tag first. That is
the whole point — the run that needs this happens before publication.

`UPLOAD_DEADLINE` (default 240s) and `UPLOAD_TRIES` (default 6) are tunable.

### `fix-appimage-diricon.sh <file.AppImage> [...]`

Repairs the dangling `.DirIcon` symlink tauri-bundler bakes into every
AppImage it builds (#291). The bundler writes it as an absolute path into the
directory the build happened to run in —

```
.DirIcon -> /home/runner/work/solomd/solomd/app/src-tauri/target/release/bundle/appimage/SoloMD.AppDir/SoloMD.png
```

— which exists on no user's machine. Launching the AppImage never resolves it,
so this shipped unnoticed for a long time, but installers that unpack the
AppDir (AppManager, Gear Lever) reject the package: *Symlink target not found*.
The sibling `SoloMD.png` link right next to it is relative and correct.

A squashfs is immutable, so the image is rebuilt: the original ELF runtime
bytes are kept verbatim, the AppDir is re-packed with the same compressor and
block size read back off the image, and the two are concatenated — what
`appimagetool` does for a type-2 image, minus the FUSE dependency, which is why
this also runs (and can be tested) on macOS. The rebuild is verified before it
replaces anything: same runtime length, same entry count, `.DirIcon` relative
and resolving.

Idempotent — an image whose `.DirIcon` is already relative is reported and left
alone, so it turns into a no-op the day tauri-bundler fixes this upstream.

Wired into both Linux CI workflows; run it by hand only for a locally built
bundle.

## Required GitHub Actions secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** for each:

| Secret | Value | Where to get it |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: xiangdong li (6NQM3XP5RF)` | `security find-identity -v -p codesigning` |
| `APPLE_CERTIFICATE` | base64 of a `.p12` export | See "exporting the cert" below |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting | (you choose it) |
| `APPLE_ID` | your Apple ID email | — |
| `APPLE_PASSWORD` | app-specific password | https://account.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | `6NQM3XP5RF` | Apple Developer portal → Membership |

### Exporting the certificate as `.p12`

1. Open **Keychain Access**
2. Find **"Developer ID Application: xiangdong li (6NQM3XP5RF)"** in the **login** keychain
3. Right-click → **Export** → format `.p12` → set a strong password
4. Save as e.g. `developer-id.p12`
5. Encode it for GitHub:
   ```bash
   base64 -i developer-id.p12 | pbcopy
   ```
6. Paste into the `APPLE_CERTIFICATE` secret in GitHub
7. Put the password you chose into `APPLE_CERTIFICATE_PASSWORD`

## CI behavior

- **Tag push (`v*`)**: full release build, creates draft GitHub Release
- **Manual trigger** (`workflow_dispatch`): same as tag push but with the current branch
- **Without Apple secrets**: macOS build still runs but produces an unsigned `.dmg` (users will need to right-click → Open to bypass Gatekeeper)
- **Builds run in parallel** on macOS, Ubuntu, and Windows runners — total wall time usually 15-25 minutes for first run, 5-10 minutes after caching kicks in
