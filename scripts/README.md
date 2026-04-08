# Release scripts

## TL;DR

```bash
# 1. Cut a release (bumps version, tags, pushes — triggers CI)
./scripts/release.sh 0.2.0

# 2. (Optional) Build a signed mac .dmg locally for testing
APPLE_SIGNING_IDENTITY="Developer ID Application: xiangdong li (6NQM3XP5RF)" \
APPLE_ID="you@example.com" \
APPLE_PASSWORD="abcd-efgh-ijkl-mnop" \
APPLE_TEAM_ID="6NQM3XP5RF" \
./scripts/build-mac.sh
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
- Expects all `APPLE_*` env vars to be set (export, or put in `.env.local`)

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
