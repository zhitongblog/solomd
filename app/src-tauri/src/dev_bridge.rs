//! Tauri WebDriver bridge (debug-only) — v2.3.
//!
//! A tiny localhost JSON-RPC server that accepts a JS string, runs it inside
//! the SoloMD WebView, and returns whatever the script resolves to. This is
//! how `solomd-dev-mcp` drives the actual Vue UI from outside the app.
//!
//! Why not WebDriver / CDP?
//! - macOS WKWebView (used by Tauri 2 here) doesn't expose CDP.
//! - WebDriver is a heavy dep we'd have to ship.
//! - Tauri's `WebviewWindow::eval` is fire-and-forget (returns `Result<()>`,
//!   not the value). To get a value back we wrap the user script in glue
//!   that POSTs the JSON-encoded result to a per-request callback URL on
//!   this same server. `tokio::sync::oneshot` glues the two halves together.
//!
//! Wire format:
//!
//!   POST /eval                          (called by dev-mcp)
//!     Headers: Authorization: Bearer <token>
//!     Body:    { "script": "<js source>" }
//!     ->       { "ok": true,  "value": <whatever the JS returned> }
//!     or       { "ok": false, "error": "<message>" }
//!
//!   POST /result/<id>                   (called by the WebView itself)
//!     Body:    { "ok": true|false, "value"?: ..., "error"?: "..." }
//!     ->       204 No Content
//!     (CORS-permissive — the WebView is origin `tauri://localhost` or
//!     `http://localhost:1420`, which is cross-origin to our 127.0.0.1:<port>.)
//!
//! Compiled in **only** under `#[cfg(debug_assertions)]`. Release builds
//! never see this module — verify with
//! `nm app/src-tauri/target/release/SoloMD | grep dev_bridge` and you
//! should get zero matches.

#![cfg(debug_assertions)]

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

// ---------------------------------------------------------------------------
// Pending eval registry — id -> oneshot sender that completes the /eval call.
// ---------------------------------------------------------------------------

type PendingMap = HashMap<String, oneshot::Sender<JsonValue>>;
static PENDING: Lazy<Mutex<PendingMap>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn pending_insert(id: String, tx: oneshot::Sender<JsonValue>) {
    PENDING.lock().expect("pending lock").insert(id, tx);
}

fn pending_take(id: &str) -> Option<oneshot::Sender<JsonValue>> {
    PENDING.lock().expect("pending lock").remove(id)
}

// ---------------------------------------------------------------------------
// Public entrypoint — wired from runner.rs / lib.rs setup hook.
// ---------------------------------------------------------------------------

/// Start the dev bridge. Binds to 127.0.0.1:0 (random port), writes the
/// chosen port and a fresh bearer token to disk so dev-mcp can find them,
/// and spawns the accept loop on the existing tokio runtime.
///
/// Idempotent-ish: if called twice we log and ignore the second call.
pub fn spawn(app: AppHandle) {
    static STARTED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        eprintln!("[dev_bridge] already started, ignoring second spawn");
        return;
    }

    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app).await {
            eprintln!("[dev_bridge] fatal: {e}");
        }
    });
}

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------

async fn serve(app: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind: {e}"))?;
    let addr = listener.local_addr().map_err(|e| format!("local_addr: {e}"))?;
    let port = addr.port();

    let token = random_token();

    write_port_token(&app, port, &token)?;

    eprintln!("[dev_bridge] listening on http://127.0.0.1:{port} (token in app config dir)");

    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                eprintln!("[dev_bridge] accept: {e}");
                continue;
            }
        };
        let app2 = app.clone();
        let token2 = token.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, app2, token2, port).await {
                eprintln!("[dev_bridge] conn: {e}");
            }
        });
    }
}

/// Write `dev-bridge.port` and `dev-bridge.token` next to each other in the
/// app's config dir. dev-mcp reads these.
fn write_port_token(app: &AppHandle, port: u16, token: &str) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let port_path = dir.join("dev-bridge.port");
    let token_path = dir.join("dev-bridge.token");

    std::fs::write(&port_path, port.to_string())
        .map_err(|e| format!("write port file: {e}"))?;
    std::fs::write(&token_path, token).map_err(|e| format!("write token file: {e}"))?;

    // 0600 on the token file (best-effort; no-op on Windows).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &token_path,
            std::fs::Permissions::from_mode(0o600),
        );
    }

    eprintln!("[dev_bridge] port -> {}", port_path.display());
    eprintln!("[dev_bridge] token -> {}", token_path.display());
    Ok(())
}

fn random_token() -> String {
    // 32 hex chars = 128 bits. We don't need crypto secrecy (loopback only
    // + dev-only build), just enough to deter accidental cross-process hits.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mix = nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(pid);
    let mut s = String::with_capacity(32);
    let mut x = mix;
    for _ in 0..16 {
        s.push_str(&format!("{:02x}", (x & 0xff) as u8));
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    }
    s
}

