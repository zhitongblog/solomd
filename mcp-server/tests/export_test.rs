//! v4.1 regression test for the `export_note` MCP tool — closes the
//! v4.0.2-surfaced gap where docx export was untestable from CI.
//!
//! Specifically: a Markdown blockquote MUST appear as text in the
//! exported .docx's `word/document.xml`. Pre-v4.0.2 the in-app docx
//! pipeline silently dropped blockquote content (rendered as empty
//! bordered paragraphs). This test would have caught it at PR time.
//!
//! Spawns the actual `solomd-mcp` binary, drives `export_note` over
//! stdio JSON-RPC, then unzips the resulting .docx + greps document.xml.
//!
//! Skipped automatically when `node` isn't on PATH or when
//! `app/scripts/solomd-export.mjs` can't be located.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn binary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_solomd-mcp"))
}

/// Locate `app/scripts/solomd-export.mjs` from the test process's cwd
/// (which cargo sets to the crate dir, i.e. `mcp-server/`). Walk up to
/// the repo root.
fn find_export_script() -> Option<PathBuf> {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        crate_dir.join("../app/scripts/solomd-export.mjs"),
        crate_dir.join("../../app/scripts/solomd-export.mjs"),
    ];
    for c in &candidates {
        if c.is_file() {
            return c.canonicalize().ok();
        }
    }
    None
}

fn have_node() -> bool {
    Command::new("node")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn fresh_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-mcp-export-{label}-{nanos}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// Drive an `initialize` → `export_note` round-trip and return the
/// matching response frame.
fn drive_export(workspace: &Path, args_json: serde_json::Value, script_path: &Path) -> serde_json::Value {
    let mut child = Command::new(binary_path())
        .arg("--workspace").arg(workspace)
        .env("SOLOMD_EXPORT_SCRIPT", script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn solomd-mcp");
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":0,"method":"initialize","params":{{"protocolVersion":"2025-11-25","capabilities":{{}},"clientInfo":{{"name":"export-test","version":"0"}}}}}}"#).unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#).unwrap();
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "export_note", "arguments": args_json }
    });
    writeln!(stdin, "{}", req).unwrap();
    drop(stdin);
    let stdout = child.stdout.take().unwrap();
    let mut found = serde_json::Value::Null;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("id").and_then(|i| i.as_i64()) == Some(1) {
            found = v;
            break;
        }
    }
    let _ = child.wait();
    found
}

/// Read `word/document.xml` from a docx (zip) on disk.
fn extract_document_xml(docx_path: &Path) -> String {
    let f = std::fs::File::open(docx_path).expect("open docx");
    let mut zip = zip::ZipArchive::new(f).expect("zip parse");
    let mut entry = zip.by_name("word/document.xml").expect("document.xml in docx");
    let mut s = String::new();
    entry.read_to_string(&mut s).expect("read document.xml");
    s
}

/// Pre-v4.0.2 regression: blockquote content was silently dropped
/// from docx export (the in-app code emitted empty bordered paragraphs
/// because it tried to read `Paragraph.options.children` which the
/// `docx` library doesn't expose publicly). This test asserts the
/// fix stays fixed.
#[test]
fn export_note_docx_preserves_blockquote_text() {
    let Some(script) = find_export_script() else {
        eprintln!("skipping: app/scripts/solomd-export.mjs not found");
        return;
    };
    if !have_node() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let ws = fresh_dir("blockquote");
    let out_dir = fresh_dir("blockquote-out");
    std::fs::write(
        ws.join("note.md"),
        "# Document\n\nNormal paragraph.\n\n> first quoted line\n> second quoted line\n\nAfter the quote.\n",
    ).unwrap();
    let out = out_dir.join("note.docx");

    let resp = drive_export(
        &ws,
        serde_json::json!({
            "path": "note.md",
            "format": "docx",
            "output_path": out.to_string_lossy(),
        }),
        &script,
    );

    assert!(resp.get("error").is_none(), "export_note returned an error: {resp}");
    assert!(out.exists(), "docx output not written: {}", out.display());

    let xml = extract_document_xml(&out);
    assert!(xml.contains("first quoted line"), "blockquote line 1 missing from document.xml; got len={}", xml.len());
    assert!(xml.contains("second quoted line"), "blockquote line 2 missing from document.xml");
    assert!(xml.contains("Normal paragraph"), "non-quoted text also missing — likely a broader regression");
    assert!(xml.contains("After the quote"), "post-blockquote paragraph missing");
}

/// Sanity: the simpler html path should also include the blockquote text
/// (markdown-it's html: true config means our tweak from #54 is also
/// covered here).
#[test]
fn export_note_html_preserves_blockquote_text() {
    let Some(script) = find_export_script() else {
        return;
    };
    if !have_node() {
        return;
    }
    let ws = fresh_dir("html");
    let out_dir = fresh_dir("html-out");
    std::fs::write(ws.join("note.md"), "# T\n\n> hello quoted\n").unwrap();
    let out = out_dir.join("note.html");

    let resp = drive_export(
        &ws,
        serde_json::json!({
            "path": "note.md",
            "format": "html",
            "output_path": out.to_string_lossy(),
        }),
        &script,
    );

    assert!(resp.get("error").is_none(), "export_note returned an error: {resp}");
    let html = std::fs::read_to_string(&out).expect("read html");
    assert!(html.contains("hello quoted"), "blockquote text missing from html");
    assert!(html.contains("<blockquote"), "no <blockquote> element in html");
}

/// Safety guard: writing INSIDE the workspace requires --allow-write.
#[test]
fn export_note_rejects_workspace_internal_write_without_flag() {
    let Some(script) = find_export_script() else {
        return;
    };
    if !have_node() {
        return;
    }
    let ws = fresh_dir("guard");
    std::fs::write(ws.join("note.md"), "# T\n").unwrap();

    let resp = drive_export(
        &ws,
        serde_json::json!({
            "path": "note.md",
            "format": "docx",
            "output_path": ws.join("inside.docx").to_string_lossy(),
        }),
        &script,
    );
    let err = resp.get("error").unwrap_or(&serde_json::Value::Null);
    let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("");
    assert!(msg.contains("allow-write"), "expected allow-write guard, got: {err}");
}
