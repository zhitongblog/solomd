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

use serde::Serialize;
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
    let probe = Command::new("where").arg("solomd").output();
    #[cfg(not(target_os = "windows"))]
    let probe = Command::new("/usr/bin/env").args(["which", "solomd"]).output();

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
        let out = Command::new(p).arg("--version").output().ok()?;
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|s| !s.is_empty());
            return s;
        }
        // Fall back to a known-good subcommand.
        let out = Command::new(p).arg("help").output().ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_drops_csi() {
        assert_eq!(strip_ansi("\x1b[0;32mok\x1b[0m"), "ok");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("\x1b[1mbold\x1b[0m + \x1b[31mred\x1b[0m"), "bold + red");
    }
}
