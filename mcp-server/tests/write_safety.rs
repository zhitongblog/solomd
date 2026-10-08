//! Write gating, driven through the real binary over stdio.
//!
//! Pins down the 5.0 regression findings: `export_note` used to write (and
//! overwrite) files outside the workspace on a server started without
//! `--allow-write`; `write_note` accepted any extension and could not
//! create folders; `read_agent_trace` answered an unknown run id with an
//! empty success; `get_backlinks` / `get_outline` counted lines from the
//! end of the front matter while `list_tasks` and `search` counted from
//! the top of the file.
//!
//! The export tests that need the Node backend skip themselves when `node`
//! or `app/scripts/solomd-export.mjs` is missing. The refusal tests never
//! need it: without `--allow-write` nothing may be written either way.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn binary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_solomd-mcp"))
}

fn export_script() -> Option<PathBuf> {
    let c = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../app/scripts/solomd-export.mjs");
    c.is_file().then(|| c.canonicalize().unwrap())
}

/// Can `export_note` actually run here? Needs node and the app's deps.
fn export_available() -> bool {
    let Some(script) = export_script() else { return false };
    let deps = script.parent().unwrap().join("../node_modules/docx");
    let node = Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    node && deps.exists()
}

fn fresh_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-mcp-ws-{label}-{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// `initialize`, then one `tools/call` per `(name, args)`; returns the
/// response frames in order.
fn call(workspace: &Path, allow_write: bool, calls: &[(&str, serde_json::Value)]) -> Vec<serde_json::Value> {
    let mut cmd = Command::new(binary_path());
    cmd.arg("--workspace").arg(workspace);
    if allow_write {
        cmd.arg("--allow-write");
    }
    if let Some(script) = export_script() {
        cmd.env("SOLOMD_EXPORT_SCRIPT", script);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn solomd-mcp");
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":0,"method":"initialize","params":{{"protocolVersion":"2025-11-25","capabilities":{{}},"clientInfo":{{"name":"write-safety","version":"0"}}}}}}"#).unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#).unwrap();
    for (i, (name, args)) in calls.iter().enumerate() {
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": i + 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": args }
        });
        writeln!(stdin, "{req}").unwrap();
    }
    drop(stdin);
    let mut by_id = std::collections::HashMap::new();
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(id) = v.get("id").and_then(|i| i.as_i64()) {
                by_id.insert(id, v);
            }
        }
    }
    let _ = child.wait();
    (1..=calls.len() as i64)
        .map(|id| by_id.remove(&id).unwrap_or_else(|| panic!("no response for id {id}")))
        .collect()
}

fn error_message(frame: &serde_json::Value) -> String {
    frame
        .pointer("/error/message")
        .and_then(|m| m.as_str())
        .unwrap_or_else(|| panic!("expected an error frame, got: {frame}"))
        .to_string()
}

fn payload(frame: &serde_json::Value) -> serde_json::Value {
    let text = frame
        .pointer("/result/content/0/text")
        .and_then(|t| t.as_str())
        .unwrap_or_else(|| panic!("expected a result frame, got: {frame}"));
    serde_json::from_str(text).unwrap()
}

#[test]
fn export_note_refuses_every_write_without_flag() {
    let ws = fresh_dir("ro");
    let outside = fresh_dir("ro-outside");
    std::fs::write(ws.join("note.md"), "# Note\n\nbody\n").unwrap();
    let precious = outside.join("precious.txt");
    std::fs::write(&precious, "IMPORTANT USER DATA\n").unwrap();

    let frames = call(
        &ws,
        false,
        &[
            // Outside, overwriting an existing file (the original bug).
            ("export_note", serde_json::json!({"path": "note.md", "format": "txt", "output_path": precious.to_string_lossy()})),
            // Outside, new file — and even with overwrite: true.
            ("export_note", serde_json::json!({"path": "note.md", "format": "html", "output_path": outside.join("new.html").to_string_lossy(), "overwrite": true})),
            // Inside, explicit and default sibling paths.
            ("export_note", serde_json::json!({"path": "note.md", "format": "html", "output_path": "inside.html"})),
            ("export_note", serde_json::json!({"path": "note.md", "format": "docx"})),
        ],
    );
    for f in &frames {
        let msg = error_message(f);
        if export_available() {
            assert!(msg.contains("--allow-write"), "expected the allow-write guard, got: {msg}");
        }
    }
    assert_eq!(std::fs::read_to_string(&precious).unwrap(), "IMPORTANT USER DATA\n");
    assert!(!outside.join("new.html").exists());
    assert!(!ws.join("inside.html").exists());
    assert!(!ws.join("note.docx").exists());
}

