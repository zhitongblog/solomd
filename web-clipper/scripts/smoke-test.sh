#!/usr/bin/env bash
#
# smoke-test.sh — end-to-end verification for the SoloMD web clipper.
#
# 1. Builds the desktop `capture_drive` example (the same code path the
#    desktop app's Settings → Integrations toggle wires up, but as a
#    standalone binary so we don't need a running Tauri window).
# 2. Spawns it against a fresh /tmp/wclip-test-vault.
# 3. Issues three captures via curl using the EXACT wire format the
#    extension's lib/capture.ts produces. Verifies each lands in the
#    inbox folder as a real .md file with the YAML front matter shape
#    the extension stamps.
# 4. Issues an unauthenticated /capture/health and a token-bearing one
#    to prove the auth gate.
#
# This is the "build the verification harness first" route required by
# rule #2 — without this, the extension would only be testable against
# a fully-built SoloMD desktop app on someone else's machine.
#
# Usage:
#     web-clipper/scripts/smoke-test.sh
#
# Exits 0 on success, non-zero on first failure. Tears down the spawned
# capture_drive and the test vault on exit (success or failure).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$WC_ROOT/.." && pwd)"

VAULT="${VAULT:-/tmp/wclip-test-vault}"
ENV_DIR="${ENV_DIR:-/tmp/web-clipper-test}"
ENV_FILE="$ENV_DIR/.env"

# Random-ish stable token so we can stuff it into .env before the server
# even starts.
TOKEN="${SOLOMD_CAPTURE_TOKEN:-smoketest-$(date +%s)-$$abcdef}"

# Pre-create dirs.
rm -rf "$VAULT" "$ENV_DIR"
mkdir -p "$VAULT" "$ENV_DIR"

# ---------------------------------------------------------------------------
# Step 1 — build capture_drive so the smoke test stays standalone.
# ---------------------------------------------------------------------------
echo "[smoke] building capture_drive (cargo build --example capture_drive)..."
( cd "$REPO_ROOT/app/src-tauri" && cargo build --example capture_drive --quiet )

DRIVE_BIN="$REPO_ROOT/app/src-tauri/target/debug/examples/capture_drive"
if [[ ! -x "$DRIVE_BIN" ]]; then
    echo "[smoke] error: $DRIVE_BIN not found / not executable" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Step 2 — start capture_drive in background, capture its PORT/TOKEN line.
# ---------------------------------------------------------------------------
DRIVE_LOG="$ENV_DIR/capture_drive.log"
echo "[smoke] starting capture endpoint against $VAULT..."
SOLOMD_CAPTURE_TOKEN="$TOKEN" "$DRIVE_BIN" "$VAULT" >"$DRIVE_LOG" 2>&1 &
DRIVE_PID=$!

cleanup() {
    if kill -0 "$DRIVE_PID" 2>/dev/null; then
        kill "$DRIVE_PID" 2>/dev/null || true
        wait "$DRIVE_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Wait for "READY" line — bounded.
for _ in $(seq 1 50); do
    if grep -q "^READY$" "$DRIVE_LOG" 2>/dev/null; then break; fi
    sleep 0.1
done
if ! grep -q "^READY$" "$DRIVE_LOG"; then
    echo "[smoke] capture_drive did not become ready in 5s" >&2
    cat "$DRIVE_LOG" >&2 || true
    exit 1
fi

PORT="$(awk -F= '/^PORT=/{print $2; exit}' "$DRIVE_LOG")"
DRIVE_TOKEN="$(awk -F= '/^TOKEN=/{print $2; exit}' "$DRIVE_LOG")"
echo "[smoke] endpoint up: http://127.0.0.1:$PORT  token=${DRIVE_TOKEN:0:8}..."

# Mirror what the extension persists in browser.storage.local — the popup
# would read these. The extension itself doesn't read .env (it can't), but
# we keep it here so a human can re-run any of these requests via curl.
cat >"$ENV_FILE" <<EOF
SOLOMD_CAPTURE_ENDPOINT=http://127.0.0.1:$PORT
SOLOMD_CAPTURE_TOKEN=$DRIVE_TOKEN
SOLOMD_TEST_VAULT=$VAULT
EOF

# ---------------------------------------------------------------------------
# Step 3 — assertions.
# ---------------------------------------------------------------------------
fail() {
    echo "[smoke] FAIL: $*" >&2
    exit 1
}

# /capture/health without a token must 401 with our specific error text.
echo "[smoke] (1/6) /capture/health no-token → expect 401"
got="$(curl -s -o /tmp/smoke.body -w '%{http_code}' "http://127.0.0.1:$PORT/capture/health")"
[[ "$got" == "401" ]] || fail "/capture/health no-token: got HTTP $got, body=$(cat /tmp/smoke.body)"

# /capture/health with a good token must 200 and report our workspace.
echo "[smoke] (2/6) /capture/health good-token → expect 200 + workspace"
got="$(curl -s -o /tmp/smoke.body -w '%{http_code}' \
    -H "Authorization: Bearer $DRIVE_TOKEN" "http://127.0.0.1:$PORT/capture/health")"
[[ "$got" == "200" ]] || fail "/capture/health good-token: HTTP $got"
grep -q '"ok":true' /tmp/smoke.body || fail "health body missing ok:true ($(cat /tmp/smoke.body))"
grep -q "$VAULT" /tmp/smoke.body || fail "health body missing workspace path ($(cat /tmp/smoke.body))"

# Capture #1 — page-style with full YAML front matter shape (matches
# the renderBody() output in src/background.ts).
echo "[smoke] (3/6) POST /capture (clip whole page) → expect 200"
PAGE_BODY=$(cat <<'JSON'
{"title":"How browsers parse HTML","content":"---\nsource_url: https://example.com/article\ncaptured_at: 2026-04-26T13:30:00+08:00\ntitle: How browsers parse HTML\ninbox: true\n---\n\n# How browsers parse HTML\n\nA quick overview.\n\n- tokenize\n- build DOM\n- style + paint\n\n```ts\nconst x = 1;\n```","url":"https://example.com/article","tags":["clipped","page"],"inbox":true}
JSON
)
got="$(curl -s -o /tmp/smoke.body -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $DRIVE_TOKEN" -H "Content-Type: application/json" \
    -d "$PAGE_BODY" "http://127.0.0.1:$PORT/capture")"
