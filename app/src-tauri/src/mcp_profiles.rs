//! v4.0 Pillar 4 — MCP profile storage.
//!
//! An "MCP profile" is a named bundle of `(alias, workspace path)` entries
//! the user wants to expose through one solomd-mcp invocation. The frontend
//! lets the user create / rename / reorder profiles in Settings →
//! Integrations and then "Copy Claude Desktop config" to drop the right
//! JSON into `~/Library/Application Support/Claude/claude_desktop_config.json`.
//!
//! Storage layout:
//!
//!   <config_dir>/mcp-profiles.json
//!
//! `<config_dir>` is whatever Tauri's `path::app_config_dir()` returns for
//! this OS, so profiles follow the user across workspaces (they are a
//! per-installation preference, not workspace state). The file is plain
//! JSON; it lives outside any vault and is **not** committed to AutoGit.
//!
//! Reasoning for the file shape:
//!
//!   * `version` field so we can migrate without touching every call site.
//!   * `profiles[].entries[]` is an *ordered* `Vec`, not a map — multi-arg
//!     `--workspace ... --workspace ...` order matters at the MCP server
//!     (the first workspace is the default).
//!   * Profile names are slug-validated (1-64 chars, ASCII alnum + `-_ `)
//!     so they can safely round-trip through Claude Desktop config keys.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Types — kept in lockstep with `app/src/stores/mcpProfiles.ts`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McpWorkspaceEntry {
    /// User-facing alias passed to `solomd-mcp --workspace alias=path`.
    pub alias: String,
    /// Absolute path to the workspace folder.
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McpProfile {
    /// Unique name. Doubles as the `mcpServers.<key>` in Claude Desktop
    /// config, so we restrict the character set.
    pub name: String,
    /// Ordered list of workspaces. First entry is the *default* — matches
    /// the solomd-mcp server's "first workspace = default" rule.
    pub entries: Vec<McpWorkspaceEntry>,
    /// Whether to pass `--allow-write` when generating the config snippet.
    /// Default false (read-only) for safety.
    #[serde(default)]
    pub allow_write: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McpProfilesFile {
    /// Schema version. Bump on incompatible changes.
    pub version: u32,
    pub profiles: Vec<McpProfile>,
}

impl Default for McpProfilesFile {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: vec![],
        }
    }
}

// ---------------------------------------------------------------------------
// Disk I/O.
// ---------------------------------------------------------------------------

fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    Ok(dir.join("mcp-profiles.json"))
}

