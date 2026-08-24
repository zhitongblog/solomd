#!/usr/bin/env bash
#
# Sync a GitHub release to Gitee (binaries + body), run from your Mac.
#
# Why this is a local script and not a GitHub Action:
#   The .github/workflows/gitee-release.yml we tried first hung
#   indefinitely on the upload step — Gitee's API throttles
#   github.com runner IPs hard (one ~30 MB file per ~30 min). From
#   a residential / China-friendly egress, the same uploads take
#   1–10s per file. So the pragmatic split is:
#     - GitHub: builds + hosts the canonical release
#     - Local Mac: pushes a copy to Gitee for CN download speed
#
# Usage:
#   ./scripts/release-to-gitee.sh v3.6.2
#
# Requires:
#   - `gh` CLI authenticated to the GitHub repo
#   - `GITEE_TOKEN` env var (or in .env.local) — Gitee personal
#     access token with `releases` scope
#   - `GITEE_USER` env var (default: zhitong45)
#   - jq, curl, python3

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <tag> (e.g. $0 v3.6.2)" >&2
  exit 1
fi
TAG="$1"

# Load secrets from .env.local if present.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

: "${GITEE_TOKEN:?Set GITEE_TOKEN (export or in .env.local)}"
GITEE_USER="${GITEE_USER:-zhitong45}"
REPO_GH="zhitongblog/solomd"
REPO_GITEE="$GITEE_USER/solomd"
API="https://gitee.com/api/v5/repos/$REPO_GITEE"

echo "==> Sync $TAG  ($REPO_GH → gitee.com/$REPO_GITEE)"

# Set GITEE_WORK_DIR to keep the downloads around (and resume into them on a
# later run). Without it we use a temp dir and clean up as before.
#
# Why resumability matters: `gh release download` fetches all ~24 assets in one
# shot, and through a CN proxy the run dies on the last file often enough
# (`stream error: ... PROTOCOL_ERROR`) that `set -e` would throw away 300 MB of
# perfectly good downloads along with it.
if [ -n "${GITEE_WORK_DIR:-}" ]; then
  WORK="$GITEE_WORK_DIR"
  mkdir -p "$WORK"
  echo "==> Reusing work dir $WORK (kept on exit)"
else
  WORK="$(mktemp -d -t gitee-release-XXXXX)"
  trap 'rm -rf "$WORK"' EXIT
fi
cd "$WORK"

# Download per-asset with retries, skipping any file already present at the
# exact size GitHub reports. One flaky stream then costs one file, not all 24.
echo "==> Downloading GitHub assets to $WORK"
gh release view "$TAG" --repo "$REPO_GH" --json assets \
  -q '.assets[] | "\(.size)\t\(.name)"' > .manifest
MISSING=0
while IFS=$'\t' read -r want name; do
  if [ -f "$name" ] && [ "$(stat -f%z "$name" 2>/dev/null || stat -c%s "$name")" = "$want" ]; then
    continue
  fi
  ok=0
  for try in 1 2 3; do
    printf "  ↓ %-45s attempt %d ... " "$name" "$try"
    if gh release download "$TAG" --repo "$REPO_GH" --pattern "$name" --clobber >/dev/null 2>&1 \
      && [ "$(stat -f%z "$name" 2>/dev/null || stat -c%s "$name")" = "$want" ]; then
      echo "ok"; ok=1; break
    fi
    echo "retry"
  done
  [ "$ok" = 1 ] || { echo "  ✗ could not fetch $name"; MISSING=1; }
done < .manifest
rm -f .manifest
[ "$MISSING" = 0 ] || { echo "Aborting: some assets could not be downloaded." >&2; exit 1; }
ls -la

# 1. Resolve GitHub release metadata (name + body).
META=$(gh release view "$TAG" --repo "$REPO_GH" --json name,body)
NAME=$(echo "$META" | jq -r '.name')
BODY=$(echo "$META" | jq -r '.body // ""')

# 2. Reuse a Gitee release at this tag if one already exists.
#    We used to delete + recreate here, which made a mid-upload failure
#    catastrophic: the CN egress drops a connection every few assets
#    (`curl: (56) Recv failure`), and the next run would throw away every
#    asset that HAD made it and start from zero. Reusing the release lets
#    step 4 skip what's already up there, so each run is strictly forward
#    progress. Only the body is refreshed, in case the GitHub notes changed.
EXISTING_ID=$(curl -fsS "$API/releases/tags/$TAG?access_token=$GITEE_TOKEN" \
  | jq -r '.id // empty' || true)

