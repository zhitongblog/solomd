#!/usr/bin/env bash
#
# v4-self-test.sh — one-shot end-to-end self-test for the v4.0 release gate.
#
# Per the v4.0 Definition-of-Done (docs/roadmap.md): all 5 pillars must be
# self-tested before tagging. This script runs every Rust integration test
# that proves a pillar works end-to-end and prints a per-pillar pass/fail
# summary.
#
# Exit 0 = every pillar green; exit 1 = at least one failed.
#
# Usage:
#   scripts/v4-self-test.sh                # run all pillars
#   scripts/v4-self-test.sh --with-ollama  # also run live-Ollama smoke test
#                                          # (requires localhost:11434 +
#                                          # qwen2.5:1.5b pulled)
#   scripts/v4-self-test.sh --with-release # also build --release for SoloMD,
#                                          # solomd-mcp, and the frontend
#                                          # (catches debug-only-cfg slips
#                                          # before macOS signing trips)
#   scripts/v4-self-test.sh --with-ui      # also drive `pnpm tauri dev`
#                                          # through the dev-bridge and verify
#                                          # all v4 UI surfaces mount.
#                                          # Requires `pnpm tauri dev` to
#                                          # already be running.
#   scripts/v4-self-test.sh --with-dmg     # also verify the signed macOS dmg
#                                          # produced by scripts/build-mac.sh
#                                          # (codesign / staple / spctl /
#                                          # universal slices / mount check).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$REPO_ROOT/app/src-tauri"
MCP="$REPO_ROOT/mcp-server"

WITH_OLLAMA=0
WITH_RELEASE=0
WITH_UI=0
WITH_DMG=0
for arg in "$@"; do
    case "$arg" in
        --with-ollama) WITH_OLLAMA=1 ;;
        --with-release) WITH_RELEASE=1 ;;
        --with-ui) WITH_UI=1 ;;
        --with-dmg) WITH_DMG=1 ;;
        -h|--help)
            sed -n '2,/^$/p' "$0" | sed 's/^# *//'
            exit 0 ;;
    esac
done

# ------------------------------------------------------------------
# Plumbing — coloured pass/fail labels, one row per pillar.
# ------------------------------------------------------------------
RED=$'\033[31m'
GREEN=$'\033[32m'
DIM=$'\033[2m'
RESET=$'\033[0m'

FAILED=()

run_pillar() {
    local label="$1"
    shift
    printf "%-44s " "$label"
    if "$@" >/tmp/v4-self-test.log 2>&1; then
        printf "${GREEN}PASS${RESET}\n"
    else
        printf "${RED}FAIL${RESET}\n"
        FAILED+=("$label")
        printf "${DIM}    last 12 lines of /tmp/v4-self-test.log:${RESET}\n"
        tail -n 12 /tmp/v4-self-test.log | sed 's/^/    /'
    fi
}

cd "$APP" || exit 1

echo
echo "=== SoloMD v4.0 self-test · $(date +%FT%T%z) ==="
echo

# ------------------------------------------------------------------
# Pillar 1 — Inline Agent Panel
#   Backend tools (in-process MCP surface) drive the panel chat.
#   12 e2e cases: list/read/search/backlinks/tags/outline/write/append +
#   workspace traversal guard + unknown-tool error + read_agent_trace.
# ------------------------------------------------------------------
run_pillar "Pillar 1 · Agent Panel (agent_tools)" \
    cargo test --quiet --test agent_tools_e2e_test

# ------------------------------------------------------------------
# Pillar 2 — Scheduled Recipes
#   YAML loader + runner + AutoGit branch sandbox. The non-Ollama
#   path is exercised here; the LLM call itself is gated by the
#   `--with-ollama` flag below.
# ------------------------------------------------------------------
run_pillar "Pillar 2 · Recipes (recipes_e2e)" \
    cargo test --quiet --test recipes_e2e_test

# ------------------------------------------------------------------
# Pillar 3 — Trace view + replay
#   Emitter + reader + replay-prefix slice + truncation contract.
# ------------------------------------------------------------------
run_pillar "Pillar 3 · Trace (agent_trace_e2e)" \
    cargo test --quiet --test agent_trace_e2e_test

run_pillar "Pillar 3 · Trace module unit tests" \
    cargo test --quiet --lib trace::

# ------------------------------------------------------------------
# Pillar 4 — Workspace Federation
#   solomd-mcp multi-workspace mode: back-compat + alias resolution +
#   absolute-path targeting + unknown-alias errors.
# ------------------------------------------------------------------
run_pillar "Pillar 4 · Federation (multi_workspace)" \
    bash -c "cd '$MCP' && cargo test --quiet --test multi_workspace"

