//! solomd-mcp — Model Context Protocol server for a SoloMD vault.
//!
//! Spoken to over stdio (JSON-RPC); logs go to stderr. Designed for use with
//! Claude Code, Codex CLI, and any other MCP client.
//!
//! Usage:
//!     solomd-mcp --workspace /path/to/notes
//!     solomd-mcp --workspace /path/to/notes --allow-write --verbose

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
    about = "MCP server for a SoloMD Markdown vault",
    long_about = "Model Context Protocol server that exposes a SoloMD Markdown notes folder \
                  as a set of tools (list_notes, read_note, search, get_backlinks, list_tags, \
                  get_outline, write_note, append_to_note) over JSON-RPC stdio.\n\n\
                  Read-only by default. Pass --allow-write to enable write_note + append_to_note."
)]
struct Cli {
    /// Path to the workspace (notes folder) to serve.
    #[arg(long, value_name = "DIR")]
    workspace: PathBuf,

    /// Enable write_note + append_to_note tools (off by default).
    #[arg(long, default_value_t = false)]
    allow_write: bool,

    /// Verbose stderr logging (debug level).
    #[arg(long, short = 'v', default_value_t = false)]
    verbose: bool,
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

    // Validate workspace.
    let workspace = cli
        .workspace
        .canonicalize()
        .with_context(|| format!("workspace not accessible: {}", cli.workspace.display()))?;
    if !workspace.is_dir() {
        anyhow::bail!("workspace is not a directory: {}", workspace.display());
    }

    tracing::info!(
        workspace = %workspace.display(),
        allow_write = cli.allow_write,
        version = env!("CARGO_PKG_VERSION"),
        "solomd-mcp starting"
    );

    let server = tools::SoloMdServer::new(workspace, cli.allow_write);

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
