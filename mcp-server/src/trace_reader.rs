//! v4.0 Pillar 3 — slim `trace.jsonl` reader for the external MCP server.
//!
//! This is intentionally a duplicate of the read-side of
//! `app/src-tauri/src/trace.rs` — about 30 lines — so the `solomd-mcp`
//! crate stays self-contained and doesn't need a path dep into the
//! desktop app's source tree. The schema is pinned by contracts C2; if
//! it changes, both files change. `tools.rs` imports `is_safe_run_id` and
//! `read_trace` from this module.
//!
//! We deliberately don't share types beyond `serde_json::Value` here —
//! the MCP wire is JSON anyway, so the read just produces a vector of
//! generic JSON objects. The fully-typed parse lives in the app crate.

use std::io;
use std::path::Path;

/// Same predicate as `agent_trace::is_safe_run_id` in the app crate.
/// Restated here so the MCP server doesn't path-dep on `app_lib`.
pub fn is_safe_run_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Parse `<run_dir>/trace.jsonl` into a vector of generic JSON objects.
/// Tolerates malformed lines (skipped + warned) so a partial / crashed
/// run is still inspectable.
pub fn read_trace(run_dir: &Path) -> io::Result<Vec<serde_json::Value>> {
    let path = run_dir.join("trace.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(v) => out.push(v),
            Err(e) => {
                tracing::warn!(line_no = i + 1, err = %e, "trace_reader: skipping malformed line");
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fresh_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("solomd-mcp-trace-{label}-{nanos}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn run_id_validation_matches_app_crate() {
        // These mirror the app-crate test cases so divergence is loud.
        assert!(!is_safe_run_id(""));
        assert!(!is_safe_run_id("../escape"));
        assert!(!is_safe_run_id("a/b"));
        assert!(is_safe_run_id("20260430-142307-a3f9c1"));
    }

    #[test]
    fn reads_known_fixture_layout() {
        // Same fixture structure the app-crate test uses (without sharing
        // the file). We hand-write the expected lines and verify the
        // reader returns them in order, including skipping the malformed
        // middle line.
        let dir = fresh_dir("readok");
        let body = r#"{"ts":1,"run_id":"r","seq":1,"kind":"run_started","run_kind":"panel","provider":"anthropic","model":"claude-sonnet-4-6"}
{"ts":2,"run_id":"r","seq":2,"kind":"prompt","role":"user","content":"hi"}
this line is malformed and must be skipped
{"ts":3,"run_id":"r","seq":3,"kind":"tool_call","tool":"read_note","tool_call_id":"tc_a1","args":{"path":"x.md"}}
{"ts":4,"run_id":"r","seq":4,"kind":"run_ended","status":"ok","tokens_in_total":10,"tokens_out_total":5,"cost_usd_estimate":0.001}
"#;
        fs::write(dir.join("trace.jsonl"), body).unwrap();
        let lines = read_trace(&dir).unwrap();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["kind"], "run_started");
        assert_eq!(lines[2]["kind"], "tool_call");
        assert_eq!(lines[2]["tool"], "read_note");
        assert_eq!(lines[3]["kind"], "run_ended");
    }

    #[test]
    fn missing_file_returns_empty() {
        let dir = fresh_dir("missing");
        let lines = read_trace(&dir).unwrap();
        assert!(lines.is_empty());
    }
}
