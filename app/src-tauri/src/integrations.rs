//! v2.4 Integrations panel — Tauri commands backing Settings → Integrations.
//!
//! Two surfaces:
//!
//!   * `cli_status()` — `which solomd` + `solomd --version` so the panel
//!     can render "Installed at /usr/local/bin/solomd" (green) or
//!     "Not installed" (faint) without the JS layer having to spawn
//!     processes itself. Mirrors the spawn_blocking pattern from
//!     `git_history.rs` so a slow `which` (e.g. cold NFS PATH) can't
//!     freeze the UI thread.
//!
//!   * `mcp_path()` — absolute path to the bundled `solomd-mcp` sidecar.
//!     Resolved via Tauri's path API rather than hardcoded:
//!     - macOS: `<App>.app/Contents/MacOS/solomd-mcp`
//!     - Windows: `<install dir>\solomd-mcp.exe`
//!     - Linux: alongside the executable
//!     Returns `None` when the sidecar isn't found (e.g. dev builds where
//!     `pnpm tauri dev` skips bundle-time externalBin staging).
//!
//!   * `mcp_claude_desktop_config_path()` — the conventional location of
//!     `claude_desktop_config.json` per OS. The frontend uses this to
//!     wire up the "Open Claude Desktop config file" button without
//!     dragging path glue into TS.

use std::path::PathBuf;
use std::process::Command;

/// Build a `Command` that never flashes a console window on Windows.
/// Without `CREATE_NO_WINDOW` (0x08000000) every probe (`where`, `solomd
/// --version`, …) pops a black cmd window for a frame — very visible when the
/// Integrations settings tab runs its status checks (顾河 report). No-op off
/// Windows.
fn no_window_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Public types — kept in sync with `app/src/lib/integrations.ts`.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct CliStatus {
    /// True iff `which solomd` resolved to an executable file.
    pub installed: bool,
    /// Absolute path on disk (None when not installed).
    pub path: Option<String>,
    /// Output of `solomd --version` truncated to the first line. None on
    /// install_failure or non-zero exit.
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct McpPath {
    /// Absolute path to the bundled `solomd-mcp` binary, or None if it
    /// couldn't be located (typical in `pnpm tauri dev`).
    pub path: Option<String>,
    /// True iff `path` is `Some` AND the file exists on disk.
    pub bundled: bool,
}

// ---------------------------------------------------------------------------
// CLI status.
// ---------------------------------------------------------------------------

/// Sync impl. Public command below dispatches to spawn_blocking — never
/// call this directly from a Tauri command thread.
pub fn cli_status_inner() -> Result<CliStatus, String> {
    // `which` (Unix) / `where` (Windows). On Windows there's no PATHEXT
    // helper either way; we just check stdout for a valid file.
    #[cfg(target_os = "windows")]
    let probe = no_window_command("where").arg("solomd").output();
    #[cfg(not(target_os = "windows"))]
    let probe = no_window_command("/usr/bin/env").args(["which", "solomd"]).output();

    let path = match probe {
        Ok(out) if out.status.success() => {
            // `where` on Windows can return multiple lines — take the first.
            let s = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|s| !s.is_empty());
            s
        }
        _ => None,
    };

    let installed = path
        .as_ref()
        .map(|p| std::path::Path::new(p).is_file())
        .unwrap_or(false);

    if !installed {
        return Ok(CliStatus {
            installed: false,
            path: None,
            version: None,
        });
    }

    // `solomd --version` — our shell CLI doesn't actually accept --version
    // today, but it does accept `help`. Keep the field for future Rust-port
    // upgrade and try help as a fallback so the panel can show *something*
    // confirming the binary is reachable.
    let version = path.as_ref().and_then(|p| {
        let out = no_window_command(p).arg("--version").output().ok()?;
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|s| !s.is_empty());
            return s;
        }
        // Fall back to a known-good subcommand.
        let out = no_window_command(p).arg("help").output().ok()?;
        if !out.status.success() {
            return None;
        }
        // Strip ANSI escapes (the bash CLI uses colored output).
        let raw = String::from_utf8_lossy(&out.stdout).into_owned();
        let plain = strip_ansi(&raw);
        plain.lines().next().map(|l| l.trim().to_string())
    });

    Ok(CliStatus {
        installed: true,
        path,
        version,
    })
}

