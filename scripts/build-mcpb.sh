#!/usr/bin/env bash
#
# Build the MCPB bundle of solomd-mcp for a published release, and a variant
# for Smithery.
#
#   scripts/build-mcpb.sh <X.Y.Z>
#
# Produces dist/solomd-mcp-<ver>.mcpb (upload to the GitHub release; it is what
# server.json registers in the official MCP Registry) and
# dist/solomd-mcp-<ver>-smithery.mcpb (publish with
# `npx @smithery/cli mcp publish <file> -n lixd220/solomd`).
#
# Contents:
#   server/solomd-mcp        macOS universal, built here from mcp-server/,
#                            signed with the Developer ID and notarized.
#                            The sidecar inside SoloMD.app can't be reused:
#                            it dies with SIGTRAP outside the app bundle.
#   server/solomd-mcp.exe    Windows x64, from the release's solomd-mcp-win-x64.zip
#   server/solomd-mcp-linux  Linux x64, from the release's solomd-mcp-linux-x64.tar.gz
#
# The tool list in manifest.json is regenerated from a live `tools/list`, so it
# can't drift from the binary. Smithery additionally requires every tool to carry
# its inputSchema (it rejects the plain MCPB manifest with 400 "expected object,
# received undefined", once per tool), so that goes only into the -smithery copy.
#
# Requires: cargo with aarch64/x86_64-apple-darwin targets, gh, python3, and
# the Apple signing/notary credentials used by build-mac.sh (.env.local).

set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?usage: $0 <X.Y.Z>}"
TAG="v$VER"
REPO=zhitongblog/solomd
OUT="$PWD/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi
: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY}"
# shellcheck disable=SC1091
source scripts/lib/asc-auth.sh
asc_resolve_auth

echo "==> Building solomd-mcp (macOS universal)"
( cd mcp-server
  cargo build --release --target aarch64-apple-darwin >/dev/null
  cargo build --release --target x86_64-apple-darwin >/dev/null )
mkdir -p "$WORK/b/server"
lipo -create \
  mcp-server/target/aarch64-apple-darwin/release/solomd-mcp \
  mcp-server/target/x86_64-apple-darwin/release/solomd-mcp \
  -output "$WORK/b/server/solomd-mcp"

echo "==> Signing and notarizing"
codesign --force --options runtime --timestamp \
  --sign "$APPLE_SIGNING_IDENTITY" "$WORK/b/server/solomd-mcp"
ditto -c -k "$WORK/b/server/solomd-mcp" "$WORK/notarize.zip"
xcrun notarytool submit "$WORK/notarize.zip" "${ASC_NOTARY_AUTH[@]}" --wait \
  | tee "$WORK/notary.log" | grep -E "status:|id:" | tail -2
grep -q "status: Accepted" "$WORK/notary.log" || { echo "notarization not accepted" >&2; exit 1; }

echo "==> Fetching Windows and Linux binaries from $TAG"
for i in 1 2 3 4 5; do
  gh release download "$TAG" -R "$REPO" -D "$WORK/dl" --clobber \
    -p solomd-mcp-win-x64.zip -p solomd-mcp-linux-x64.tar.gz && break
  sleep 5
done
( cd "$WORK/dl" && unzip -oq solomd-mcp-win-x64.zip && tar xzf solomd-mcp-linux-x64.tar.gz )
cp "$(find "$WORK/dl" -name 'solomd-mcp.exe' | head -1)" "$WORK/b/server/solomd-mcp.exe"
cp "$(find "$WORK/dl" -type f -name 'solomd-mcp' | head -1)" "$WORK/b/server/solomd-mcp-linux"
chmod +x "$WORK/b/server/solomd-mcp" "$WORK/b/server/solomd-mcp-linux"
file "$WORK/b/server/solomd-mcp.exe" | grep -q "x86-64" || { echo "Windows binary is not x86-64" >&2; exit 1; }
file "$WORK/b/server/solomd-mcp-linux" | grep -q "x86-64" || { echo "Linux binary is not x86-64" >&2; exit 1; }

cp app/src-tauri/icons/128x128.png "$WORK/b/icon.png"

echo "==> Writing manifests from a live tools/list"
mkdir -p "$WORK/ws"
VER="$VER" python3 - "$WORK" <<'PY'
import json, os, subprocess, sys
work = sys.argv[1]
# Run it the way the bundle runs: outside any source checkout and without
# SOLOMD_EXPORT_SCRIPT, so export_note (Node + the repo's export script)
# is left out exactly as it is for people who install the .mcpb.
env = {k: v for k, v in os.environ.items() if k != "SOLOMD_EXPORT_SCRIPT"}
p = subprocess.Popen([f"{work}/b/server/solomd-mcp", "--workspace", f"{work}/ws"], cwd=work, env=env,
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def call(o):
    p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
    if "id" in o:
        return json.loads(p.stdout.readline())
call({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "build-mcpb", "version": "1"}}})
call({"jsonrpc": "2.0", "method": "notifications/initialized"})
tools = call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
# Keep stdin open until we are done reading: solomd-mcp hangs if several
# requests arrive and stdin closes immediately.
p.kill()
m = json.load(open("mcp-server/mcpb/manifest.json"))
m["version"] = os.environ["VER"]
m["tools"] = [{"name": t["name"], "description": t.get("description", "")} for t in tools]
json.dump(m, open("mcp-server/mcpb/manifest.json", "w"), indent=2, ensure_ascii=False)
open("mcp-server/mcpb/manifest.json", "a").write("\n")
json.dump(m, open(f"{work}/b/manifest.json", "w"), indent=2, ensure_ascii=False)
ms = json.loads(json.dumps(m))
by = {t["name"]: t for t in tools}
for t in ms["tools"]:
    t["inputSchema"] = by[t["name"]]["inputSchema"]
os.makedirs(f"{work}/s", exist_ok=True)
json.dump(ms, open(f"{work}/s/manifest.json", "w"), indent=2, ensure_ascii=False)
print(f"   {len(tools)} tools")
PY

BUNDLE="$OUT/solomd-mcp-$VER.mcpb"
SMITHERY="$OUT/solomd-mcp-$VER-smithery.mcpb"
rm -f "$BUNDLE" "$SMITHERY"
( cd "$WORK/b" && zip -qr -X "$BUNDLE" manifest.json icon.png server )
cp -R "$WORK/b/server" "$WORK/b/icon.png" "$WORK/s/"
( cd "$WORK/s" && zip -qr -X "$SMITHERY" manifest.json icon.png server )

echo "==> $BUNDLE ($(wc -c < "$BUNDLE" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$BUNDLE" | cut -d' ' -f1))"
echo "==> $SMITHERY"
echo "Next: upload the .mcpb to $TAG, then update server.json (version, identifier, fileSha256) and"
echo "      mcp-publisher publish; and npx @smithery/cli mcp publish $SMITHERY -n lixd220/solomd"
