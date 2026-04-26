//! End-to-end test for the v2.4 HTTP capture endpoint.
//!
//! Drives the public `capture_endpoint` API directly without spinning up a
//! Tauri app — same shape as `git_history_e2e_test.rs`. Covers:
//!   * unauth POST returns 401 (auth_ok false)
//!   * valid POST writes a file with the expected front matter + body
//!   * POST with no workspace selected returns the NoWorkspace error
//!   * regenerate-token rotation invalidates the old token
//!
//! These tests share a single global `STATE` (Mutex inside the
//! capture_endpoint module) — so we serialize them ourselves with a
//! per-test-binary lock. Without this, cargo test's parallel runner
//! would race two tests that both seed the global state.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

static SERIALIZE: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    // Recover from a poisoned lock (a panic in a previous test would
    // otherwise mark every subsequent test as failed even though the
    // assertion that panicked was unrelated to lock contention).
    SERIALIZE.lock().unwrap_or_else(|e| e.into_inner())
}

use app_lib::capture_endpoint::{
    capture_get_state, capture_regenerate_token, capture_set_inbox_folder,
    capture_write_inner, local_iso8601_now, CaptureError, _test_bind_and_serve,
    _test_check_auth, _test_current_token, _test_handle_capture, _test_set_state,
};

fn fresh_workspace(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-capture-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn full_capture_flow() {
    let _g = lock();
    let ws = fresh_workspace("full");

    // ------------------------------------------------------------------
    // (1) Set state: workspace + token. Inbox folder default ("inbox").
    // ------------------------------------------------------------------
    _test_set_state(Some(ws.clone()), "secret-token-abc".to_string(), "inbox".to_string());
    let snap = capture_get_state();
    assert_eq!(snap.token, "secret-token-abc");
    assert_eq!(snap.inbox_folder, "inbox");
    assert!(snap.enabled);

    // ------------------------------------------------------------------
    // (2) Auth check: missing/wrong header rejected; correct header passes.
    // ------------------------------------------------------------------
    assert!(!_test_check_auth(None), "no header should fail");
    assert!(
        !_test_check_auth(Some("Bearer wrong-token")),
        "wrong token should fail"
    );
    assert!(
        _test_check_auth(Some("Bearer secret-token-abc")),
        "right token should pass"
    );
    // Case-insensitive scheme.
    assert!(_test_check_auth(Some("bearer secret-token-abc")));

    // ------------------------------------------------------------------
    // (3) Valid request creates a file with the right front matter + body.
    // ------------------------------------------------------------------
    let body = serde_json::json!({
        "title": "Hello from curl",
        "content": "# Hello from curl\n\nThis is the body.\n",
        "url": "https://example.com/article",
        "tags": ["clipped", "research"],
        "inbox": true,
    });
    let path = _test_handle_capture(body.to_string().as_bytes()).expect("capture write");
    let p = PathBuf::from(&path);
    assert!(p.exists(), "file should exist on disk: {path}");
    assert!(p.starts_with(ws.join("inbox")), "should land in inbox/");
    assert!(p.file_name().unwrap().to_string_lossy().ends_with(".md"));

    let raw = fs::read_to_string(&p).expect("read created note");
    assert!(raw.starts_with("---\n"), "front matter required");
    assert!(raw.contains("title: Hello from curl\n"));
    assert!(raw.contains("source: https://example.com/article\n"));
    assert!(raw.contains("tags: [clipped, research]\n"));
    assert!(raw.contains("inbox: true\n"));
    assert!(raw.contains("captured_at: "));
    // Body is preserved (the leading H1 in body should be there even though
    // it duplicates the title — that matches what every capture-style tool
    // does: front matter holds metadata, body is verbatim).
    assert!(raw.contains("# Hello from curl"));
    assert!(raw.contains("This is the body."));

    // ------------------------------------------------------------------
    // (4) Title falls back to first H1 when omitted.
    // ------------------------------------------------------------------
    let body = serde_json::json!({
        "content": "# Auto-titled note\n\nbody here\n",
    });
    let path = _test_handle_capture(body.to_string().as_bytes()).expect("h1 fallback");
    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.contains("title: Auto-titled note\n"));
    assert!(raw.contains("inbox: true\n"), "inbox defaults to true");

    // ------------------------------------------------------------------
    // (5) Inbox=false honours the flag.
    // ------------------------------------------------------------------
    let body = serde_json::json!({
        "title": "Skip the inbox",
        "content": "body\n",
        "inbox": false,
    });
    let path = _test_handle_capture(body.to_string().as_bytes()).expect("inbox false");
    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.contains("inbox: false\n"));

    // ------------------------------------------------------------------
    // (6) No workspace → NoWorkspace error.
    // ------------------------------------------------------------------
    _test_set_state(None, "secret-token-abc".to_string(), "inbox".to_string());
    let body = serde_json::json!({"content": "x"});
    let err = _test_handle_capture(body.to_string().as_bytes()).unwrap_err();
    matches!(err, CaptureError::NoWorkspace);

    // ------------------------------------------------------------------
    // (7) Regenerating the token invalidates the previous one.
    // ------------------------------------------------------------------
    _test_set_state(
        Some(ws.clone()),
        "old-token-xyz".to_string(),
        "inbox".to_string(),
    );
    assert_eq!(_test_current_token(), "old-token-xyz");
    assert!(_test_check_auth(Some("Bearer old-token-xyz")));

    let after = capture_regenerate_token();
    assert_ne!(after.token, "old-token-xyz", "token must rotate");
    assert_eq!(after.token.len(), 32, "32-hex token");
    assert!(after.token.chars().all(|c| c.is_ascii_hexdigit()));

    // Old token now rejected.
    assert!(
        !_test_check_auth(Some("Bearer old-token-xyz")),
        "old token must no longer authorize"
    );
    let new_header = format!("Bearer {}", after.token);
    assert!(_test_check_auth(Some(&new_header)));

    // ------------------------------------------------------------------
    // (8) Bad request: malformed JSON / missing content.
    // ------------------------------------------------------------------
    let bad = b"not-json";
    let err = _test_handle_capture(bad).unwrap_err();
    assert!(matches!(err, CaptureError::BadRequest(_)));

    let no_content = serde_json::json!({"title": "no body"}).to_string();
    let err = _test_handle_capture(no_content.as_bytes()).unwrap_err();
    assert!(matches!(err, CaptureError::BadRequest(_)));

    // ------------------------------------------------------------------
    // (9) Custom inbox folder is honoured.
    // ------------------------------------------------------------------
    let s = capture_set_inbox_folder("captures/from-extension".to_string());
    assert_eq!(s.inbox_folder, "captures/from-extension");
    let body = serde_json::json!({
        "title": "Routed",
        "content": "x\n",
    });
    let path = _test_handle_capture(body.to_string().as_bytes()).expect("custom inbox");
    let p = PathBuf::from(&path);
    assert!(
        p.starts_with(ws.join("captures/from-extension")),
        "should land in custom folder, got {}",
        p.display(),
    );
}

