#!/usr/bin/env bash
# Installer for the SoloMD Claude Code skill.
#
# Detects OS + arch, downloads or builds the solomd-mcp binary, and patches
# ~/.claude/mcp.json with a `solomd` entry pointing at a workspace path the
# user is prompted for (or one passed via $SOLOMD_WORKSPACE).
#
# Idempotent — re-running upgrades the binary and leaves the config alone
# (won't clobber an existing `solomd` MCP entry).
#
# Usage:
#   bash install.sh                    # interactive
#   SOLOMD_WORKSPACE=/path bash install.sh  # non-interactive
set -euo pipefail

LATEST=https://github.com/zhitongblog/solomd/releases/latest/download
BIN_DIR="${HOME}/.claude/bin"
MCP_JSON="${HOME}/.claude/mcp.json"

mkdir -p "$BIN_DIR"

# ---- Resolve target ----
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) target=macos ;;
  Linux)
    case "$arch" in
      x86_64) target=linux-x64 ;;
      aarch64|arm64) target=linux-arm64 ;;
      *) echo "Unsupported Linux arch: $arch"; exit 1 ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*)
    case "$arch" in
      x86_64) target=win-x64 ;;
      aarch64) target=win-arm64 ;;
      *) echo "Unsupported Windows arch: $arch"; exit 1 ;;
    esac
    ;;
  *) echo "Unsupported OS: $os"; exit 1 ;;
esac

echo "Target: $target"

# ---- Install binary ----
case "$target" in
  macos)
    # Apple Silicon + Intel: easiest path is cargo. No standalone tarball
    # is published for macOS because the binary already lives inside
    # SoloMD.app.
    if ! command -v cargo >/dev/null 2>&1; then
      cat <<EOF
solomd-mcp on macOS is distributed via cargo. Install Rust:
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

Or download the SoloMD.app from https://solomd.app and link the bundled
binary instead:
  ln -s /Applications/SoloMD.app/Contents/MacOS/solomd-mcp "$BIN_DIR/solomd-mcp"
EOF
      exit 1
    fi
    cargo install solomd-mcp --root "$HOME/.claude"  # installs to $HOME/.claude/bin
    ;;
  linux-x64|linux-arm64)
    url="$LATEST/solomd-mcp-$target.tar.gz"
    echo "Downloading $url"
    curl -L "$url" | tar -xz -C "$BIN_DIR"
    chmod +x "$BIN_DIR/solomd-mcp"
    ;;
  win-x64|win-arm64)
    url="$LATEST/solomd-mcp-$target.zip"
    echo "Downloading $url"
    tmp=$(mktemp -d)
    curl -L "$url" -o "$tmp/solomd-mcp.zip"
    unzip -o "$tmp/solomd-mcp.zip" -d "$BIN_DIR"
    rm -rf "$tmp"
    ;;
esac

if ! [ -x "$BIN_DIR/solomd-mcp" ] && ! command -v solomd-mcp >/dev/null 2>&1; then
  echo "Install completed but solomd-mcp not found on PATH or in $BIN_DIR. Aborting." >&2
  exit 2
fi

echo "Installed: $($BIN_DIR/solomd-mcp --version 2>/dev/null || command -v solomd-mcp)"

# ---- Resolve workspace ----
if [ -z "${SOLOMD_WORKSPACE:-}" ]; then
  read -rp "Path to your Markdown notes folder: " SOLOMD_WORKSPACE
fi
if [ ! -d "$SOLOMD_WORKSPACE" ]; then
  echo "Not a directory: $SOLOMD_WORKSPACE" >&2
  exit 3
fi
SOLOMD_WORKSPACE=$(cd "$SOLOMD_WORKSPACE" && pwd)
echo "Workspace: $SOLOMD_WORKSPACE"

# ---- Patch ~/.claude/mcp.json ----
mkdir -p "$(dirname "$MCP_JSON")"
if [ ! -f "$MCP_JSON" ]; then
  echo '{"mcpServers":{}}' > "$MCP_JSON"
fi

# Use Python because every macOS / Linux box has it; avoids a jq dep.
python3 - "$MCP_JSON" "$BIN_DIR/solomd-mcp" "$SOLOMD_WORKSPACE" <<'PY'
import json, sys, pathlib
path, bin_, ws = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
cfg = json.loads(p.read_text())
servers = cfg.setdefault("mcpServers", {})
if "solomd" in servers:
    print(f"Existing 'solomd' entry kept — edit {path} by hand to change it.")
else:
    servers["solomd"] = {
        "command": bin_,
        "args": ["--workspace", ws]
    }
    p.write_text(json.dumps(cfg, indent=2) + "\n")
    print(f"Added 'solomd' MCP entry to {path}")
PY

cat <<EOF

Done. Start a new Claude Code session in any folder and run \`/mcp\`. You
should see "solomd" with 13 tools.

To enable writes (write_note / append_to_note / autogit_rollback), edit
$MCP_JSON and append "--allow-write" to the args array.

Pair with the SoloMD desktop app for the Agent panel UI:
  https://github.com/zhitongblog/solomd/releases/latest
EOF
