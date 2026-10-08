#!/usr/bin/env bash
# Every src/**/*.test.ts under node:test (Node ≥ 22.6 for type stripping).
set -euo pipefail
cd "$(dirname "$0")/.."
find src -name '*.test.ts' -print0 | sort -z | xargs -0 node --test --experimental-strip-types --import ./scripts/test-register.mjs
