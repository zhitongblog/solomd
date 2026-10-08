#!/usr/bin/env bash
#
# Cut a new release: bumps version in tauri.conf.json + package.json +
# both Cargo.toml files (app and solomd-mcp) + the CLI's fallback version,
# commits, tags, and pushes. GitHub Actions takes over from there.
#
# Usage: ./scripts/release.sh 0.2.0

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.2.0" >&2
  exit 1
fi

VERSION="$1"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "ERROR: version must be semver, e.g. 0.2.0" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree not clean. Commit or stash first." >&2
  exit 1
fi

echo "==> Bumping version to $VERSION"

# tauri.conf.json
sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" app/src-tauri/tauri.conf.json
rm app/src-tauri/tauri.conf.json.bak

# package.json
sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" app/package.json
rm app/package.json.bak

# Cargo.toml (in src-tauri)
sed -i.bak -E "s/^version = \"[^\"]+\"/version = \"$VERSION\"/" app/src-tauri/Cargo.toml
rm app/src-tauri/Cargo.toml.bak

# solomd-mcp ships inside the app, so it reports the app's version
# (`solomd-mcp --version`, MCP serverInfo). mcp-server/tests/version_sync.rs
# fails if this is forgotten.
sed -i.bak -E "s/^version = \"[^\"]+\"/version = \"$VERSION\"/" mcp-server/Cargo.toml
rm mcp-server/Cargo.toml.bak
(cd mcp-server && cargo update -p solomd-mcp --offline --quiet)

# The bash CLI's fallback version, for copies installed outside a checkout.
sed -i.bak -E "s/^SOLOMD_VERSION=\"[^\"]+\"/SOLOMD_VERSION=\"$VERSION\"/" scripts/solomd
rm scripts/solomd.bak

git add app/src-tauri/tauri.conf.json app/package.json app/src-tauri/Cargo.toml \
  mcp-server/Cargo.toml mcp-server/Cargo.lock scripts/solomd
git commit -m "chore: bump version to $VERSION"
git tag "v$VERSION"

echo ""
echo "==> Tagged v$VERSION"
echo "==> Pushing to origin (this will trigger GitHub Actions)"
git push origin main
git push origin "v$VERSION"

echo ""
echo "==> Done! Watch the build at:"
echo "    https://github.com/zhitongblog/solomd/actions"
echo ""
echo "After all 3 platforms finish (~15-20 min), open:"
echo "    https://github.com/zhitongblog/solomd/releases"
echo "and click 'Edit' → 'Publish release' on the draft."
