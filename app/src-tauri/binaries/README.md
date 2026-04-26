# Tauri externalBin staging

This directory holds per-target builds of the `solomd-mcp` binary that
Tauri's bundler embeds as a sidecar (see `bundle.externalBin` in
`tauri.conf.json`).

Files here are produced by `scripts/build-mcp-sidecar.sh`, which is wired
to run automatically as `beforeBundleCommand` for `pnpm tauri build`.

You do **not** need to manually populate this folder. CI calls the same
script per target so production builds always include a matched MCP
sidecar.

Naming convention (Tauri 2):

    solomd-mcp-x86_64-apple-darwin
    solomd-mcp-aarch64-apple-darwin
    solomd-mcp-x86_64-unknown-linux-gnu
    solomd-mcp-aarch64-unknown-linux-gnu
    solomd-mcp-x86_64-pc-windows-msvc.exe

At install time Tauri renames the matching one back to `solomd-mcp` (or
`solomd-mcp.exe`) and drops it next to the main `SoloMD` binary. The
runtime path on each platform is then:

    macOS:   /Applications/SoloMD.app/Contents/MacOS/solomd-mcp
    Windows: <install dir>\solomd-mcp.exe
    Linux:   alongside the AppImage / installed binary
