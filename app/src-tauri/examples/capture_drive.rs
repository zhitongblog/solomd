//! Standalone driver for the v2.4 HTTP capture endpoint.
//!
//! Spins up the same hand-rolled HTTP/1.1 server that the desktop app
//! exposes via Settings → Integrations, but without needing a Tauri
//! AppHandle. Used by:
//!   - the web-clipper smoke test (`web-clipper/scripts/smoke-test.sh`)
//!   - any external client that wants to develop against the wire format
//!     without launching the full desktop app
//!
//! Usage:
//!   cargo run --example capture_drive -- <workspace> [<port>]
//!
//! Prints (to stdout):
//!   PORT=<bound port>
//!   TOKEN=<bearer token>
//!   WORKSPACE=<absolute workspace path>
//!
//! Then blocks forever serving requests. Send SIGINT (Ctrl-C) to stop.

use std::path::PathBuf;

use app_lib::capture_endpoint::{
    _test_bind_and_serve, _test_current_token, _test_set_state,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: {} <workspace> [<port>]", args[0]);
        std::process::exit(2);
    }
    let workspace = PathBuf::from(&args[1]);
    if !workspace.is_dir() {
        eprintln!("error: workspace folder does not exist: {}", workspace.display());
        std::process::exit(1);
    }

    // Stable token if SOLOMD_CAPTURE_TOKEN env is set, else mint via _test_set_state.
    // The web-clipper smoke test prefers a stable token so it can dump it to .env
    // before we spawn this process.
    let token = std::env::var("SOLOMD_CAPTURE_TOKEN")
        .unwrap_or_else(|_| "drive-token-0123456789abcdef0123456789abcdef".to_string());

    _test_set_state(Some(workspace.clone()), token.clone(), "inbox".to_string());

    // Bind & serve in a tokio runtime.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let port = rt.block_on(async {
        _test_bind_and_serve()
            .await
            .expect("bind capture endpoint")
    });

    let actual_token = _test_current_token();

    println!("PORT={port}");
    println!("TOKEN={actual_token}");
    println!("WORKSPACE={}", workspace.canonicalize().unwrap_or(workspace.clone()).display());
    println!("READY");

    // Keep process alive — the actual server is running on a tokio task.
    // Park forever; user kills with Ctrl-C.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}
