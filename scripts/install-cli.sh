#!/bin/bash
#
# Installs the `solomd` CLI to /usr/local/bin (or $HOME/.local/bin if
# /usr/local/bin isn't writable).
#
# Run via:
#   curl -fsSL https://raw.githubusercontent.com/zhitongblog/solomd/main/scripts/install-cli.sh | bash

set -e

URL="https://raw.githubusercontent.com/zhitongblog/solomd/main/scripts/solomd"
TARGETS=("/usr/local/bin/solomd" "$HOME/.local/bin/solomd")

for target in "${TARGETS[@]}"; do
    dir="$(dirname "$target")"
    if [[ -w "$dir" ]] || mkdir -p "$dir" 2>/dev/null && [[ -w "$dir" ]]; then
        echo "Installing solomd to $target"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$URL" -o "$target"
        elif command -v wget >/dev/null 2>&1; then
            wget -q "$URL" -O "$target"
        else
            echo "Error: need curl or wget" >&2
            exit 1
        fi
        chmod +x "$target"
        echo "Installed. Try: solomd help"
        exit 0
    fi
done

echo "No writable target dir. Tried: ${TARGETS[*]}" >&2
echo "Run with sudo, or create ~/.local/bin and add it to PATH." >&2
exit 1
