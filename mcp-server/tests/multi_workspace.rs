//! Behavioral integration test for v4.0 multi-workspace federation.
//!
//! Spawns the actual `solomd-mcp` binary as a subprocess, drives it over
//! stdio with raw JSON-RPC frames (mirroring the README's "Verifying"
//! recipe), and asserts:
//!
//!   * a `list_notes` call with no `workspace` arg returns the default
//!     workspace's notes (back-compat for single-`--workspace` clients);
//!   * a `list_notes` call with `workspace: "wsB"` (alias) returns wsB's;
//!   * a `list_notes` call with the absolute path of wsB returns wsB's;
//!   * a `list_notes` call with a bogus workspace returns an error frame
//!     listing the registered aliases.
//!
//! Why subprocess-driven: the rmcp `serve(stdio())` machinery and the
//! `#[tool_router]` macro-generated request-routing code only get exercised
//! when the binary actually starts. The unit tests in `tools.rs` cover the
//! pure `resolve_workspace` logic; this test covers the protocol surface.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn fresh_workspace(label: &str, note_name: &str, body: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-mcp-multi-{label}-{nanos}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(note_name), body).unwrap();
    dir.canonicalize().unwrap()
}

fn binary_path() -> PathBuf {
    // CARGO_BIN_EXE_<name> is set by cargo for integration tests targeting
    // the named bin in this crate.
    PathBuf::from(env!("CARGO_BIN_EXE_solomd-mcp"))
}

/// Drive the server through `initialize` → `notifications/initialized` →
/// each `request`, return the matching response per id (responses for
/// notifications never come back). Frames are line-delimited JSON.
fn drive(args: &[&str], requests: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut child = Command::new(binary_path())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn solomd-mcp");

    let mut stdin = child.stdin.take().unwrap();
    // Initialize handshake.
    let init = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "p4-federation-test", "version": "0"}
        }
    });
    writeln!(stdin, "{}", init).unwrap();
    let initialized = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    writeln!(stdin, "{}", initialized).unwrap();

    // Collect ids we expect responses for.
    let mut want_ids: Vec<i64> = vec![0];
    for req in requests {
        writeln!(stdin, "{}", req).unwrap();
        if let Some(id) = req.get("id").and_then(|v| v.as_i64()) {
            want_ids.push(id);
        }
    }
    drop(stdin); // close stdin → server exits cleanly when done.

    let stdout = child.stdout.take().unwrap();
    let mut responses_by_id: std::collections::HashMap<i64, serde_json::Value> =
        std::collections::HashMap::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(id) = v.get("id").and_then(|i| i.as_i64()) {
            responses_by_id.insert(id, v);
        }
    }
    let _ = child.wait();

    // Return responses in the order the caller's requests were submitted
    // (skip the initialize response — caller doesn't ask for it explicitly).
    requests
        .iter()
        .filter_map(|req| req.get("id").and_then(|v| v.as_i64()))
        .map(|id| {
            responses_by_id
                .remove(&id)
                .unwrap_or_else(|| panic!("no response for id {id}"))
        })
        .collect()
}

#[test]
fn back_compat_single_workspace_no_arg() {
    // Exactly the v3.x invocation: one --workspace, no client-side workspace
    // arg. Must keep working unchanged.
    let ws = fresh_workspace("solo", "only.md", "# Solo\n");
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "list_notes", "arguments": {} }
    });
    let resps = drive(&["--workspace", &ws.to_string_lossy()], &[req]);
    let r = &resps[0];
    let text = extract_text_payload(r);
    assert!(
        text.contains("only.md"),
        "expected only.md in response, got: {text}"
    );
}

#[test]
fn multi_workspace_default_to_first() {
    let ws_a = fresh_workspace("mwA", "alpha.md", "# A\n");
    let ws_b = fresh_workspace("mwB", "beta.md", "# B\n");
    let arg_a = format!("wsA={}", ws_a.display());
    let arg_b = format!("wsB={}", ws_b.display());

    // No `workspace` arg → default = first = wsA.
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 11,
        "method": "tools/call",
        "params": { "name": "list_notes", "arguments": {} }
    });
    let resps = drive(
        &["--workspace", &arg_a, "--workspace", &arg_b],
        &[req.clone()],
    );
    let text = extract_text_payload(&resps[0]);
    eprintln!("default frame: {text}");
    assert!(
        text.contains("alpha.md"),
        "default workspace should serve wsA notes; got: {text}"
    );
    assert!(
        !text.contains("beta.md"),
        "default workspace must not leak wsB notes; got: {text}"
    );
}

