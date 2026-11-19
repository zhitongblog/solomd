#!/usr/bin/env bash
# Build a glibc 2.28-compatible Linux x86_64 AppImage / .deb for UOS 20, Kylin,
# and Debian 10 machines (#601) using Docker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="solomd-linux-glibc228:buster"

docker build --platform linux/amd64 -t "$IMAGE" -f "$ROOT/packaging/linux-glibc228/Dockerfile" "$ROOT/packaging/linux-glibc228"

docker run --rm --platform linux/amd64 \
  -v "$ROOT:/workspace" \
  -w /workspace \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    pnpm --dir app install --frozen-lockfile
    bash scripts/build-mcp-sidecar.sh
    pnpm --dir app tauri build --bundles appimage,deb
    mkdir -p dist-linux-glibc228
    cp app/src-tauri/target/release/bundle/appimage/*.AppImage dist-linux-glibc228/ || true
    cp app/src-tauri/target/release/bundle/deb/*.deb dist-linux-glibc228/ || true
    ls -lh dist-linux-glibc228/
  '