fn load_file(app: &AppHandle) -> Result<McpProfilesFile, String> {
    let path = profiles_path(app)?;
    if !path.exists() {
        return Ok(McpProfilesFile::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: McpProfilesFile = serde_json::from_str(&raw)
        .map_err(|e| format!("mcp-profiles.json corrupted: {e}"))?;
    Ok(parsed)
}

fn save_file(app: &AppHandle, file: &McpProfilesFile) -> Result<(), String> {
    let path = profiles_path(app)?;
    let raw = serde_json::to_string_pretty(file)
        .map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

fn validate_profile_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("profile name must be 1-64 characters".into());
    }
    // Allow space because "Work + Home" is a friendlier label than
    // "work-home". Disallow path/JSON/quote characters.
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ')
    {
        return Err("profile name: allowed characters are a-z 0-9 - _ space".into());
    }
    Ok(())
}

fn validate_alias(alias: &str) -> Result<(), String> {
    if alias.is_empty() || alias.len() > 64 {
        return Err(format!("workspace alias must be 1-64 chars: {alias:?}"));
    }
    if alias.contains('/') || alias.contains('\\') || alias.contains('=') {
        return Err(format!("alias must not contain '/' '\\\\' or '=': {alias}"));
    }
    Ok(())
}

fn validate_profile(p: &McpProfile) -> Result<(), String> {
    validate_profile_name(&p.name)?;
    if p.entries.is_empty() {
        return Err(format!("profile '{}' must have at least one workspace", p.name));
    }
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for e in &p.entries {
        validate_alias(&e.alias)?;
        if !seen.insert(&e.alias) {
            return Err(format!(
                "profile '{}' has duplicate alias '{}'",
                p.name, e.alias
            ));
        }
        if e.path.trim().is_empty() {
            return Err(format!(
                "profile '{}' has empty path for alias '{}'",
                p.name, e.alias
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mcp_profiles_list(app: AppHandle) -> Result<Vec<McpProfile>, String> {
    Ok(load_file(&app)?.profiles)
}

#[tauri::command]
pub fn mcp_profiles_save(app: AppHandle, profile: McpProfile) -> Result<Vec<McpProfile>, String> {
    validate_profile(&profile)?;
    let mut file = load_file(&app)?;
    // Replace by name if it exists, otherwise append. This makes the API
    // upsert-shaped, which is the behavior the frontend store expects.
    if let Some(pos) = file.profiles.iter().position(|p| p.name == profile.name) {
        file.profiles[pos] = profile;
    } else {
        file.profiles.push(profile);
    }
    save_file(&app, &file)?;
    Ok(file.profiles)
}

#[tauri::command]
pub fn mcp_profiles_delete(app: AppHandle, name: String) -> Result<Vec<McpProfile>, String> {
    let mut file = load_file(&app)?;
    let before = file.profiles.len();
    file.profiles.retain(|p| p.name != name);
    if file.profiles.len() == before {
        return Err(format!("profile not found: {name}"));
    }
    save_file(&app, &file)?;
    Ok(file.profiles)
}

/// Render a profile to the JSON snippet the user pastes into
/// `claude_desktop_config.json`. The `mcp_path` argument is the absolute
/// path to the bundled `solomd-mcp` binary (resolved by
/// `integrations::mcp_path`); we keep it as an arg rather than re-resolving
/// here so the frontend can show a placeholder when the binary isn't
/// available (e.g. dev builds).
#[tauri::command]
pub fn mcp_profiles_export_config(
    app: AppHandle,
    name: String,
    mcp_path: Option<String>,
) -> Result<String, String> {
    let file = load_file(&app)?;
    let profile = file
        .profiles
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("profile not found: {name}"))?;
    Ok(render_claude_config(profile, mcp_path.as_deref()))
}

/// Pure rendering function — no I/O, easy to unit-test.
pub fn render_claude_config(profile: &McpProfile, mcp_path: Option<&str>) -> String {
    let command = mcp_path.unwrap_or("/path/to/solomd-mcp");
    let mut args: Vec<String> = Vec::with_capacity(profile.entries.len() * 2 + 1);
    for entry in &profile.entries {
        args.push("--workspace".to_string());
        args.push(format!("{}={}", entry.alias, entry.path));
    }
    if profile.allow_write {
        args.push("--allow-write".to_string());
    }
    let mcp_servers = serde_json::json!({
        profile.name.clone(): {
            "command": command,
            "args": args,
        }
    });
    serde_json::to_string_pretty(&serde_json::json!({ "mcpServers": mcp_servers }))
        .unwrap_or_else(|_| "{}".into())
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, entries: &[(&str, &str)], allow_write: bool) -> McpProfile {
        McpProfile {
            name: name.into(),
            entries: entries
                .iter()
                .map(|(a, p)| McpWorkspaceEntry {
                    alias: (*a).into(),
                    path: (*p).into(),
                })
                .collect(),
            allow_write,
        }
    }

    #[test]
    fn render_claude_config_shape_matches_contract() {
        let prof = p(
            "vaults",
            &[("work", "/tmp/work"), ("home", "/tmp/home")],
            false,
        );
        let snippet = render_claude_config(&prof, Some("/usr/local/bin/solomd-mcp"));
        let v: serde_json::Value = serde_json::from_str(&snippet).unwrap();
        let server = v.pointer("/mcpServers/vaults").unwrap();
        assert_eq!(
            server.get("command").unwrap().as_str().unwrap(),
            "/usr/local/bin/solomd-mcp"
        );
        let args: Vec<String> = server
            .get("args")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "--workspace",
                "work=/tmp/work",
                "--workspace",
                "home=/tmp/home"
            ]
        );
    }

    #[test]
    fn render_claude_config_appends_allow_write_when_set() {
        let prof = p("w", &[("only", "/tmp/x")], true);
        let snippet = render_claude_config(&prof, Some("solomd-mcp"));
        assert!(snippet.contains("--allow-write"), "got: {snippet}");
    }

    #[test]
    fn render_claude_config_falls_back_to_placeholder_when_path_missing() {
        let prof = p("p", &[("only", "/tmp/x")], false);
        let snippet = render_claude_config(&prof, None);
        assert!(snippet.contains("/path/to/solomd-mcp"), "got: {snippet}");
    }

    #[test]
    fn validate_profile_rejects_empty_entries() {
        let prof = p("empty", &[], false);
        assert!(validate_profile(&prof).is_err());
    }

    #[test]
    fn validate_profile_rejects_dup_alias() {
        let prof = p("dup", &[("a", "/x"), ("a", "/y")], false);
        let err = validate_profile(&prof).unwrap_err();
        assert!(err.contains("duplicate alias"), "got: {err}");
    }

    #[test]
    fn validate_profile_rejects_bad_alias_chars() {
        let prof = p("bad", &[("a/b", "/x")], false);
        assert!(validate_profile(&prof).is_err());
    }

    #[test]
    fn validate_profile_rejects_bad_name_chars() {
        let prof = p("bad/name", &[("a", "/x")], false);
        assert!(validate_profile(&prof).is_err());
    }
}
