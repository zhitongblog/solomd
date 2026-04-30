//! solomd-mcp — Model Context Protocol server for SoloMD vaults.
//!
//! Spoken to over stdio (JSON-RPC); logs go to stderr. Designed for use with
//! Claude Code, Codex CLI, and any other MCP client.
//!
//! Single-workspace (back-compat):
//!     solomd-mcp --workspace /path/to/notes
//!
//! Multi-workspace (v4.0 federation):
//!     solomd-mcp --workspace /path/A --workspace /path/B
//!     solomd-mcp --workspace work=/path/A --workspace home=/path/B
//!
//! Each `--workspace` is either a bare path (alias defaults to the path's
//! last component) or `<alias>=<path>`. The first workspace is the *default*
//! — tool calls without an explicit `workspace` argument fall through to it,
//! preserving existing single-workspace clients.

use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::{EnvFilter, fmt};

mod safety;
mod tools;
mod workspace;

#[derive(Parser, Debug)]
#[command(
    name = "solomd-mcp",
    version,
    about = "MCP server for one or more SoloMD Markdown vaults",
    long_about = "Model Context Protocol server that exposes one *or more* SoloMD Markdown notes \
                  folders as a set of tools (list_notes, read_note, search, get_backlinks, \
                  list_tags, get_outline, autogit_log/diff/rollback, sync_status, share_url, \
                  write_note, append_to_note) over JSON-RPC stdio.\n\n\
                  Pass --workspace once per vault. Each value is either:\n  \
                    /abs/path             (alias defaults to the path's last component)\n  \
                    alias=/abs/path       (explicit alias)\n\n\
                  The first workspace is the default — tool calls without an explicit \
                  `workspace` argument resolve to it, so existing single-workspace clients \
                  keep working unchanged.\n\n\
                  Read-only by default. Pass --allow-write to enable write_note, \
                  append_to_note, and autogit_rollback."
)]
struct Cli {
    /// Workspace to serve. Repeat for multi-workspace mode.
    /// Form: `<alias>=<path>` or just `<path>`.
    #[arg(long, value_name = "ALIAS=DIR | DIR", required = true, num_args = 1)]
    workspace: Vec<String>,

    /// Enable write_note + append_to_note + autogit_rollback (off by default).
    #[arg(long, default_value_t = false)]
    allow_write: bool,

    /// Verbose stderr logging (debug level).
    #[arg(long, short = 'v', default_value_t = false)]
    verbose: bool,
}

/// Parse one `--workspace` argument into `(alias, canonical_path)`.
///
/// Public so the integration tests in `tools.rs` can exercise it.
pub(crate) fn parse_workspace_arg(raw: &str) -> Result<(String, PathBuf), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("--workspace value is empty".to_string());
    }

    // Split on the *first* '=' so paths containing '=' still work after the
    // alias prefix. We only treat `alias=path` if the alias side is a
    // plausible alias token (no '/' or path separators).
    let (alias_opt, path_str) = match trimmed.find('=') {
        Some(idx) => {
            let (left, right) = trimmed.split_at(idx);
            let right = &right[1..]; // skip '='
            // If `left` looks like a path (contains '/', '\\', or starts with
            // '.' / '~'), assume the user meant a bare path that happens to
            // contain '='. Otherwise treat `left` as the alias.
            if left.contains('/') || left.contains('\\') || left.starts_with('.') || left.starts_with('~') {
                (None, trimmed)
            } else if left.is_empty() {
                return Err(format!("--workspace alias is empty in: {raw}"));
            } else {
                (Some(left.to_string()), right)
            }
        }
        None => (None, trimmed),
    };

    if path_str.is_empty() {
        return Err(format!("--workspace path is empty in: {raw}"));
    }

    let path = PathBuf::from(path_str);
    let canon = path
        .canonicalize()
        .map_err(|e| format!("workspace not accessible: {} ({e})", path.display()))?;
    if !canon.is_dir() {
        return Err(format!("workspace is not a directory: {}", canon.display()));
    }

    let alias = match alias_opt {
        Some(a) => a,
        None => canon
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("could not derive alias from path: {}", canon.display()))?,
    };

    if alias.is_empty() {
        return Err(format!("derived alias is empty for: {raw}"));
    }
    // Aliases are user-facing tokens — keep them sane.
    if alias.contains('/') || alias.contains('\\') {
        return Err(format!("alias must not contain path separators: {alias}"));
    }

    Ok((alias, canon))
}

