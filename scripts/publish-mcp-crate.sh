#!/usr/bin/env bash
# Publish the solomd-mcp crate to crates.io.
#
# Requires CARGO_REGISTRY_TOKEN in the environment (from
# https://crates.io/me — "API Tokens" tab) or a prior `cargo login`.
#
# Idempotent for the same version (crates.io rejects republish of an
# existing version; bump mcp-server/Cargo.toml first).
#
# Usage:
#   ./scripts/publish-mcp-crate.sh              # dry-run + interactive confirm
#   ./scripts/publish-mcp-crate.sh --yes        # non-interactive
#   ./scripts/publish-mcp-crate.sh --dry-run    # dry-run only
set -euo pipefail
cd "$(dirname "$0")/../mcp-server"

CRATE=$(grep '^name\s*=' Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')
VERSION=$(grep '^version\s*=' Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')

echo "Crate: $CRATE"
echo "Version: $VERSION"
echo ""

# Verify the README the package will ship.
if [ ! -f README.md ]; then
  echo "Missing mcp-server/README.md — Cargo.toml references it." >&2
  exit 1
fi

# Check if this version is already published.
if curl -s -H "User-Agent: solomd-publish" \
    "https://crates.io/api/v1/crates/$CRATE/$VERSION" \
    | grep -q '"version":'; then
  echo "ERROR: $CRATE@$VERSION already published on crates.io." >&2
  echo "Bump mcp-server/Cargo.toml's [package].version first." >&2
  exit 2
fi

case "${1:-}" in
  --dry-run)
    echo "--- cargo publish --dry-run ---"
    cargo publish --dry-run --allow-dirty
    echo ""
    echo "Dry-run completed. To actually publish:"
    echo "  ./scripts/publish-mcp-crate.sh --yes"
    exit 0
    ;;
  --yes)
    CONFIRMED=1
    ;;
  "")
    echo "--- cargo publish --dry-run (package the tarball, check no warnings) ---"
    cargo publish --dry-run --allow-dirty
    echo ""
    read -rp "Proceed with real publish to crates.io? [y/N] " ans
    case "$ans" in
      [Yy]*) CONFIRMED=1 ;;
      *) echo "Aborted."; exit 0 ;;
    esac
    ;;
  *)
    echo "Usage: $0 [--dry-run|--yes]" >&2
    exit 1
    ;;
esac

echo ""
echo "--- cargo publish ---"
cargo publish --allow-dirty

cat <<EOF

Published: https://crates.io/crates/$CRATE/$VERSION

Now \`cargo install solomd-mcp\` works for users on any platform.

Suggested follow-ups:
  1. Tag the crate version in git:
       git tag -a solomd-mcp-v$VERSION -m "Publish solomd-mcp $VERSION"
       git push origin solomd-mcp-v$VERSION
  2. Update root README badges to reference the crates.io link.
  3. Wait ~5 min for crates.io to propagate, then verify in a clean Rust env:
       cargo install solomd-mcp --version $VERSION
EOF