# ------------------------------------------------------------------
# Pillar 5 — Ollama first-class
#   detect() + provider: local alias to ollama. The live LLM call is
#   gated behind --with-ollama.
# ------------------------------------------------------------------
run_pillar "Pillar 5 · Ollama (detect)" \
    cargo test --quiet --lib 'ollama::tests'

run_pillar "Pillar 5 · provider:local → ollama alias" \
    cargo test --quiet --lib 'ai_proxy::tests::local_aliases_to_ollama'

if [[ $WITH_OLLAMA -eq 1 ]]; then
    run_pillar "Pillar 5 · Ollama (live smoke)" \
        cargo test --quiet --test recipes_e2e_test -- --ignored ollama_smoke
fi

# ------------------------------------------------------------------
# Cross-cutting: mcp-server unit tests (path guards, tool dispatch,
# server lifecycle). Catches regressions in the MCP surface that
# Pillar 1 / 4 depend on.
# ------------------------------------------------------------------
run_pillar "Cross · mcp-server unit tests" \
    bash -c "cd '$MCP' && cargo test --quiet --bin solomd-mcp"

# ------------------------------------------------------------------
# Optional: release-build smoke test. Catches debug-only assumptions
# (`#[cfg(debug_assertions)]` guards, `if cfg!(test)` slips, …) before
# the macOS signing pipeline trips on them. The full Tauri bundle
# (signing + notarize + dmg) is user-side — see scripts/build-mac.sh.
# ------------------------------------------------------------------
if [[ $WITH_RELEASE -eq 1 ]]; then
    run_pillar "Release · cargo build --release (SoloMD)" \
        cargo build --release --bin SoloMD
    run_pillar "Release · cargo build --release (solomd-mcp)" \
        bash -c "cd '$MCP' && cargo build --release"
    run_pillar "Release · pnpm build (frontend)" \
        bash -c "cd '$REPO_ROOT/app' && pnpm build"
fi

# ------------------------------------------------------------------
# Optional: live UI smoke through pnpm tauri dev. Drives the dev-bridge
# `/eval` endpoint to verify each v4 surface mounts in the running app.
# Requires `pnpm tauri dev` to already be running — we don't start it
# here because a long-running compile + window-open is a user action.
# ------------------------------------------------------------------
if [[ $WITH_UI -eq 1 ]]; then
    run_pillar "UI · live v4-ui-smoke.mjs" \
        node "$REPO_ROOT/scripts/v4-ui-smoke.mjs"
fi

# ------------------------------------------------------------------
# Optional: signed dmg verifier. Runs the full release-channel check
# matrix on the dmg + .app produced by scripts/build-mac.sh.
# ------------------------------------------------------------------
if [[ $WITH_DMG -eq 1 ]]; then
    run_pillar "Release · signed dmg verifier" \
        bash "$REPO_ROOT/scripts/v4-verify-dmg.sh"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo
if [[ ${#FAILED[@]} -eq 0 ]]; then
    echo "${GREEN}✓ all pillars green${RESET}"
    echo
    echo "Definition-of-Done coverage:"
    echo "  · Pillar 1 — Inline Agent Panel              ✓"
    echo "  · Pillar 2 — Scheduled Recipes               ✓"
    echo "  · Pillar 3 — Trace view + replay             ✓"
    echo "  · Pillar 4 — Workspace Federation            ✓"
    echo "  · Pillar 5 — Ollama first-class              ✓"
    if [[ $WITH_RELEASE -eq 1 ]]; then
        echo "  · Release builds (SoloMD + mcp + frontend)   ✓"
    fi
    if [[ $WITH_UI -eq 1 ]]; then
        echo "  · Live UI surfaces (Tauri dev)               ✓"
    fi
    if [[ $WITH_DMG -eq 1 ]]; then
        echo "  · macOS signed dmg verified                  ✓"
    fi
    echo
    echo "Still required before v4.0 tag:"
    if [[ $WITH_RELEASE -ne 1 ]]; then
        echo "  · cargo build --release link-check (re-run with --with-release)"
    fi
    if [[ $WITH_UI -ne 1 ]]; then
        echo "  · Live UI smoke against pnpm tauri dev (re-run with --with-ui)"
    fi
    if [[ $WITH_DMG -ne 1 ]]; then
        echo "  · macOS signed dmg — scripts/build-mac.sh + --with-dmg (Apple creds in .env.local)"
    fi
    echo "  · 2-week beta channel — v4.0-rc.1 → rc.2 → tag"
    exit 0
else
    echo "${RED}✗ ${#FAILED[@]} failed:${RESET}"
    for f in "${FAILED[@]}"; do echo "  · $f"; done
    exit 1
fi