#[tauri::command]
pub async fn cli_status() -> Result<CliStatus, String> {
    tauri::async_runtime::spawn_blocking(cli_status_inner)
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---------------------------------------------------------------------------
// MCP sidecar path.
// ---------------------------------------------------------------------------

/// Resolve the bundled `solomd-mcp` path. Strategy:
///
/// 1. On a Tauri-bundled app, externalBin places it as a *resource* —
///    `app.path().resource_dir()` returns
///    - macOS: `<App>.app/Contents/Resources`
///    - Windows: `<install dir>\resources` (or alongside .exe)
///    - Linux (AppImage): `<mount>/usr/lib/<id>`
///    However, Tauri's externalBin specifically copies the binary next to
///    the main executable on macOS / Windows — *not* into Resources — so
///    we look beside the running executable first.
/// 2. Fallback to `resource_dir/solomd-mcp[.exe]` for AppImage / Linux
///    bundles where externalBin lands inside resources.
fn resolve_mcp_path(app: &AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "solomd-mcp.exe"
    } else {
        "solomd-mcp"
    };

    // Sibling of the main exe — the canonical bundled location.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // Resource dir fallback (Linux deb/AppImage put externalBin here).
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

#[tauri::command]
pub fn mcp_path(app: AppHandle) -> McpPath {
    let p = resolve_mcp_path(&app);
    let bundled = p.as_ref().map(|x| x.is_file()).unwrap_or(false);
    McpPath {
        path: p.map(|x| x.to_string_lossy().to_string()),
        bundled,
    }
}

// ---------------------------------------------------------------------------
// Claude Desktop config file location.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mcp_claude_desktop_config_path(app: AppHandle) -> Option<String> {
    // Convention: same folder Claude Desktop reads.
    //   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
    //   Windows: %APPDATA%\Claude\claude_desktop_config.json
    //   Linux:   ~/.config/Claude/claude_desktop_config.json (best-effort —
    //            Claude Desktop is mac/win-only at time of writing)
    let parent = if cfg!(target_os = "macos") {
        app.path()
            .home_dir()
            .ok()
            .map(|h| h.join("Library/Application Support/Claude"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Claude"))
    } else {
        app.path().home_dir().ok().map(|h| h.join(".config/Claude"))
    }?;
    Some(
        parent
            .join("claude_desktop_config.json")
            .to_string_lossy()
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// Tiny utilities.
// ---------------------------------------------------------------------------

/// Strip a subset of ANSI escape sequences (CSI ... letter). Good enough
/// for the colored output our bash `solomd` script emits.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // consume '['
            // Skip until letter (the "final byte" of CSI).
            for c2 in chars.by_ref() {
                if c2.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// v4.4.5 MCP auto-install — detect + inject + remove across 6 AI clients.
//
// One-shot user flow:
//
//   1. First-run wizard calls `detect_ai_clients()`.
//   2. UI shows checklist with which configs already exist and whether
//      they already mention solomd.
//   3. User picks workspace + allow-write, clicks "Inject".
//   4. UI calls `inject_mcp(client_id, workspace, allow_write)` per
//      checked client. Each call backs up the original config
//      (`<path>.bak.<unix_seconds>`) and merges in the solomd entry.
//   5. User restarts the AI client (we surface a reminder in the UI).
//
// Each client has its own config schema — Claude Desktop, Claude Code, and
// Cursor share `mcpServers.<name> = { command, args }`; Cline adds
// `disabled` + `autoApprove`; Continue uses `mcp: [{ name, ... }]` (an
// array, not a map); Zed uses `context_servers.<name> = { command: {
// path, args }, settings: {} }`. The injection function dispatches on
// `client_id`.

#[derive(Serialize, Debug, Clone)]
pub struct AiClient {
    pub id: &'static str,
    pub display_name: &'static str,
    pub config_path: String,
    pub config_exists: bool,
    pub config_dir_exists: bool,
    pub has_solomd_entry: bool,
}

/// Resolve a client's MCP config path. Returns `None` when we can't infer
/// it (eg. Linux + Claude Desktop, which doesn't ship for Linux).
fn ai_client_config_path(client_id: &str, app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok();

    match client_id {
        "claude-desktop" => {
            if cfg!(target_os = "macos") {
                home.map(|h| h.join("Library/Application Support/Claude/claude_desktop_config.json"))
            } else if cfg!(target_os = "windows") {
                std::env::var_os("APPDATA")
                    .map(|a| PathBuf::from(a).join("Claude/claude_desktop_config.json"))
            } else {
                // Claude Desktop has no Linux build as of writing — return
                // the conventional path anyway so the UI can still surface
                // "expected here when it lands".
                home.map(|h| h.join(".config/Claude/claude_desktop_config.json"))
            }
        }
        "claude-code" => home.map(|h| h.join(".claude/mcp.json")),
        "cursor" => home.map(|h| h.join(".cursor/mcp.json")),
        "cline" => {
            // VS Code globalStorage. Path varies by OS but follows the same
            // shape under each platform's user-data dir.
            if cfg!(target_os = "macos") {
                home.map(|h| h.join(
                    "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
                ))
            } else if cfg!(target_os = "windows") {
                std::env::var_os("APPDATA").map(|a| {
                    PathBuf::from(a).join(
                        "Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
                    )
                })
            } else {
                home.map(|h| h.join(
                    ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
                ))
            }
        }
        "continue" => home.map(|h| h.join(".continue/config.json")),
        "zed" => {
            if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
                home.map(|h| h.join(".config/zed/settings.json"))
            } else if cfg!(target_os = "windows") {
                std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Zed/settings.json"))
            } else {
                None
            }
        }
        _ => None,
    }
}

const AI_CLIENTS: &[(&str, &str)] = &[
    ("claude-desktop", "Claude Desktop"),
    ("claude-code", "Claude Code"),
    ("cursor", "Cursor"),
    ("cline", "Cline (VS Code)"),
    ("continue", "Continue.dev"),
    ("zed", "Zed"),
];

/// List every supported AI client, whether its config file / directory
/// already exists on this machine, and whether the config already mentions
/// "solomd" (cheap substring check — avoids parsing JSON just for the
/// summary view).
#[tauri::command]
pub fn detect_ai_clients(app: AppHandle) -> Vec<AiClient> {
    AI_CLIENTS
        .iter()
        .filter_map(|(id, display)| {
            let path = ai_client_config_path(id, &app)?;
            let config_exists = path.is_file();
            let config_dir_exists = path.parent().map(|p| p.is_dir()).unwrap_or(false);
            let has_solomd_entry = if config_exists {
                std::fs::read_to_string(&path)
                    .map(|s| s.contains("solomd"))
                    .unwrap_or(false)
            } else {
                false
            };
            Some(AiClient {
                id,
                display_name: display,
                config_path: path.to_string_lossy().to_string(),
                config_exists,
                config_dir_exists,
                has_solomd_entry,
            })
        })
        .collect()
}

/// Build the solomd-mcp command line for a given client's config schema.
/// `mcp_path` is the absolute path to the bundled `solomd-mcp` binary;
/// `workspace` and `allow_write` come from the UI.
fn build_solomd_args(workspace: &str, allow_write: bool) -> Vec<String> {
    let mut args = vec!["--workspace".to_string(), workspace.to_string()];
    if allow_write {
        args.push("--allow-write".to_string());
    }
    args
}

/// Read JSON from disk, returning an empty `{}` if the file doesn't exist.
/// Any parse error is surfaced — we deliberately refuse to silently clobber
/// a config file the user has hand-edited into something we can't read.
fn read_json_or_empty(path: &PathBuf) -> Result<JsonValue, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Write JSON back with two-space pretty-printing. Creates parent
/// directories as needed. Backs up the original (when present) to
/// `<path>.bak.<unix_seconds>` so the user can recover from any
/// botched merge.
fn write_json_with_backup(path: &PathBuf, value: &JsonValue) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    if path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = path.with_extension(format!("bak.{ts}"));
        std::fs::copy(path, &backup)
            .map_err(|e| format!("backup {} -> {}: {e}", path.display(), backup.display()))?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, body + "\n").map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// Build the solomd MCP server entry in the shape the given client
/// expects. Returns the value to set under the client's MCP-server map
/// (or, for Continue's array, the single element to insert).
fn build_solomd_entry(client_id: &str, mcp_path: &str, args: &[String]) -> JsonValue {
    match client_id {
        "zed" => json!({
            "command": { "path": mcp_path, "args": args },
            "settings": {}
        }),
        "cline" => json!({
            "command": mcp_path,
            "args": args,
            "disabled": false,
            // Pre-approve the read-only tools so Cline doesn't ask the user
            // for confirmation on every list_notes / read_note. Writes still
            // prompt because the user only sees them after the wizard
            // chose to opt in to --allow-write.
            "autoApprove": [
                "list_notes", "read_note", "search",
                "get_outline", "get_backlinks", "list_tags",
                "autogit_log", "autogit_diff", "sync_status",
                "share_url", "read_agent_trace"
            ]
        }),
        "continue" => json!({
            "name": "solomd",
            "command": mcp_path,
            "args": args
        }),
        _ => json!({
            "command": mcp_path,
            "args": args
        }),
    }
}

/// Surgical insert/update of the solomd entry under whichever top-level
/// key the client uses.
fn splice_solomd_entry(
    client_id: &str,
    config: &mut JsonValue,
    entry: JsonValue,
) -> Result<(), String> {
    match client_id {
        "claude-desktop" | "claude-code" | "cursor" => {
            let map = config
                .as_object_mut()
                .ok_or("root is not a JSON object")?;
            let servers = map
                .entry("mcpServers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("mcpServers is not a JSON object")?;
            servers.insert("solomd".to_string(), entry);
        }
        "cline" => {
            let map = config
                .as_object_mut()
                .ok_or("root is not a JSON object")?;
            let servers = map
                .entry("mcpServers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("mcpServers is not a JSON object")?;
            servers.insert("solomd".to_string(), entry);
        }
        "continue" => {
            let map = config
                .as_object_mut()
                .ok_or("root is not a JSON object")?;
            let list = map
                .entry("mcp")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("mcp is not a JSON array")?;
            // Replace existing solomd entry if present; otherwise append.
            if let Some(existing) = list
                .iter_mut()
                .find(|e| e.get("name").and_then(|n| n.as_str()) == Some("solomd"))
            {
                *existing = entry;
            } else {
                list.push(entry);
            }
        }
        "zed" => {
            let map = config
                .as_object_mut()
                .ok_or("root is not a JSON object")?;
            let servers = map
                .entry("context_servers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or("context_servers is not a JSON object")?;
            servers.insert("solomd".to_string(), entry);
        }
        _ => return Err(format!("unknown client_id: {client_id}")),
    }
    Ok(())
}

/// Frontend command: merge a solomd entry into one client's config.
#[tauri::command]
pub fn inject_mcp(
    app: AppHandle,
    client_id: String,
    workspace: String,
    allow_write: bool,
) -> Result<String, String> {
    let config_path = ai_client_config_path(&client_id, &app)
        .ok_or_else(|| format!("no config path for {client_id} on this OS"))?;
    let mcp_path = resolve_mcp_path(&app)
        .ok_or_else(|| "bundled solomd-mcp not found".to_string())?
        .to_string_lossy()
        .to_string();
    let args = build_solomd_args(&workspace, allow_write);
    let entry = build_solomd_entry(&client_id, &mcp_path, &args);

    let mut config = read_json_or_empty(&config_path)?;
    splice_solomd_entry(&client_id, &mut config, entry)?;
    write_json_with_backup(&config_path, &config)?;
    Ok(config_path.to_string_lossy().to_string())
}

/// Frontend command: remove the solomd entry from one client's config
/// (used by uninstall + by the wizard's "undo last inject" affordance).
#[tauri::command]
pub fn remove_mcp(app: AppHandle, client_id: String) -> Result<(), String> {
    let config_path = ai_client_config_path(&client_id, &app)
        .ok_or_else(|| format!("no config path for {client_id} on this OS"))?;
    if !config_path.exists() {
        return Ok(());
    }
    let mut config = read_json_or_empty(&config_path)?;
    match client_id.as_str() {
        "claude-desktop" | "claude-code" | "cursor" | "cline" => {
            if let Some(servers) = config
                .get_mut("mcpServers")
                .and_then(|v| v.as_object_mut())
            {
                servers.remove("solomd");
            }
        }
        "continue" => {
            if let Some(list) = config.get_mut("mcp").and_then(|v| v.as_array_mut()) {
                list.retain(|e| e.get("name").and_then(|n| n.as_str()) != Some("solomd"));
            }
        }
        "zed" => {
            if let Some(servers) = config
                .get_mut("context_servers")
                .and_then(|v| v.as_object_mut())
            {
                servers.remove("solomd");
            }
        }
        _ => return Err(format!("unknown client_id: {client_id}")),
    }
    write_json_with_backup(&config_path, &config)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_drops_csi() {
        assert_eq!(strip_ansi("\x1b[0;32mok\x1b[0m"), "ok");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("\x1b[1mbold\x1b[0m + \x1b[31mred\x1b[0m"), "bold + red");
    }

    #[test]
    fn splice_claude_desktop_into_empty() {
        let mut c = json!({});
        let entry = json!({ "command": "/bin/solomd-mcp", "args": ["--workspace", "/notes"] });
        splice_solomd_entry("claude-desktop", &mut c, entry.clone()).unwrap();
        assert_eq!(c["mcpServers"]["solomd"], entry);
    }

    #[test]
    fn splice_claude_desktop_preserves_other_servers() {
        let mut c = json!({
            "mcpServers": {
                "other": { "command": "/bin/other", "args": [] }
            },
            "globalShortcut": "Cmd+Shift+J"
        });
        let entry = json!({ "command": "/bin/solomd-mcp", "args": [] });
        splice_solomd_entry("claude-desktop", &mut c, entry.clone()).unwrap();
        assert_eq!(c["mcpServers"]["solomd"], entry);
        assert!(c["mcpServers"]["other"].is_object());
        assert_eq!(c["globalShortcut"], "Cmd+Shift+J");
    }

    #[test]
    fn splice_continue_replaces_existing_solomd() {
        let mut c = json!({
            "mcp": [
                { "name": "solomd", "command": "/old/path", "args": [] },
                { "name": "other", "command": "/bin/other", "args": [] }
            ]
        });
        let entry = json!({ "name": "solomd", "command": "/new/path", "args": ["--allow-write"] });
        splice_solomd_entry("continue", &mut c, entry.clone()).unwrap();
        let arr = c["mcp"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        let solomd = arr.iter().find(|e| e["name"] == "solomd").unwrap();
        assert_eq!(solomd["command"], "/new/path");
    }

    #[test]
    fn splice_zed_uses_nested_command_object() {
        let mut c = json!({});
        let entry = json!({
            "command": { "path": "/bin/solomd-mcp", "args": ["--workspace", "/notes"] },
            "settings": {}
        });
        splice_solomd_entry("zed", &mut c, entry.clone()).unwrap();
        assert_eq!(c["context_servers"]["solomd"], entry);
    }
}