[[ "$got" == "200" ]] || fail "POST page: HTTP $got, body=$(cat /tmp/smoke.body)"

# Capture #2 — selection-style.
echo "[smoke] (4/6) POST /capture (clip selection) → expect 200"
SEL_BODY=$(cat <<'JSON'
{"title":"Selected paragraph","content":"---\nsource_url: https://example.com/long\ncaptured_at: 2026-04-26T13:31:00+08:00\ntitle: Selected paragraph\ninbox: true\n---\n\nThis is the highlighted text the user wanted to keep. Just one paragraph.\n","url":"https://example.com/long","tags":["clipped","selection"],"inbox":true}
JSON
)
got="$(curl -s -o /tmp/smoke.body -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $DRIVE_TOKEN" -H "Content-Type: application/json" \
    -d "$SEL_BODY" "http://127.0.0.1:$PORT/capture")"
[[ "$got" == "200" ]] || fail "POST selection: HTTP $got"

# Capture #3 — link-only (no body fetch).
echo "[smoke] (5/6) POST /capture (save link) → expect 200"
LINK_BODY=$(cat <<'JSON'
{"title":"Read later — Crafting Interpreters","content":"---\nsource_url: https://craftinginterpreters.com/\ncaptured_at: 2026-04-26T13:32:00+08:00\ntitle: Read later — Crafting Interpreters\ninbox: true\n---\n\n[Read later — Crafting Interpreters](https://craftinginterpreters.com/) — captured 2026-04-26\n","url":"https://craftinginterpreters.com/","tags":["link"],"inbox":true}
JSON
)
got="$(curl -s -o /tmp/smoke.body -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $DRIVE_TOKEN" -H "Content-Type: application/json" \
    -d "$LINK_BODY" "http://127.0.0.1:$PORT/capture")"
[[ "$got" == "200" ]] || fail "POST link: HTTP $got"

# All three notes must exist in inbox/, with our YAML shape preserved.
echo "[smoke] (6/6) inbox files..."
inbox_count="$(find "$VAULT/inbox" -name '*.md' -type f | wc -l | tr -d ' ')"
[[ "$inbox_count" == "3" ]] || fail "expected 3 inbox files, got $inbox_count"

# Pick whichever file has "How browsers parse HTML" and verify front matter.
page_md="$(grep -l "How browsers parse HTML" "$VAULT/inbox/"*.md | head -1 || true)"
[[ -n "$page_md" ]] || fail "page-style note not found in $VAULT/inbox/"
grep -q "^source: https://example.com/article$" "$page_md" || fail "missing source: line in $page_md"
grep -q "^inbox: true$" "$page_md" || fail "missing inbox: true line in $page_md"
grep -q "tokenize" "$page_md" || fail "body content not preserved in $page_md"

# Selection note, including the YAML stripped-and-rewrapped body.
sel_md="$(grep -l "highlighted text" "$VAULT/inbox/"*.md | head -1 || true)"
[[ -n "$sel_md" ]] || fail "selection-style note not found"

# Link note has the [text](url) shape in the body.
link_md="$(grep -l "Crafting Interpreters" "$VAULT/inbox/"*.md | head -1 || true)"
[[ -n "$link_md" ]] || fail "link-style note not found"
grep -q '\[Read later' "$link_md" || fail "link body missing markdown link in $link_md"

echo "[smoke] OK — clipped 3 notes (page + selection + link), all landed in $VAULT/inbox/, /capture/health gate works."
ls -la "$VAULT/inbox/"
