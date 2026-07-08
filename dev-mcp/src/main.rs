//! solomd-dev-mcp — internal MCP server for self-testing SoloMD end-to-end.
//!
//! NOT shipped to end users. This binary exists so Claude (and any other
//! MCP client) can drive the SoloMD app — settings, workspace state,
//! AutoGit operations, screenshots — without trying to coerce
//! AppleScript into clicking on the WKWebView.
//!
//! Why a dev-only MCP and not just a CLI? Because the global rule
//! (alexlee's CLAUDE.md) says every client project ships with both —
//! and the ergonomics of "ask the model to call a tool" beat
//! "ask the model to compose a multi-step shell pipeline".
//!
//! Spoken to over stdio (JSON-RPC); logs go to stderr.

mod tools;

use anyhow::Result;
use clap::Parser;
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::{EnvFilter, fmt};

#[derive(Parser, Debug)]
#[command(
    name = "solomd-dev-mcp",
    version,
    about = "Dev-only MCP server for end-to-end self-testing of SoloMD"
)]
struct Cli {
    /// Verbose stderr logging (debug level).
    #[arg(long, short = 'v', default_value_t = false)]
    verbose: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let default_level = if cli.verbose { "debug" } else { "info" };
    let filter = EnvFilter::try_from_env("SOLOMD_DEV_MCP_LOG")
        .unwrap_or_else(|_| EnvFilter::new(default_level));
    fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .with_ansi(false)
        .init();

    tracing::info!(version = env!("CARGO_PKG_VERSION"), "solomd-dev-mcp starting");

    let server = tools::DevServer::new();
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