#[test]
fn export_note_with_flag_writes_but_never_overwrites_silently() {
    if !export_available() {
        eprintln!("skipping: node or app/node_modules not available");
        return;
    }
    let ws = fresh_dir("rw");
    let outside = fresh_dir("rw-outside");
    std::fs::write(ws.join("note.md"), "# Note\n\nfresh body\n").unwrap();
    let precious = outside.join("precious.txt");
    std::fs::write(&precious, "IMPORTANT USER DATA\n").unwrap();
    let new_out = outside.join("new.html");

    let frames = call(
        &ws,
        true,
        &[
            ("export_note", serde_json::json!({"path": "note.md", "format": "html", "output_path": new_out.to_string_lossy()})),
            ("export_note", serde_json::json!({"path": "note.md", "format": "txt", "output_path": precious.to_string_lossy()})),
            ("export_note", serde_json::json!({"path": "note.md", "format": "html", "output_path": "exports/deep/note.html"})),
            ("export_note", serde_json::json!({"path": "note.md", "format": "txt", "output_path": precious.to_string_lossy(), "overwrite": true})),
            ("export_note", serde_json::json!({"path": "note.md", "format": "html", "output_path": outside.join("no/such/dir/x.html").to_string_lossy()})),
            ("export_note", serde_json::json!({"path": "note.md", "format": "md", "output_path": "note.md", "overwrite": true})),
        ],
    );

    assert!(frames[0].get("error").is_none(), "new outside file should be written: {}", frames[0]);
    assert!(std::fs::read_to_string(&new_out).unwrap().contains("fresh body"));

    let msg = error_message(&frames[1]);
    assert!(msg.contains("overwrite"), "got: {msg}");
    assert!(frames[2].get("error").is_none(), "inside export into new folders: {}", frames[2]);
    assert!(ws.join("exports/deep/note.html").is_file());

    assert!(frames[3].get("error").is_none(), "overwrite:true should replace: {}", frames[3]);
    assert!(std::fs::read_to_string(&precious).unwrap().contains("fresh body"));

    assert!(error_message(&frames[4]).contains("folder does not exist"));
    assert!(!outside.join("no").exists(), "must not create folders outside the workspace");
    assert!(error_message(&frames[5]).contains("source note"));
}

#[test]
fn write_note_accepts_notes_only_and_creates_folders() {
    let ws = fresh_dir("write");
    let frames = call(
        &ws,
        true,
        &[
            ("write_note", serde_json::json!({"path": "evil.sh", "content": "rm -rf ~"})),
            ("write_note", serde_json::json!({"path": "projects/alpha/plan.md", "content": "# Plan\n"})),
            ("write_note", serde_json::json!({"path": "notes.TXT", "content": "plain"})),
            ("write_note", serde_json::json!({"path": "../escape.md", "content": "x"})),
        ],
    );
    assert!(error_message(&frames[0]).contains(".md"));
    assert!(!ws.join("evil.sh").exists());
    assert!(frames[1].get("error").is_none(), "{}", frames[1]);
    assert_eq!(std::fs::read_to_string(ws.join("projects/alpha/plan.md")).unwrap(), "# Plan\n");
    assert!(frames[2].get("error").is_none(), "{}", frames[2]);
    assert!(error_message(&frames[3]).contains(".."));
}