#[test]
fn multi_workspace_explicit_alias_targets_other() {
    let ws_a = fresh_workspace("mwA2", "alpha.md", "# A\n");
    let ws_b = fresh_workspace("mwB2", "beta.md", "# B\n");
    let arg_a = format!("wsA={}", ws_a.display());
    let arg_b = format!("wsB={}", ws_b.display());

    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 21,
        "method": "tools/call",
        "params": {
            "name": "list_notes",
            "arguments": { "workspace": "wsB" }
        }
    });
    let resps = drive(
        &["--workspace", &arg_a, "--workspace", &arg_b],
        &[req],
    );
    let text = extract_text_payload(&resps[0]);
    eprintln!("alias frame: {text}");
    assert!(text.contains("beta.md"), "got: {text}");
    assert!(!text.contains("alpha.md"), "got: {text}");
}

#[test]
fn multi_workspace_absolute_path_targets_other() {
    let ws_a = fresh_workspace("mwA3", "alpha.md", "# A\n");
    let ws_b = fresh_workspace("mwB3", "beta.md", "# B\n");
    let arg_a = format!("wsA={}", ws_a.display());
    let arg_b = format!("wsB={}", ws_b.display());

    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 31,
        "method": "tools/call",
        "params": {
            "name": "list_notes",
            "arguments": { "workspace": ws_b.to_string_lossy() }
        }
    });
    let resps = drive(
        &["--workspace", &arg_a, "--workspace", &arg_b],
        &[req],
    );
    let text = extract_text_payload(&resps[0]);
    eprintln!("abspath frame: {text}");
    assert!(text.contains("beta.md"), "got: {text}");
}

#[test]
fn multi_workspace_unknown_alias_errors() {
    let ws_a = fresh_workspace("mwA4", "alpha.md", "# A\n");
    let ws_b = fresh_workspace("mwB4", "beta.md", "# B\n");
    let arg_a = format!("wsA={}", ws_a.display());
    let arg_b = format!("wsB={}", ws_b.display());

    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 41,
        "method": "tools/call",
        "params": {
            "name": "list_notes",
            "arguments": { "workspace": "nope" }
        }
    });
    let resps = drive(
        &["--workspace", &arg_a, "--workspace", &arg_b],
        &[req],
    );
    let resp = &resps[0];
    eprintln!("unknown frame: {resp}");
    // Two valid encodings depending on whether the macro maps it to a
    // protocol-level error or a tool-level error frame: check both.
    let serialized = serde_json::to_string(resp).unwrap();
    assert!(
        serialized.contains("unknown workspace"),
        "expected unknown-workspace error, got: {serialized}"
    );
    assert!(
        serialized.contains("wsA") && serialized.contains("wsB"),
        "error should enumerate available aliases, got: {serialized}"
    );
}

/// Pull the human-readable text payload out of a `tools/call` response,
/// regardless of whether rmcp returned the JSON content as a `text` block
/// or a `json` block. Falls back to the whole serialized response if the
/// shape is unfamiliar so test failures still print something useful.
fn extract_text_payload(resp: &serde_json::Value) -> String {
    if let Some(content) = resp.pointer("/result/content").and_then(|c| c.as_array()) {
        let mut out = String::new();
        for item in content {
            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                out.push_str(t);
                out.push('\n');
            } else if item.get("type").and_then(|v| v.as_str()) == Some("json") {
                out.push_str(&serde_json::to_string(item).unwrap_or_default());
                out.push('\n');
            } else {
                // Some encodings put the JSON under a `data` field.
                out.push_str(&serde_json::to_string(item).unwrap_or_default());
                out.push('\n');
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    serde_json::to_string(resp).unwrap_or_default()
}
