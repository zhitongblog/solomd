//! v4.0 Pillar 3 — end-to-end self-test for the trace pipeline.
//!
//! Goes through the full producer → on-disk → reader path the way the
//! Panel will use it at runtime:
//!   1. `Emitter::open` against a fresh `<workspace>/.solomd/agent-runs/<run_id>/`
//!   2. Emit a realistic chat run (run_started, prompt, tool call+result,
//!      model_done, run_ended).
//!   3. `read_trace` round-trips every line.
//!   4. `replay_prefix` returns the right slice.
//!
//! This stays in `tests/` (an integration test target) so it exercises
//! the public `app_lib` API exactly as the Tauri commands do.

use app_lib::trace::{self, Emitter, RunKind};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn fresh_run_dir(label: &str) -> (PathBuf, String) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let workspace =
        std::env::temp_dir().join(format!("solomd-trace-e2e-{label}-{nanos}"));
    let run_id = format!("20260430-142307-{:06x}", (nanos & 0xFFFFFF) as u32);
    let dir = workspace
        .join(".solomd")
        .join("agent-runs")
        .join(&run_id);
    fs::create_dir_all(&dir).unwrap();
    (dir, run_id)
}

#[test]
fn end_to_end_panel_chat_run() {
    let (dir, run_id) = fresh_run_dir("e2e-chat");

    // Producer side — what P1's panel runner will do post-merge.
    {
        let em = Emitter::open(&dir, run_id.clone()).unwrap();
        em.run_started(RunKind::Panel, "anthropic", "claude-sonnet-4-6", None, None)
            .unwrap();
        em.prompt("user", "Summarize daily/2026-04-29.md").unwrap();
        em.model_call("anthropic", "claude-sonnet-4-6", 1, 4).unwrap();
        em.tool_call(
            "read_note",
            "tc_aaa",
            &serde_json::json!({"path": "daily/2026-04-29.md"}),
        )
        .unwrap();
        em.tool_result("tc_aaa", "# 2026-04-29\n- shipped v4 panel\n", None)
            .unwrap();
        em.model_done("You shipped v4 panel.", 110, 14, "stop").unwrap();
        em.run_ended("ok", 110, 14, 0.00033, None).unwrap();
    }

    // Reader side — what the TraceView and MCP read_agent_trace do.
    let lines = trace::read_trace(&dir).unwrap();
    assert_eq!(lines.len(), 7);
    assert_eq!(lines[0].kind, "run_started");
    assert_eq!(lines[0].run_id, run_id);
    assert_eq!(lines[3].kind, "tool_call");
    assert_eq!(
        lines[3].payload.get("tool_call_id").and_then(|v| v.as_str()),
        Some("tc_aaa"),
    );
    assert_eq!(lines[4].kind, "tool_result");
    assert_eq!(lines[6].kind, "run_ended");

    // Replay-prefix slice for "replay from the model_done turn" (seq 6)
    // should give us run_started + prompt + model_call + tool_call +
    // tool_result (5 lines, seqs 1..=5).
    let prefix = trace::replay_prefix(&dir, 6).unwrap();
    assert_eq!(prefix.len(), 5);
    assert_eq!(prefix.last().unwrap().seq, 5);
    assert_eq!(prefix.last().unwrap().kind, "tool_result");
}

#[test]
fn end_to_end_truncates_giant_tool_result() {
    let (dir, run_id) = fresh_run_dir("e2e-trunc");
    let em = Emitter::open(&dir, run_id).unwrap();
    em.run_started(RunKind::Panel, "anthropic", "claude-sonnet-4-6", None, None)
        .unwrap();
    let huge = "A".repeat(10_000);
    em.tool_result("tc_big", &huge, None).unwrap();

    let lines = trace::read_trace(&dir).unwrap();
    let res = lines.iter().find(|l| l.kind == "tool_result").unwrap();
    assert_eq!(
        res.payload.get("truncated").and_then(|v| v.as_bool()),
        Some(true)
    );
    let on_disk = res.payload.get("result").and_then(|v| v.as_str()).unwrap();
    // Stored payload is exactly 2048 chars + the 12-char marker — no more.
    assert_eq!(on_disk.chars().count(), 2048 + "…(truncated)".chars().count());
    // result_bytes preserves the original size so a UI can show "10,000 B".
    assert_eq!(
        res.payload.get("result_bytes").and_then(|v| v.as_u64()),
        Some(10_000)
    );
}