#[test]
fn read_agent_trace_unknown_run_is_an_error() {
    let ws = fresh_dir("trace");
    let run = ws.join(".solomd/agent-runs/known-run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("trace.jsonl"), "{\"ts\":1,\"seq\":1,\"kind\":\"run_started\"}\n").unwrap();
    let frames = call(
        &ws,
        false,
        &[
            ("read_agent_trace", serde_json::json!({"run_id": "no-such-run"})),
            ("read_agent_trace", serde_json::json!({"run_id": "known-run"})),
        ],
    );
    assert!(error_message(&frames[0]).contains("not found"));
    assert_eq!(payload(&frames[1])["count"], 1);
}

/// One fixture, every tool that reports a line: they must all agree.
#[test]
fn line_numbers_are_file_lines_across_tools() {
    let ws = fresh_dir("lines");
    std::fs::write(
        ws.join("index.md"),
        "---\ntitle: Index\ntags: [home]\ncreated: 2026-10-01\n---\n# Vault Index\n\nWelcome. See [[Project Alpha]].\n\n## Tasks\n- [ ] Review [[Project Alpha]] soon\n",
    )
    .unwrap();
    std::fs::write(ws.join("Project Alpha.md"), "# Project Alpha\n").unwrap();

    let frames = call(
        &ws,
        false,
        &[
            ("get_backlinks", serde_json::json!({"note_name": "Project Alpha"})),
            ("get_outline", serde_json::json!({"path": "index.md"})),
            ("read_note", serde_json::json!({"path": "index.md"})),
            ("list_tasks", serde_json::json!({})),
            ("search", serde_json::json!({"query": "Review"})),
        ],
    );

    let backlinks = payload(&frames[0]);
    let lines: Vec<u64> = backlinks["backlinks"].as_array().unwrap().iter().map(|b| b["line"].as_u64().unwrap()).collect();
    assert_eq!(lines, vec![8, 11]);
    for b in backlinks["backlinks"].as_array().unwrap() {
        let ctx: Vec<&str> = b["context"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
        assert!(ctx.iter().any(|l| l.contains("[[Project Alpha]]")), "context must hold the link line: {ctx:?}");
        assert!(!ctx.iter().any(|l| l.starts_with("title:")), "context leaked front matter: {ctx:?}");
    }

    let outline = payload(&frames[1]);
    let heads: Vec<(String, u64)> = outline["outline"].as_array().unwrap().iter()
        .map(|h| (h["text"].as_str().unwrap().to_string(), h["line"].as_u64().unwrap())).collect();
    assert_eq!(heads, vec![("Vault Index".to_string(), 6), ("Tasks".to_string(), 10)]);

    let note = payload(&frames[2]);
    assert_eq!(note["headings"][0]["line"], 6);
    assert_eq!(note["wikilinks"][0]["line"], 8);

    let tasks = payload(&frames[3]);
    assert_eq!(tasks["tasks"][0]["line"], 11);
    let hits = payload(&frames[4]);
    assert_eq!(hits["hits"][0]["line"], 11);
}

/// Columns count characters, so CJK before the match doesn't inflate them.
#[test]
fn search_column_counts_characters() {
    let ws = fresh_dir("cjk");
    std::fs::write(ws.join("d.md"), "今天做回归测试\n").unwrap();
    let frames = call(&ws, false, &[("search", serde_json::json!({"query": "回归"}))]);
    // 今天做 is three characters (nine bytes): the match starts at column 4.
    assert_eq!(payload(&frames[0])["hits"][0]["column"], 4);
}

/// Without its Node backend `export_note` is not advertised at all — the
/// installed app ships neither node nor the export script.
#[test]
fn export_note_is_hidden_without_node() {
    let ws = fresh_dir("hidden");
    let list = |path_env: Option<&str>| -> Vec<String> {
        let mut cmd = Command::new(binary_path());
        cmd.arg("--workspace").arg(&ws);
        if let Some(p) = path_env {
            cmd.env("PATH", p);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn solomd-mcp");
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, r#"{{"jsonrpc":"2.0","id":0,"method":"initialize","params":{{"protocolVersion":"2025-11-25","capabilities":{{}},"clientInfo":{{"name":"hidden","version":"0"}}}}}}"#).unwrap();
        writeln!(stdin, r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#).unwrap();
        writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"tools/list"}}"#).unwrap();
        drop(stdin);
        let mut names = Vec::new();
        for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("id").and_then(|i| i.as_i64()) == Some(1) {
                for t in v.pointer("/result/tools").and_then(|t| t.as_array()).unwrap() {
                    names.push(t["name"].as_str().unwrap().to_string());
                }
            }
        }
        let _ = child.wait();
        names
    };
    // An empty PATH means no `node`, whatever else is on disk.
    let hidden = list(Some(""));
    assert_eq!(hidden.len(), 15, "got: {hidden:?}");
    assert!(!hidden.iter().any(|n| n == "export_note"));
    if export_available() {
        let shown = list(None);
        assert_eq!(shown.len(), 16, "got: {shown:?}");
        assert!(shown.iter().any(|n| n == "export_note"));
    }
}