# 3. Create the Gitee release. The mirror workflow already pushed the
#    tag, so target_commitish is just `main` for safety (Gitee resolves
#    to the existing tag commit).
if [ -n "$EXISTING_ID" ]; then
  echo "==> Reusing Gitee release id=$EXISTING_ID (resuming)"
  ID="$EXISTING_ID"
else
echo "==> Creating Gitee release"
RESP=$(jq -nR \
  --arg tag "$TAG" \
  --arg name "$NAME" \
  --arg body "$BODY" \
  --arg ref "main" \
  '{tag_name: $tag, name: $name, body: $body, target_commitish: $ref, prerelease: false}' \
| curl -fsS -X POST \
    -H "Content-Type: application/json" \
    -d @- \
    "$API/releases?access_token=$GITEE_TOKEN")
ID=$(echo "$RESP" | jq -r '.id // empty')
if [ -z "$ID" ]; then
  echo "Failed to create Gitee release:"
  echo "$RESP" | jq .
  exit 1
fi
echo "  release id=$ID"
fi

# 4. Upload every asset. Sequential by design — Gitee's API accepts
#    concurrent uploads but the per-IP rate is the bottleneck on shared
#    egress, and the time cost is dominated by the largest file (the
#    AppImage at ~90 MB ≈ 45s). Total time ~3 min for 17 assets.
echo "==> Uploading assets to release $ID"

# Names already attached to the release. Re-read once up front so a resumed
# run knows what to skip; refreshed after each upload so we can confirm an
# asset really landed. `gh`-style exit codes lie here — curl reports success
# for a truncated POST often enough that the asset list is the only honest
# check.
uploaded_names() {
  curl -fsS --max-time 120 "$API/releases/$ID?access_token=$GITEE_TOKEN" \
    | jq -r '.assets[]? | .name // empty' || true
}
HAVE="$(uploaded_names)"
FAILED=0

for f in *; do
  SIZE=$(du -h "$f" | cut -f1)
  if printf '%s\n' "$HAVE" | grep -Fxq "$f"; then
    printf "  = %-45s %6s ... already on Gitee\n" "$f" "$SIZE"
    continue
  fi
  ok=0
  for try in 1 2 3 4 5; do
    printf "  ↑ %-45s %6s attempt %d ... " "$f" "$SIZE" "$try"
    # `|| true`: a dropped connection makes curl exit non-zero, and under
    # `set -e` that would kill the whole mirror over one flaky asset.
    HTTP=$(curl -sS -X POST --max-time 900 \
      -F "file=@$f" \
      "$API/releases/$ID/attach_files?access_token=$GITEE_TOKEN" \
      -o /dev/null \
      -w "%{http_code}" || true)
    HAVE="$(uploaded_names)"
    if printf '%s\n' "$HAVE" | grep -Fxq "$f"; then
      echo "ok (HTTP ${HTTP:-?})"; ok=1; break
    fi
    echo "retry (HTTP ${HTTP:-network})"
    # HTTP 400 from Gitee means the 1 GB per-repo attachment quota is full;
    # retrying cannot help, so surface it immediately instead of burning
    # four more attempts. Prune an old release and re-run.
    if [ "${HTTP:-}" = "400" ]; then
      echo "    ⚠ HTTP 400 — likely the 1 GB attachment quota. Prune an old release and re-run."
      break
    fi
    sleep 3
  done
  [ "$ok" = 1 ] || { echo "    ✗ gave up on $f"; FAILED=1; }
done

# 5. Verify final state.
echo
echo "==> Done"
COUNT=$(curl -fsS "$API/releases/$ID?access_token=$GITEE_TOKEN" | jq '.assets | length')
echo "  $COUNT assets on https://gitee.com/$REPO_GITEE/releases/tag/$TAG"
if [ "$FAILED" = 1 ]; then
  echo "  ⚠ some assets did not upload — re-run this script to resume (it skips what's already there)." >&2
  exit 1
fi
