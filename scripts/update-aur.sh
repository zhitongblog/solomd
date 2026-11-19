#!/usr/bin/env bash
# Update packaging/aur/PKGBUILD with the latest release version and SHA256SUMS (#181).
# Usage: ./scripts/update-aur.sh 5.3.0
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <version> (e.g. $0 5.3.0)" >&2
  exit 1
fi

VER="${1#v}"
TAG="v${VER}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKGBUILD="$ROOT/packaging/aur/PKGBUILD"

SUMS=$(curl -fsSL "https://github.com/zhitongblog/solomd/releases/download/${TAG}/SHA256SUMS.txt")
SHA_AMD64=$(echo "$SUMS" | awk -v f="SoloMD_${VER}_amd64.deb" '$2 == f { print $1; exit }')
SHA_ARM64=$(echo "$SUMS" | awk -v f="SoloMD_${VER}_arm64.deb" '$2 == f { print $1; exit }')

if [ -z "$SHA_AMD64" ] || [ -z "$SHA_ARM64" ]; then
  echo "ERROR: Could not locate .deb SHA256 entries for ${VER} in SHA256SUMS.txt" >&2
  exit 1
fi

python3 - "$PKGBUILD" "$VER" "$SHA_AMD64" "$SHA_ARM64" <<'PY'
import re, sys
path, ver, sha_x64, sha_arm = sys.argv[1:5]
src = open(path, encoding="utf-8").read()
src = re.sub(r"^pkgver=.*$", f"pkgver={ver}", src, flags=re.M)
src = re.sub(r"^pkgrel=.*$", "pkgrel=1", src, flags=re.M)
src = re.sub(r"^sha256sums_x86_64=.*$", f"sha256sums_x86_64=('{sha_x64}')", src, flags=re.M)
src = re.sub(r"^sha256sums_aarch64=.*$", f"sha256sums_aarch64=('{sha_arm}')", src, flags=re.M)
open(path, "w", encoding="utf-8").write(src)
print(f"Updated {path} -> {ver}")
PY
