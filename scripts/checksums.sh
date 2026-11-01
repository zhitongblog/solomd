#!/usr/bin/env bash
# Regenerate SHA256SUMS.txt for a SoloMD release and upload it to that release.
#
# Why this exists: the Windows builds are unsigned, so Chrome and SmartScreen
# treat every new version as an unknown binary. A published checksum manifest
# gives users a way to verify the download themselves in the meantime.
#
# CI runs this at the end of .github/workflows/release.yml, but the macOS .dmg
# and the Android .apk are uploaded by hand afterwards. Re-run it locally once
# those land so the manifest covers every asset:
#
#   ./scripts/checksums.sh v4.11.20
#
# Requires: gh, authenticated. Works against draft releases.
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <tag>    e.g. $0 v4.11.20" >&2
  exit 1
fi

# sha256sum on Linux and the Windows runners, shasum on macOS.
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$@"; }
else
  sha() { shasum -a 256 "$@"; }
fi

ASSETS="$(mktemp -d)"
OUTDIR="$(mktemp -d)"
OUT="$OUTDIR/SHA256SUMS.txt"
trap 'rm -rf "$ASSETS" "$OUTDIR"' EXIT

echo "Collecting SHA256 digests for $TAG ..."
# Prefer GitHub's native asset `.digest` (`sha256:<hex>`) when all non-manifest
# assets report one (instant, avoids downloading ~300 MB over flaky connections);
# fall back to downloading any asset whose digest is not yet populated.
JSON="$(gh release view "$TAG" --json assets)"
MISSING="$(printf '%s' "$JSON" | jq -r '.assets[] | select(.name != "SHA256SUMS.txt") | select((.digest // "") | startswith("sha256:") | not) | .name')"

if [[ -z "$MISSING" ]]; then
  printf '%s' "$JSON" \
    | jq -r '.assets[] | select(.name != "SHA256SUMS.txt") | "\(.digest | sub("^sha256:"; ""))  \(.name)"' \
    | LC_ALL=C sort -k2 > "$OUT"
else
  echo "Downloading assets for $TAG ..."
  gh release download "$TAG" --dir "$ASSETS" --clobber
  # Never hash a previous run's manifest into the new one.
  rm -f "$ASSETS/SHA256SUMS.txt"

  if [[ -z "$(ls -A "$ASSETS")" ]]; then
    echo "No assets found on $TAG" >&2
    exit 1
  fi

  # Sorted by filename so the manifest diffs cleanly from release to release.
  # Written outside $ASSETS so the manifest can't hash itself.
  (
    cd "$ASSETS"
    for f in *; do
      printf '%s\n' "$f"
    done | LC_ALL=C sort | while IFS= read -r f; do
      sha "$f"
    done
  ) > "$OUT"
fi

if [[ ! -s "$OUT" ]]; then
  echo "No assets found on $TAG" >&2
  exit 1
fi

echo "--- SHA256SUMS.txt ---"
cat "$OUT"
echo "----------------------"

gh release upload "$TAG" "$OUT" --clobber
echo "Uploaded SHA256SUMS.txt to $TAG"
