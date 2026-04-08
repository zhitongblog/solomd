#!/usr/bin/env bash
#
# Cut a new release: bumps version in tauri.conf.json + package.json,
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

git add app/src-tauri/tauri.conf.json app/package.json app/src-tauri/Cargo.toml
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
