//! v4.0 pillar 1 — agent_tools integration tests.
//!
//! Drives `dispatch_tool_inner` against a real on-disk workspace so the
//! C3.1 contract surface (list_notes, read_note, search, write_note,
//! get_outline, get_backlinks, list_tags, append_to_note) is exercised
//! end-to-end without mocking the filesystem.
//!
//! Self-test obligation per /tmp/solomd-v4-contracts.md C7: this test is the
//! Rust integration test the panel agent ships with.

use app_lib::agent_tools::dispatch_tool_inner;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn make_workspace(label: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "solomd-agent-tools-e2e-{}-{}-{}",
        label,
        std::process::id(),
        stamp
    ));
    fs::create_dir_all(&dir).unwrap();

    fs::write(
        dir.join("Welcome.md"),
        "---\ntitle: Welcome\ntags: [intro, demo]\n---\n# Welcome\n\n\
         First paragraph mentions banana.\n\n## Subsection\n\nSee [[Daily/2026-04-30]].\n",
    )
    .unwrap();
    fs::create_dir_all(dir.join("Daily")).unwrap();
    fs::write(
        dir.join("Daily/2026-04-30.md"),
        "# Today\n\n#topic\n\nA needle line about apples.\n\n[[Welcome]]\n",
    )
    .unwrap();
    fs::create_dir_all(dir.join(".solomd")).unwrap();
    dir
}