// ---------------------------------------------------------------------------
// Connection handling. Hand-rolled HTTP/1.1 — single route, two methods.
// ---------------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn handle_conn(
    mut stream: TcpStream,
    app: AppHandle,
    expected_token: String,
    port: u16,
) -> Result<(), String> {
    let req = match read_request(&mut stream).await {
        Ok(r) => r,
        Err(e) => {
            write_resp(&mut stream, 400, "Bad Request", &format!("{{\"error\":\"{}\"}}", e), true)
                .await
                .ok();
            return Ok(());
        }
    };

    // CORS preflight.
    if req.method == "OPTIONS" {
        write_resp(&mut stream, 204, "No Content", "", true).await.ok();
        return Ok(());
    }

    // Health check — no auth required, callers use this to confirm the
    // bridge is up before bothering to read the token file.
    if req.method == "GET" && req.path == "/" {
        write_resp(
            &mut stream,
            200,
            "OK",
            "{\"ok\":true,\"server\":\"solomd-dev-bridge\"}",
            true,
        )
        .await
        .ok();
        return Ok(());
    }

    // /result/<id> — the WebView posting back its eval result. No auth: the
    // id itself is unguessable (uuid-ish) and the route is loopback only.
    if req.method == "POST" && req.path.starts_with("/result/") {
        let id = req.path["/result/".len()..].to_string();
        let parsed: JsonValue =
            serde_json::from_slice(&req.body).unwrap_or_else(|_| JsonValue::Null);
        if let Some(tx) = pending_take(&id) {
            let _ = tx.send(parsed);
        }
        write_resp(&mut stream, 204, "No Content", "", true).await.ok();
        return Ok(());
    }

    // Everything else needs the bearer token.
    if !auth_ok(&req, &expected_token) {
        write_resp(
            &mut stream,
            401,
            "Unauthorized",
            "{\"error\":\"missing or wrong Authorization: Bearer <token>\"}",
            true,
        )
        .await
        .ok();
        return Ok(());
    }

    if req.method == "POST" && req.path == "/eval" {
        match handle_eval(&req, &app, port).await {
            Ok(value) => {
                let payload = serde_json::json!({ "ok": true, "value": value });
                let body = serde_json::to_string(&payload).unwrap();
                write_resp(&mut stream, 200, "OK", &body, true).await.ok();
            }
            Err(e) => {
                let payload = serde_json::json!({ "ok": false, "error": e });
                let body = serde_json::to_string(&payload).unwrap();
                write_resp(&mut stream, 200, "OK", &body, true).await.ok();
            }
        }
        return Ok(());
    }

    write_resp(&mut stream, 404, "Not Found", "{\"error\":\"unknown route\"}", true)
        .await
        .ok();
    Ok(())
}

fn auth_ok(req: &Request, expected: &str) -> bool {
    let Some(h) = req.headers.get("authorization") else {
        return false;
    };
    let want = format!("Bearer {expected}");
    h.eq_ignore_ascii_case(&want) || h == &want
}

async fn handle_eval(req: &Request, app: &AppHandle, port: u16) -> Result<JsonValue, String> {
    let parsed: JsonValue =
        serde_json::from_slice(&req.body).map_err(|e| format!("parse body: {e}"))?;
    let script = parsed
        .get("script")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing field: script".to_string())?
        .to_string();

    // Optional explicit timeout, default 5s. We add a small floor so tests
    // can't accidentally time out before the WebView even gets a chance.
    let timeout_ms = parsed
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(5_000)
        .max(50);

    // Counter+token id. The counter guarantees uniqueness even when two
    // eval calls land in the same microsecond (`random_token` derives from
    // SystemTime::now and was found to collide under rmcp's parallel
    // request dispatch — without the counter, the second insert into
    // PENDING would overwrite the first, dropping its oneshot Sender and
    // surfacing as "callback channel dropped" on the dev-mcp side).
    static EVAL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = EVAL_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let id = format!("ev-{}-{}-{}", std::process::id(), seq, random_token());
    let (tx, rx) = oneshot::channel::<JsonValue>();
    pending_insert(id.clone(), tx);

    let wrapped = wrap_script(&script, &id, port);

    // NOTE on macOS: WKWebView (and the surrounding NSApp run loop) is
    // throttled aggressively when the window is occluded / minimized —
    // `eval` then queues silently and only fires when the window comes
    // back to the foreground. There's no Tauri 2 API to bypass this; the
    // platform itself is gating execution. If a self-test times out,
    // bring the window forward (cmd+tab, or `osascript -e 'tell
    // application "SoloMD" to activate'`) and retry. We tried dispatching
    // via `run_on_main_thread` to see if direct main-loop scheduling
    // helped — it didn't, because the same main loop is the one being
    // throttled by AppKit when the window isn't keyWindow.
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no 'main' webview window".to_string())?;
    if let Err(e) = win.eval(&wrapped) {
        pending_take(&id);
        return Err(format!("eval: {e}"));
    }

    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(payload)) => {
            // Payload is the body the WebView posted: { ok, value? | error? }.
            let ok = payload.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if ok {
                Ok(payload.get("value").cloned().unwrap_or(JsonValue::Null))
            } else {
                Err(payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown WebView error")
                    .to_string())
            }
        }
        Ok(Err(_)) => {
            // sender dropped without sending — should not happen.
            pending_take(&id);
            Err("internal: callback channel dropped".into())
        }
        Err(_) => {
            pending_take(&id);
            Err(format!("timeout after {timeout_ms}ms"))
        }
    }
}

