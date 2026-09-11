#!/usr/bin/env bash
#
# Upload local release assets to a (usually still-draft) GitHub release, with a
# watchdog around each attempt.
#
# Why this exists rather than a plain `gh release upload`:
#
#   On this machine every byte leaves through a local proxy, and large files —
#   the 60 MB universal APK, the 37 MB AAB, the 26 MB dmg — sometimes stall it
#   completely. The socket stays ESTABLISHED, nothing moves, and gh's own
#   timeout is long enough that it effectively never returns. A `cmd || retry`
#   loop cannot help: gh never exits, so the loop never advances. One file once
#   sat like that for half an hour with zero retries logged.
#
#   So: run the upload in the background, poll it, and kill it if it goes quiet
#   past the deadline. A fresh invocation almost always walks straight through —
#   the stall is a one-off connection, not a broken file.
#
# And why success is judged the way it is:
#
#   gh's exit code lies in both directions here, so the only thing trusted is
#   the release's own asset list, compared by NAME AND BYTE SIZE. Name alone is
#   not enough — a killed upload can leave a short asset behind, and --clobber
#   then makes the retry look like a no-op.
#
#   A draft release answers `repos/{repo}/releases/tags/{tag}` with 404: drafts
#   are only reachable through the releases list. Resolving the id by tag first
#   is what makes this work before publication, which is exactly when it runs.
#
# Usage: scripts/upload-release-assets.sh <tag> <file> [file ...]

set -euo pipefail

TAG="${1:-}"
shift || true
if [ -z "$TAG" ] || [ $# -eq 0 ]; then
  echo "usage: $0 <tag> <file> [file ...]" >&2
  exit 2
fi

REPO="${GH_REPO:-zhitongblog/solomd}"
DEADLINE="${UPLOAD_DEADLINE:-240}"   # seconds per attempt
TRIES="${UPLOAD_TRIES:-6}"

release_id() {
  gh api --paginate "repos/$REPO/releases" \
    --jq ".[] | select(.tag_name == \"$TAG\") | .id" 2>/dev/null | head -1
}

RID="$(release_id)"
if [ -z "$RID" ]; then
  echo "error: no release for tag $TAG in $REPO (draft or published)" >&2
  exit 1
fi
echo "release id $RID for $TAG"

remote_size() {
  gh api "repos/$REPO/releases/$RID/assets" --paginate \
    --jq ".[] | select(.name == \"$1\") | .size" 2>/dev/null | head -1
}

failed=0
for f in "$@"; do
  [ -f "$f" ] || { echo "MISSING  $f"; failed=1; continue; }
  name="$(basename "$f")"
  want="$(wc -c < "$f" | tr -d ' ')"

  have="$(remote_size "$name" || true)"
  if [ "$have" = "$want" ]; then
    echo "skip     $name (already there, $want bytes)"
    continue
  fi

  ok=0
  for try in $(seq 1 "$TRIES"); do
    gh release upload "$TAG" "$f" --repo "$REPO" --clobber >/dev/null 2>&1 &
    pid=$!
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$DEADLINE" ]; do
      sleep 5
      waited=$((waited + 5))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
      echo "         $name try $try: stalled at ${waited}s, killed"
    fi
    wait "$pid" 2>/dev/null || true

    # The asset list occasionally answers stale right after a write; ask twice
    # before believing an upload failed.
    have="$(remote_size "$name" || true)"
    [ "$have" = "$want" ] || { sleep 5; have="$(remote_size "$name" || true)"; }
    if [ "$have" = "$want" ]; then
      echo "ok       $name ($want bytes, try $try)"
      ok=1
      break
    fi
    echo "         $name try $try: remote size ${have:-none} != $want"
  done
  [ "$ok" = 1 ] || { echo "FAILED   $name after $TRIES tries"; failed=1; }
done

exit "$failed"