#[test]
fn list_notes_returns_seed_files() {
    let ws = make_workspace("list");
    let res: Value = dispatch_tool_inner(&ws, "list_notes", json!({})).unwrap();
    let count = res["count"].as_u64().unwrap();
    assert!(count >= 2, "expected ≥2 notes, got {count}");
    let names: Vec<String> = res["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(names.iter().any(|n| n == "Welcome.md"));
    assert!(names.iter().any(|n| n == "2026-04-30.md"));
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn list_notes_scoped_by_folder() {
    let ws = make_workspace("list-folder");
    let res: Value = dispatch_tool_inner(&ws, "list_notes", json!({"folder": "Daily"})).unwrap();
    let count = res["count"].as_u64().unwrap();
    assert_eq!(count, 1, "Daily should have exactly 1 note: {res}");
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn read_note_round_trips_frontmatter_and_links() {
    let ws = make_workspace("read");
    let res: Value =
        dispatch_tool_inner(&ws, "read_note", json!({"path": "Welcome.md"})).unwrap();
    assert_eq!(res["frontmatter"]["title"], "Welcome");
    let tags: Vec<String> = res["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert!(tags.contains(&"intro".to_string()));
    assert!(tags.contains(&"demo".to_string()));
    assert!(res["content"]
        .as_str()
        .unwrap()
        .contains("First paragraph"));
    let wl = res["wikilinks"].as_array().unwrap();
    assert_eq!(wl.len(), 1);
    assert_eq!(wl[0]["target"], "Daily/2026-04-30");
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn search_finds_literal_match() {
    let ws = make_workspace("search");
    let res: Value =
        dispatch_tool_inner(&ws, "search", json!({"query": "needle"})).unwrap();
    assert!(res["count"].as_u64().unwrap() >= 1);
    let hit = &res["hits"][0];
    assert!(hit["snippet"].as_str().unwrap().to_lowercase().contains("needle"));
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn write_note_creates_file_and_refuses_clobber() {
    let ws = make_workspace("write");

    let res: Value = dispatch_tool_inner(
        &ws,
        "write_note",
        json!({"path": "weekly/2026-W17.md", "content": "# Weekly review\n\nHi.\n"}),
    )
    .unwrap();
    assert_eq!(res["ok"], true);
    assert!(ws.join("weekly/2026-W17.md").exists());

    // Default refuses to clobber.
    let dup = dispatch_tool_inner(
        &ws,
        "write_note",
        json!({"path": "weekly/2026-W17.md", "content": "x"}),
    );
    assert!(dup.is_err(), "expected refusal w/o allow_overwrite");

    // With allow_overwrite, succeeds.
    let ok: Value = dispatch_tool_inner(
        &ws,
        "write_note",
        json!({
            "path": "weekly/2026-W17.md",
            "content": "# v2\n",
            "allow_overwrite": true,
        }),
    )
    .unwrap();
    assert_eq!(ok["ok"], true);
    let raw = fs::read_to_string(ws.join("weekly/2026-W17.md")).unwrap();
    assert_eq!(raw, "# v2\n");
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn append_to_note_extends_existing_file() {
    let ws = make_workspace("append");
    let target = "Daily/2026-04-30.md";
    let before = fs::read_to_string(ws.join(target)).unwrap();
    let res: Value = dispatch_tool_inner(
        &ws,
        "append_to_note",
        json!({"path": target, "content": "\n## Appended\n"}),
    )
    .unwrap();
    assert_eq!(res["ok"], true);
    let after = fs::read_to_string(ws.join(target)).unwrap();
    assert!(after.starts_with(&before));
    assert!(after.ends_with("## Appended\n"));
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn get_outline_returns_heading_tree() {
    let ws = make_workspace("outline");
    let res: Value =
        dispatch_tool_inner(&ws, "get_outline", json!({"path": "Welcome.md"})).unwrap();
    let outline = res["outline"].as_array().unwrap();
    assert!(!outline.is_empty());
    let texts: Vec<String> = outline
        .iter()
        .map(|h| h["text"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(texts.contains(&"Welcome".to_string()));
    assert!(texts.contains(&"Subsection".to_string()));
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn list_tags_aggregates_counts() {
    let ws = make_workspace("tags");
    let res: Value = dispatch_tool_inner(&ws, "list_tags", json!({})).unwrap();
    let tags = res["tags"].as_array().unwrap();
    let names: Vec<String> = tags
        .iter()
        .map(|v| v["tag"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(names.contains(&"intro".to_string()));
    assert!(names.contains(&"demo".to_string()));
    assert!(names.contains(&"topic".to_string()));
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn get_backlinks_finds_referencing_notes() {
    let ws = make_workspace("backlinks");
    let res: Value =
        dispatch_tool_inner(&ws, "get_backlinks", json!({"note_name": "Welcome"})).unwrap();
    let count = res["count"].as_u64().unwrap();
    assert_eq!(count, 1, "exactly one note links to Welcome: {res}");
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn unknown_tool_errors() {
    let ws = make_workspace("unknown");
    let res = dispatch_tool_inner(&ws, "nope_not_a_tool", json!({}));
    assert!(res.is_err());
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn workspace_traversal_blocked() {
    let ws = make_workspace("escape");
    let res = dispatch_tool_inner(&ws, "read_note", json!({"path": "../escape.md"}));
    assert!(res.is_err(), "should refuse traversal: {:?}", res);
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn read_agent_trace_parses_stored_steps() {
    use app_lib::agent_run::{RunHandle, RunKind, TraceStep};
    let ws = make_workspace("trace");
    let h = RunHandle::start(&ws, RunKind::Panel, "anthropic", "claude-test", None).unwrap();
    h.append_trace(TraceStep {
        kind: "prompt".to_string(),
        role: Some("user".to_string()),
        content: Some("hello".to_string()),
        ..Default::default()
    })
    .unwrap();
    h.finish("ok", 0, 0, 0.0, None).unwrap();

    let run_id = h.run_id.clone();
    let res: Value =
        dispatch_tool_inner(&ws, "read_agent_trace", json!({"run_id": run_id})).unwrap();
    let steps = res["steps"].as_array().unwrap();
    assert!(steps.len() >= 3);
    assert_eq!(steps[0]["kind"], "run_started");
    let last = steps.last().unwrap();
    assert_eq!(last["kind"], "run_ended");
    let _ = fs::remove_dir_all(&ws);
}