/// Wrap the user's script in glue that POSTs the result back. We use an
/// async IIFE so the user can `await` Promises naturally.
fn wrap_script(user: &str, id: &str, port: u16) -> String {
    // `value` is JSON-stringified by JSON.stringify; if it isn't
    // serialisable we fall back to String(value).
    format!(
        r#"(async () => {{
  const __BRIDGE_URL = 'http://127.0.0.1:{port}/result/{id}';
  const __post = (payload) => {{
    try {{
      fetch(__BRIDGE_URL, {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        // mode 'no-cors' would still send the body but loses errors.
        // We CORS-permit on the server, so default mode is fine.
        body: JSON.stringify(payload),
      }}).catch(() => {{}});
    }} catch (e) {{ /* dev-only — swallow */ }}
  }};
  try {{
    const __value = await (async () => {{
      {user}
    }})();
    let __safe;
    try {{
      __safe = JSON.parse(JSON.stringify(__value));
    }} catch (_) {{
      __safe = String(__value);
    }}
    __post({{ ok: true, value: __safe }});
  }} catch (__err) {{
    __post({{ ok: false, error: String((__err && __err.message) || __err) }});
  }}
}})();"#
    )
}

// ---------------------------------------------------------------------------
// Hand-rolled minimal HTTP/1.1 parser. One route, no chunked encoding, no
// keep-alive. ~80 lines. Good enough for loopback dev-only.
// ---------------------------------------------------------------------------

async fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    // Read until we see \r\n\r\n. Cap at 64 KiB headers.
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 1024];
    let header_end;
    loop {
        if buf.len() > 64 * 1024 {
            return Err("headers too large".into());
        }
        let n = stream.read(&mut tmp).await.map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err("unexpected eof".into());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_double_crlf(&buf) {
            header_end = pos + 4;
            break;
        }
    }

    // Split headers / body fragment.
    let (head_bytes, rest) = buf.split_at(header_end);
    let head = std::str::from_utf8(head_bytes)
        .map_err(|_| "non-utf8 headers".to_string())?
        .to_string();
    let mut rest = rest.to_vec();

    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or("empty request")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("no method")?.to_string();
    let path = parts.next().ok_or("no path")?.to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    while rest.len() < content_length {
        let n = stream.read(&mut tmp).await.map_err(|e| format!("read body: {e}"))?;
        if n == 0 {
            break;
        }
        rest.extend_from_slice(&tmp[..n]);
    }
    rest.truncate(content_length);

    Ok(Request {
        method,
        path,
        headers,
        body: rest,
    })
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    let needle = b"\r\n\r\n";
    if buf.len() < 4 {
        return None;
    }
    for i in 0..=buf.len() - 4 {
        if &buf[i..i + 4] == needle {
            return Some(i);
        }
    }
    None
}

async fn write_resp(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    body: &str,
    cors: bool,
) -> Result<(), String> {
    let cors_headers = if cors {
        "Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
    } else {
        ""
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         {cors_headers}\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("write head: {e}"))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write body: {e}"))?;
    let _ = stream.shutdown().await;
    Ok(())
}

/// Best-effort cleanup at app exit — remove the port file so dev-mcp doesn't
/// keep trying to talk to a dead server. Called from the runner if reachable;
/// not load-bearing — stale files are gracefully handled by dev-mcp.
#[allow(dead_code)]
pub fn cleanup_files(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::remove_file(dir.join("dev-bridge.port"));
        let _ = std::fs::remove_file(dir.join("dev-bridge.token"));
    }
}

// ---------------------------------------------------------------------------
// Tests — pure parser bits only; the full flow is exercised by dev-mcp.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_double_crlf() {
        assert_eq!(find_double_crlf(b"abc\r\n\r\n"), Some(3));
        assert_eq!(find_double_crlf(b"\r\n\r\nbody"), Some(0));
        assert_eq!(find_double_crlf(b"no markers here"), None);
    }

    #[test]
    fn random_token_is_32_hex() {
        let t = random_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn wrap_script_round_trips_id_and_port() {
        let s = wrap_script("return 1+1;", "abc", 12345);
        assert!(s.contains("/result/abc"));
        assert!(s.contains("127.0.0.1:12345"));
        assert!(s.contains("return 1+1;"));
    }
}