/// Pure-function smoke: `capture_write_inner` works without any global state
/// touched. This exercises the deterministic write path the e2e flow relies
/// on, with a fixed timestamp so the front-matter is reproducible.
#[test]
fn pure_write_works_without_globals() {
    let _g = lock();
    let ws = fresh_workspace("pure");
    let path = capture_write_inner(
        &ws,
        "inbox",
        Some("Fixed Title"),
        "Body line one.\n",
        Some("https://x.example"),
        Some(&["a".to_string(), "b".to_string()]),
        true,
        "2026-04-26T11:30:00+08:00".to_string(),
    )
    .expect("pure write should succeed");
    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.contains("title: Fixed Title\n"));
    assert!(raw.contains("source: https://x.example\n"));
    assert!(raw.contains("tags: [a, b]\n"));
    assert!(raw.contains("inbox: true\n"));
    assert!(raw.contains("captured_at: 2026-04-26T11:30:00+08:00\n"));
    assert!(raw.contains("Body line one."));
}

/// Live HTTP round-trip: bind the actual capture endpoint listener, talk
/// to it over a real loopback TCP socket, and verify the responses exactly
/// match the contract advertised in the spec — including 401 / 503 paths.
///
/// We use `std::net::TcpStream` rather than `reqwest` so this test stays
/// dep-free and can run in the same `cargo test` invocation as everything
/// else.
#[test]
fn live_http_round_trip() {
    let _g = lock();
    let ws = fresh_workspace("http");

    // Boot a listener on a random port.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let port: u16 = rt.block_on(async {
        _test_set_state(
            Some(ws.clone()),
            "http-token-xyz".to_string(),
            "inbox".to_string(),
        );
        _test_bind_and_serve().await.unwrap()
    });
    // Park the runtime in a background thread so accept() keeps running
    // while this test thread does blocking TCP I/O.
    std::thread::spawn(move || {
        rt.block_on(async {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });
    });
    // Tiny pause so the listener is ready before we connect.
    std::thread::sleep(std::time::Duration::from_millis(50));

    // ----- (a) Unauth POST → 401 -----
    let resp = http_post(
        port,
        "/capture",
        None,
        b"{\"content\":\"x\"}",
    );
    assert!(resp.starts_with("HTTP/1.1 401"), "expected 401, got: {resp:.80}");

    // ----- (b) Authed POST → 200, file written -----
    let body = serde_json::json!({
        "title": "Live HTTP",
        "content": "# Live HTTP\n\nbody\n",
        "url": "https://example.com/live",
        "tags": ["http", "live"],
    })
    .to_string();
    let resp = http_post(
        port,
        "/capture",
        Some("Bearer http-token-xyz"),
        body.as_bytes(),
    );
    assert!(resp.starts_with("HTTP/1.1 200"), "got: {resp:.120}");
    assert!(resp.contains("\"ok\":true"));
    // The response carries the path; verify the file exists on disk.
    let json_start = resp.find("{\"ok\"").unwrap_or(0);
    let payload: serde_json::Value =
        serde_json::from_str(&resp[json_start..]).expect("parse body json");
    let p = payload["path"].as_str().expect("path field");
    let raw = fs::read_to_string(p).expect("read created file");
    assert!(raw.contains("title: Live HTTP"));
    assert!(raw.contains("inbox: true"));

    // ----- (c) No workspace → 503 -----
    _test_set_state(None, "http-token-xyz".to_string(), "inbox".to_string());
    let resp = http_post(
        port,
        "/capture",
        Some("Bearer http-token-xyz"),
        b"{\"content\":\"x\"}",
    );
    assert!(resp.starts_with("HTTP/1.1 503"), "got: {resp:.120}");
}

/// Hand-rolled HTTP/1.1 POST — same shape as the server's parser, no deps.
fn http_post(port: u16, path: &str, auth: Option<&str>, body: &[u8]) -> String {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(a) = auth {
        req.push_str(&format!("Authorization: {a}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    let mut buf = String::new();
    stream.read_to_string(&mut buf).unwrap();
    buf
}

/// Sanity-check the local-time helper. We don't pin an exact value
/// (CI machines run in arbitrary zones), just that it parses as
/// `YYYY-MM-DDTHH:MM:SS±HH:MM`.
#[test]
fn iso8601_format_is_well_formed() {
    let _g = lock();
    let s = local_iso8601_now();
    assert_eq!(s.len(), 25, "expected 25-char ISO 8601 string, got {s:?}");
    assert_eq!(&s[4..5], "-");
    assert_eq!(&s[7..8], "-");
    assert_eq!(&s[10..11], "T");
    assert_eq!(&s[13..14], ":");
    assert_eq!(&s[16..17], ":");
    let off = &s[19..20];
    assert!(off == "+" || off == "-", "offset sign got {off:?}");
}