/// Build the ordered workspace list, rejecting duplicate aliases.
pub(crate) fn build_workspace_list(raws: &[String]) -> Result<Vec<(String, PathBuf)>, String> {
    if raws.is_empty() {
        return Err("at least one --workspace is required".to_string());
    }
    let mut seen_aliases: HashSet<String> = HashSet::new();
    let mut out: Vec<(String, PathBuf)> = Vec::with_capacity(raws.len());
    for raw in raws {
        let (alias, path) = parse_workspace_arg(raw)?;
        if !seen_aliases.insert(alias.clone()) {
            return Err(format!(
                "duplicate workspace alias: {alias} (use `<alias>=<path>` to disambiguate)"
            ));
        }
        out.push((alias, path));
    }
    Ok(out)
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Logging — always to stderr so stdout stays clean for JSON-RPC.
    let default_level = if cli.verbose { "debug" } else { "info" };
    let filter = EnvFilter::try_from_env("SOLOMD_MCP_LOG")
        .unwrap_or_else(|_| EnvFilter::new(default_level));
    fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .with_ansi(false)
        .init();

    // Validate + parse all workspaces up front.
    let workspaces =
        build_workspace_list(&cli.workspace).map_err(|e| anyhow::anyhow!(e))?;

    for (alias, path) in &workspaces {
        tracing::info!(
            alias = %alias,
            workspace = %path.display(),
            "registered workspace"
        );
    }
    tracing::info!(
        count = workspaces.len(),
        default = %workspaces[0].0,
        allow_write = cli.allow_write,
        version = env!("CARGO_PKG_VERSION"),
        "solomd-mcp starting"
    );

    let server = tools::SoloMdServer::new(workspaces, cli.allow_write);

    // Hand the server its stdio transport and run until the client disconnects.
    let service = server
        .serve(stdio())
        .await
        .context("failed to start MCP service")?;

    let quit_reason = service
        .waiting()
        .await
        .context("MCP service exited with error")?;
    tracing::info!(?quit_reason, "solomd-mcp shutting down");
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests for the CLI parser. The behavioral test for the running server
// (multi-workspace tool calls) lives in tools.rs as a `cargo test` integration
// test that spawns the binary as a subprocess.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fresh_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("solomd-mcp-cli-{label}-{nanos}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_bare_path_uses_basename_as_alias() {
        let dir = fresh_dir("basename");
        let arg = dir.to_string_lossy().to_string();
        let (alias, path) = parse_workspace_arg(&arg).unwrap();
        assert_eq!(alias, dir.file_name().unwrap().to_string_lossy());
        // path is canonicalised, so just check it points at our dir.
        assert_eq!(path.canonicalize().unwrap(), dir.canonicalize().unwrap());
    }

    #[test]
    fn parse_alias_equals_path_uses_explicit_alias() {
        let dir = fresh_dir("explicit");
        let arg = format!("notes={}", dir.display());
        let (alias, path) = parse_workspace_arg(&arg).unwrap();
        assert_eq!(alias, "notes");
        assert_eq!(path.canonicalize().unwrap(), dir.canonicalize().unwrap());
    }

    #[test]
    fn parse_rejects_missing_directory() {
        let bogus = format!("alias=/definitely/does/not/exist/{}", std::process::id());
        assert!(parse_workspace_arg(&bogus).is_err());
    }

    #[test]
    fn parse_rejects_empty_alias() {
        let dir = fresh_dir("empty-alias");
        let arg = format!("={}", dir.display());
        assert!(parse_workspace_arg(&arg).is_err());
    }

    #[test]
    fn parse_treats_path_with_equals_as_path() {
        // `./relative=ish` — leading '.' triggers the path-not-alias branch.
        // We just want this to *not* try to use 'relative' as alias.
        // (We don't actually create that path; the canonicalize will fail
        // and we'll get a path-not-accessible error rather than alias parsing.)
        let arg = "./relative=ish";
        let err = parse_workspace_arg(arg).unwrap_err();
        assert!(err.contains("not accessible"), "unexpected err: {err}");
    }

    #[test]
    fn build_workspace_list_rejects_duplicate_alias() {
        let a = fresh_dir("dup-a");
        let b = fresh_dir("dup-b");
        // Force the same alias on both via explicit alias.
        let raws = vec![
            format!("notes={}", a.display()),
            format!("notes={}", b.display()),
        ];
        let err = build_workspace_list(&raws).unwrap_err();
        assert!(err.contains("duplicate workspace alias"), "got: {err}");
    }

    #[test]
    fn build_workspace_list_preserves_order() {
        let a = fresh_dir("order-a");
        let b = fresh_dir("order-b");
        let raws = vec![
            format!("first={}", a.display()),
            format!("second={}", b.display()),
        ];
        let list = build_workspace_list(&raws).unwrap();
        assert_eq!(list[0].0, "first");
        assert_eq!(list[1].0, "second");
    }

    #[test]
    fn build_workspace_list_rejects_empty_list() {
        let raws: Vec<String> = vec![];
        assert!(build_workspace_list(&raws).is_err());
    }
}
