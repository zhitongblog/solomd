# solomd-dev-mcp

**Internal-only MCP server for end-to-end self-testing of SoloMD.** Not shipped to users; sits next to (not inside) the user-facing `solomd-mcp` so the test harness can never accidentally surface in a release build.

## Why

The end-user `solomd-mcp` exposes a vault to LLM clients. This separate server exposes SoloMD's own internal state (settings, tabs, AutoGit, file system) so Claude can drive the app from the outside and verify that a feature actually works — the rule from `~/.claude/CLAUDE.md` is "every client project ships with CLI + MCP for self-test."

We use this dev MCP for things AppleScript can't reliably do (clicking nested WKWebView elements like the History panel's Restore button) and for state setup that would otherwise require a human (toggling settings before a fresh launch).

## Tools

| Tool | What it does |
|---|---|
| `solomd_get_settings` / `solomd_set_setting` | Read / write `solomd.settings.v1` in the WebKit LocalStorage SQLite. |
| `solomd_get_workspace` / `solomd_set_workspace` | Read / set `currentFolder`. |
| `solomd_get_tabs` / `solomd_set_tabs` | Read / replace the tabs state with a single open tab. |
| `solomd_git_status` | Same payload as the `git_workspace_status` Tauri command. |
| `solomd_git_init` | Initialize the folder + initial commit. |
| `solomd_git_commit` | Stage and commit. Returns the new SHA or null. |
| `solomd_git_log` | List commits that touched a single file, newest first. |
| `solomd_git_file_at` | Read a file's content at a specific commit (no disk write). |
| `solomd_git_rollback` | Overwrite the working-copy file with the version at a SHA. |
| `solomd_read_file` / `solomd_write_file` | Plain disk read/write for verification. |
| `solomd_screenshot` | `screencapture -x` to a temp PNG; returns the path. |
| `solomd_app_status` | List running SoloMD processes (so you know if you're testing dev or prod). |

LocalStorage writes (`solomd_set_setting` / `solomd_set_workspace` / `solomd_set_tabs`) require **SoloMD be closed** — WKWebView holds the SQLite open exclusively while running.

## Build + run

```bash
cd dev-mcp
cargo build                # debug
cargo build --release      # 1.5 MB single binary
./target/debug/solomd-dev-mcp -v
```

Speaks JSON-RPC over stdio. Logs to stderr.

## Register with Claude Code

```bash
claude mcp add --scope user solomd-dev \
  /Users/alexlee/code/notebook/dev-mcp/target/debug/solomd-dev-mcp
```

After restarting Claude Code, the tools show up as `mcp__solomd-dev__solomd_*`.

## Bundle id distinction

WebKit LocalStorage is keyed by bundle id:

- **dev** (`bundle: "dev"`) → `~/Library/WebKit/solomd/...` — what `pnpm tauri dev` writes.
- **prod** (`bundle: "prod"`) → `~/Library/WebKit/app.solomd/...` — the installed dmg.

Default is `dev`. The two never share state, which has bitten me twice — be explicit when scripting.

## What this DOESN'T cover

- Driving the **frontend Vue components** (clicking the Restore button, watching the dirty indicator clear). The dev MCP exercises everything *behind* `invoke()` — the Tauri commands are tested by exercising the same git2 / fs / sqlite paths the real Tauri commands use. To click the actual button, you'd need a CDP-style frontend driver, which Tauri WKWebView doesn't natively expose. That's a v2.3+ infrastructure piece (probably "Tauri dev plugin that mounts a WebDriver bridge").
- Production app store builds — same code paths but in a sandboxed location we can't poke.

For the in-flight pieces dev MCP DOES cover (settings persist, AutoGit init/commit/rollback, file roundtrip), it's the source of truth — `cargo build && ./target/debug/solomd-dev-mcp` and you can run the same JSON-RPC sequences in CI.
