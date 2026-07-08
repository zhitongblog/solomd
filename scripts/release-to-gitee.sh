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

WORK="$(mktemp -d -t gitee-release-XXXXX)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "==> Downloading GitHub assets to $WORK"
gh release download "$TAG" --repo "$REPO_GH" --clobber
ls -la

# 1. Resolve GitHub release metadata (name + body).
META=$(gh release view "$TAG" --repo "$REPO_GH" --json name,body)
NAME=$(echo "$META" | jq -r '.name')
BODY=$(echo "$META" | jq -r '.body // ""')

# 2. If a Gitee release at this tag already exists, delete it. The API
#    has no atomic upsert; deleting + creating is the simplest path.
EXISTING_ID=$(curl -fsS "$API/releases/tags/$TAG?access_token=$GITEE_TOKEN" \
  | jq -r '.id // empty' || true)
if [ -n "$EXISTING_ID" ]; then
  echo "==> Deleting existing Gitee release id=$EXISTING_ID"
  curl -fsS -X DELETE "$API/releases/$EXISTING_ID?access_token=$GITEE_TOKEN" \
    -o /dev/null -w "  HTTP %{http_code}\n"
fi

# 3. Create the Gitee release. The mirror workflow already pushed the
#    tag, so target_commitish is just `main` for safety (Gitee resolves
#    to the existing tag commit).
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

# 4. Upload every asset. Sequential by design — Gitee's API accepts
#    concurrent uploads but the per-IP rate is the bottleneck on shared
#    egress, and the time cost is dominated by the largest file (the
#    AppImage at ~90 MB ≈ 45s). Total time ~3 min for 17 assets.
echo "==> Uploading assets to release $ID"
for f in *; do
  SIZE=$(du -h "$f" | cut -f1)
  printf "  ↑ %-45s %6s ... " "$f" "$SIZE"
  HTTP=$(curl -sS -X POST --max-time 900 --retry 3 --retry-delay 2 \
    -F "file=@$f" \
    "$API/releases/$ID/attach_files?access_token=$GITEE_TOKEN" \
    -o /dev/null \
    -w "%{http_code}")
  echo "HTTP $HTTP"
  if [ "$HTTP" != "201" ]; then
    echo "    ⚠ upload returned $HTTP — continuing"
  fi
done

# 5. Verify final state.
echo
echo "==> Done"
COUNT=$(curl -fsS "$API/releases/$ID?access_token=$GITEE_TOKEN" | jq '.assets | length')
echo "  $COUNT assets on https://gitee.com/$REPO_GITEE/releases/tag/$TAG"
