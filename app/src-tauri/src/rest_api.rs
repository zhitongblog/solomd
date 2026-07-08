//! v4.0 — Public REST API server.
//!
//! Localhost HTTP server that exposes the same surface as the in-process
//! `agent_tools` registry — list / read / search / write notes, list runs,
//! read a run's trace — to **non-MCP** clients (Alfred / Raycast / n8n /
//! shell scripts / browser extensions / iOS shortcuts that don't speak
//! MCP). Same wire pattern as `capture_endpoint.rs`: hand-rolled HTTP/1.1,
//! single bearer token, 127.0.0.1 only, opt-in via Settings → Integrations.
//!
//! Off by default. The user toggles it on, copies the bearer token, and
//! pings the endpoint. Turning it off shuts down the listener and clears
//! the on-disk port + token files.
//!
//! Routes (every route except `GET /` requires `Authorization: Bearer …`):
//!
//!   GET  /                     → server banner (no auth)
//!   GET  /health               → workspace status
//!   GET  /tools                → list available tools + JSON schemas
//!   POST /tools/<name>         → invoke tool, body = JSON args
//!   GET  /runs                 → list recent agent runs (meta.json blobs)
//!   GET  /runs/<id>/meta       → meta.json for a single run
//!   GET  /runs/<id>/trace      → trace.jsonl text
//!   GET  /runs/<id>/run.md     → run.md text
//!
//! Write tools (`write_note`, `append_to_note`) are gated behind a separate
//! `allow_write` toggle in settings — when off, POST returns 403 even if the
//! token checks out. This mirrors the recipe runner's write-cap UX: read
//! access is the default, writes are an explicit opt-in per integration.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::agent_tools;

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RestState {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub token: String,
    /// When false, POST /tools/<write_*> returns 403. Defaults off.
    pub allow_write: bool,
}

#[derive(Debug, Clone)]
struct InnerState {
    enabled: bool,
    running: bool,
    port: u16,
    token: String,
    allow_write: bool,
    workspace: Option<PathBuf>,
    shutdown_gen: u64,
}

static STATE: Lazy<Mutex<InnerState>> = Lazy::new(|| {
    Mutex::new(InnerState {
        enabled: false,
        running: false,
        port: 7878,
        token: String::new(),
        allow_write: false,
        workspace: None,
        shutdown_gen: 0,
    })
});

static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Token mint — same shape as capture_endpoint::random_token. 32 hex chars.
// ---------------------------------------------------------------------------

fn random_token() -> String {
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

fn snapshot() -> RestState {
    let s = STATE.lock().expect("rest state lock");
    RestState {
        enabled: s.enabled,
        running: s.running,
        port: s.port,
        token: s.token.clone(),
        allow_write: s.allow_write,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn rest_get_state() -> RestState {
    snapshot()
}

#[tauri::command]
pub async fn rest_set_enabled(
    app: AppHandle,
    enabled: bool,
    port: Option<u16>,
) -> Result<RestState, String> {
    {
        let mut s = STATE.lock().expect("rest state lock");
        s.enabled = enabled;
        if let Some(p) = port {
            s.port = p;
        }
        if enabled && s.token.is_empty() {
            s.token = random_token();
        }
        if !enabled {
            s.shutdown_gen = s.shutdown_gen.wrapping_add(1);
            s.running = false;
        }
    }
    if enabled {
        spawn_if_needed(app);
    }
    Ok(snapshot())
}

#[tauri::command]
pub fn rest_regenerate_token() -> RestState {
    {
        let mut s = STATE.lock().expect("rest state lock");
        s.token = random_token();
    }
    snapshot()
}

#[tauri::command]
pub fn rest_set_allow_write(allow: bool) -> RestState {
    {
        let mut s = STATE.lock().expect("rest state lock");
        s.allow_write = allow;
    }
    snapshot()
}

/// Frontend pushes the active workspace folder here whenever it changes.
#[tauri::command]
pub fn rest_set_workspace(folder: Option<String>) {
    let mut s = STATE.lock().expect("rest state lock");
    s.workspace = folder
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(PathBuf::from);
}

// ---------------------------------------------------------------------------
// Server boot
// ---------------------------------------------------------------------------

fn spawn_if_needed(app: AppHandle) {
    if SERVER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app).await {
            eprintln!("[rest_api] fatal: {e}");
        }
        SERVER_RUNNING.store(false, Ordering::SeqCst);
    });
}

async fn serve(app: AppHandle) -> Result<(), String> {
    let port = STATE.lock().expect("rest state lock").port;
    let listener = TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{port}: {e}"))?;
    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    {
        let mut s = STATE.lock().expect("rest state lock");
        s.port = bound_port;
        s.running = true;
    }

    let my_gen = STATE.lock().expect("rest state lock").shutdown_gen;
    write_port_token(&app, bound_port);

    eprintln!("[rest_api] listening on http://127.0.0.1:{bound_port}");

    loop {
        let (enabled, gen_now) = {
            let s = STATE.lock().expect("rest state lock");
            (s.enabled, s.shutdown_gen)
        };
        if !enabled || gen_now != my_gen {
            break;
        }
        let accept = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
        let stream = match accept {
            Ok(Ok((s, _))) => s,
            Ok(Err(e)) => {
                eprintln!("[rest_api] accept: {e}");
                continue;
            }
            Err(_) => continue,
        };
        let app2 = app.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, app2).await {
                eprintln!("[rest_api] conn: {e}");
            }
        });
    }

    {
        let mut s = STATE.lock().expect("rest state lock");
        s.running = false;
    }
    cleanup_port_token(&app);
    eprintln!("[rest_api] stopped");
    Ok(())
}

fn write_port_token(app: &AppHandle, port: u16) {
    let token = STATE.lock().expect("rest state lock").token.clone();
    let dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join("rest-api.port"), port.to_string());
    let token_path = dir.join("rest-api.token");
    let _ = std::fs::write(&token_path, &token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600));
    }
}

fn cleanup_port_token(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::remove_file(dir.join("rest-api.port"));
        let _ = std::fs::remove_file(dir.join("rest-api.token"));
    }
}

// ---------------------------------------------------------------------------
// Connection handling — same minimal HTTP/1.1 parser as capture_endpoint.
// ---------------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn handle_conn(mut stream: TcpStream, _app: AppHandle) -> Result<(), String> {
    let req = match read_request(&mut stream).await {
        Ok(r) => r,
        Err(e) => {
            let _ = write_resp(
                &mut stream,
                400,
                "Bad Request",
                &json!({"ok": false, "error": e}).to_string(),
            )
            .await;
            return Ok(());
        }
    };

    if req.method == "OPTIONS" {
        let _ = write_resp(&mut stream, 204, "No Content", "").await;
        return Ok(());
    }

    // Public banner — confirms the service identity without revealing
    // anything sensitive. Same shape as the capture endpoint banner.
    if req.method == "GET" && req.path == "/" {
        let _ = write_resp(
            &mut stream,
            200,
            "OK",
            &json!({
                "ok": true,
                "server": "solomd-rest",
                "version": env!("CARGO_PKG_VERSION"),
            })
            .to_string(),
        )
        .await;
        return Ok(());
    }

    // Auth gate for every other route.
    let token = STATE.lock().expect("rest state lock").token.clone();
    if !auth_ok(&req, &token) {
        let _ = write_resp(
            &mut stream,
            401,
            "Unauthorized",
            "{\"ok\":false,\"error\":\"missing or wrong Authorization: Bearer <token>\"}",
        )
        .await;
        return Ok(());
    }

    let (workspace, allow_write) = {
        let s = STATE.lock().expect("rest state lock");
        (s.workspace.clone(), s.allow_write)
    };

    // GET /health — does the server have a workspace?
    if req.method == "GET" && req.path == "/health" {
        let body = json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "workspace": workspace
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            "workspace_open": workspace.is_some(),
            "allow_write": allow_write,
        })
        .to_string();
        let _ = write_resp(&mut stream, 200, "OK", &body).await;
        return Ok(());
    }

    // GET /tools — list every registered tool + descriptor.
    if req.method == "GET" && req.path == "/tools" {
        let mut tools: Vec<Value> = Vec::new();
        for name in agent_tools::all_tools() {
            if let Some((desc, schema)) = agent_tools::tool_descriptor(name) {
                tools.push(json!({
                    "name": name,
                    "description": desc,
                    "input_schema": schema,
                    "write": agent_tools::is_write_tool(name),
                }));
            }
        }
        let _ = write_resp(
            &mut stream,
            200,
            "OK",
            &json!({"ok": true, "tools": tools}).to_string(),
        )
        .await;
        return Ok(());
    }

    // POST /tools/<name> — invoke a tool with JSON args.
    if req.method == "POST" && req.path.starts_with("/tools/") {
        let name = &req.path["/tools/".len()..];
        if name.is_empty() {
            write_err(&mut stream, 400, "tool name missing").await;
            return Ok(());
        }
        if agent_tools::tool_descriptor(name).is_none() {
            write_err(&mut stream, 404, &format!("unknown tool: {name}")).await;
            return Ok(());
        }
        if agent_tools::is_write_tool(name) && !allow_write {
            write_err(
                &mut stream,
                403,
                "write tools disabled (enable 'Allow write' in Settings → Integrations → REST API)",
            )
            .await;
            return Ok(());
        }
        let workspace = match workspace {
            Some(w) => w,
            None => {
                write_err(
                    &mut stream,
                    503,
                    "no workspace folder open in SoloMD; open a folder first",
                )
                .await;
                return Ok(());
            }
        };
        let args: Value = if req.body.is_empty() {
            json!({})
        } else {
            match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(e) => {
                    write_err(&mut stream, 400, &format!("parse body: {e}")).await;
                    return Ok(());
                }
            }
        };
        let name_owned = name.to_string();
        // Move dispatch off the runtime thread — agent_tools does sync FS work.
        let result = tauri::async_runtime::spawn_blocking(move || {
            agent_tools::dispatch_tool_inner(&workspace, &name_owned, args)
        })
        .await
        .map_err(|e| format!("dispatch join: {e}"));
        match result {
            Ok(Ok(v)) => {
                let _ = write_resp(
                    &mut stream,
                    200,
                    "OK",
                    &json!({"ok": true, "result": v}).to_string(),
                )
                .await;
            }
            Ok(Err(msg)) | Err(msg) => {
                write_err(&mut stream, 500, &msg).await;
            }
        }
        return Ok(());
    }

    // GET /runs — list recent agent runs.
    if req.method == "GET" && req.path == "/runs" {
        let workspace = match workspace {
            Some(w) => w,
            None => {
                write_err(&mut stream, 503, "no workspace folder open").await;
                return Ok(());
            }
        };
        let runs = super::agent_run::list_runs(&workspace);
        let _ = write_resp(
            &mut stream,
            200,
            "OK",
            &json!({"ok": true, "runs": runs}).to_string(),
        )
        .await;
        return Ok(());
    }

    // GET /runs/<id>/meta | /trace | /run.md
    if req.method == "GET" && req.path.starts_with("/runs/") {
        let workspace = match workspace {
            Some(w) => w,
            None => {
                write_err(&mut stream, 503, "no workspace folder open").await;
                return Ok(());
            }
        };
        let rest = &req.path["/runs/".len()..];
        let (run_id, kind) = match rest.split_once('/') {
            Some((id, k)) => (id, k),
            None => (rest, "meta"),
        };
        // Disallow path traversal — run_id is meant to be the YYYYMMDD-HHMMSS-XXXXXX
        // form, so we refuse anything with a slash or `..`.
        if run_id.is_empty() || run_id.contains('/') || run_id.contains('\\') || run_id.contains("..") {
            write_err(&mut stream, 400, "bad run id").await;
            return Ok(());
        }
        match kind {
            "meta" | "" => match super::agent_run::read_run_meta(&workspace, run_id) {
                Ok(m) => {
                    let body = json!({"ok": true, "run": m}).to_string();
                    let _ = write_resp(&mut stream, 200, "OK", &body).await;
                }
                Err(e) => write_err(&mut stream, 404, &e).await,
            },
            "trace" => match super::agent_run::read_trace(&workspace, run_id) {
                Ok(t) => write_text(&mut stream, 200, "OK", &t).await,
                Err(e) => write_err(&mut stream, 404, &e).await,
            },
            "run.md" => match super::agent_run::read_run_md(&workspace, run_id) {
                Ok(t) => write_text(&mut stream, 200, "OK", &t).await,
                Err(e) => write_err(&mut stream, 404, &e).await,
            },
            other => write_err(&mut stream, 404, &format!("unknown run sub-resource: {other}")).await,
        }
        return Ok(());
    }

    write_err(&mut stream, 404, "unknown route").await;
    Ok(())
}

async fn write_err(stream: &mut TcpStream, code: u16, msg: &str) {
    let reason = match code {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let body = json!({"ok": false, "error": msg}).to_string();
    let _ = write_resp(stream, code, reason, &body).await;
}

fn auth_ok(req: &Request, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let Some(h) = req.headers.get("authorization") else {
        return false;
    };
    let want = format!("Bearer {expected}");
    h == &want || h.eq_ignore_ascii_case(&want)
}

// ---------------------------------------------------------------------------
// HTTP/1.1 helpers — copied verbatim from capture_endpoint to keep the two
// servers independent. Same body cap (8 MiB), same header cap (64 KiB).
// ---------------------------------------------------------------------------

async fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
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
    if content_length > 8 * 1024 * 1024 {
        return Err("body too large (max 8 MiB)".into());
    }
    while rest.len() < content_length {
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| format!("read body: {e}"))?;
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

async fn write_resp(stream: &mut TcpStream, code: u16, reason: &str, body: &str) -> Result<(), String> {
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
         \r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.map_err(|e| format!("write head: {e}"))?;
    stream.write_all(body.as_bytes()).await.map_err(|e| format!("write body: {e}"))?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn write_text(stream: &mut TcpStream, code: u16, reason: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Access-Control-Allow-Origin: *\r\n\
         \r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test surface — drives the server through a real localhost socket so we
// exercise auth, parsing, and dispatch end-to-end.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// All tests share the singleton `STATE` mutex (auth token + workspace +
    /// allow_write). Without serialization they trample each other's setup
    /// and 401 randomly, so we hold a real `Mutex` for the duration of every
    /// test. Test functions just take this lock as their first line.
    static TEST_LOCK: Lazy<std::sync::Mutex<()>> = Lazy::new(|| std::sync::Mutex::new(()));

    /// Spin a serve-loop up on an ephemeral port, return (port, token).
    /// Caller is responsible for tearing down via `_test_clear_state` if
    /// they care; the test process exits between runs.
    pub async fn _test_bind() -> Result<u16, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind: {e}"))?;
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(p) => p,
                    Err(_) => break,
                };
                tokio::spawn(async move {
                    let _ = handle_conn_test(stream).await;
                });
            }
        });
        Ok(port)
    }

    /// Same handler as `handle_conn` but doesn't need a real `AppHandle` —
    /// the production handler only uses the handle for the on-disk port/token
    /// drop, which the tests don't care about.
    async fn handle_conn_test(mut stream: TcpStream) -> Result<(), String> {
        let req = read_request(&mut stream).await?;
        if req.method == "GET" && req.path == "/" {
            let _ = write_resp(
                &mut stream,
                200,
                "OK",
                &json!({"ok": true, "server": "solomd-rest"}).to_string(),
            )
            .await;
            return Ok(());
        }
        let token = STATE.lock().unwrap().token.clone();
        if !auth_ok(&req, &token) {
            write_err(&mut stream, 401, "auth").await;
            return Ok(());
        }
        let (workspace, allow_write) = {
            let s = STATE.lock().unwrap();
            (s.workspace.clone(), s.allow_write)
        };
        if req.method == "GET" && req.path == "/health" {
            let body = json!({
                "ok": true,
                "workspace_open": workspace.is_some(),
                "allow_write": allow_write,
            })
            .to_string();
            let _ = write_resp(&mut stream, 200, "OK", &body).await;
            return Ok(());
        }
        if req.method == "GET" && req.path == "/tools" {
            let mut tools: Vec<Value> = Vec::new();
            for name in agent_tools::all_tools() {
                if let Some((desc, schema)) = agent_tools::tool_descriptor(name) {
                    tools.push(json!({
                        "name": name,
                        "description": desc,
                        "input_schema": schema,
                        "write": agent_tools::is_write_tool(name),
                    }));
                }
            }
            let _ = write_resp(
                &mut stream,
                200,
                "OK",
                &json!({"ok": true, "tools": tools}).to_string(),
            )
            .await;
            return Ok(());
        }
        if req.method == "POST" && req.path.starts_with("/tools/") {
            let name = req.path["/tools/".len()..].to_string();
            if agent_tools::tool_descriptor(&name).is_none() {
                write_err(&mut stream, 404, "unknown").await;
                return Ok(());
            }
            if agent_tools::is_write_tool(&name) && !allow_write {
                write_err(&mut stream, 403, "write disabled").await;
                return Ok(());
            }
            let workspace = match workspace {
                Some(w) => w,
                None => {
                    write_err(&mut stream, 503, "no ws").await;
                    return Ok(());
                }
            };
            let args: Value = if req.body.is_empty() {
                json!({})
            } else {
                serde_json::from_slice(&req.body).map_err(|e| e.to_string())?
            };
            let res = agent_tools::dispatch_tool_inner(&workspace, &name, args);
            match res {
                Ok(v) => {
                    let _ = write_resp(
                        &mut stream,
                        200,
                        "OK",
                        &json!({"ok": true, "result": v}).to_string(),
                    )
                    .await;
                }
                Err(msg) => write_err(&mut stream, 500, &msg).await,
            }
            return Ok(());
        }
        write_err(&mut stream, 404, "nope").await;
        Ok(())
    }

    pub fn _test_set(token: &str, allow_write: bool, workspace: Option<PathBuf>) {
        let mut s = STATE.lock().unwrap();
        s.token = token.to_string();
        s.allow_write = allow_write;
        s.workspace = workspace;
    }

    /// Hit the ephemeral server with a single request, return (status, body).
    async fn http(
        port: u16,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let body_bytes = body.unwrap_or("").as_bytes();
        let auth_h = match token {
            Some(t) => format!("Authorization: Bearer {t}\r\n"),
            None => String::new(),
        };
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth_h}Content-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            body_bytes.len()
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        stream.write_all(body_bytes).await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        let raw = String::from_utf8_lossy(&buf).to_string();
        let status: u16 = raw
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let body_part = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body_part)
    }

    #[tokio::test]
    async fn banner_no_auth_required() {
        let _g = TEST_LOCK.lock().unwrap();
        _test_set("tok", false, None);
        let port = _test_bind().await.unwrap();
        let (code, body) = http(port, "GET", "/", None, None).await;
        assert_eq!(code, 200, "body: {body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["server"], "solomd-rest");
    }

    #[tokio::test]
    async fn missing_token_rejected() {
        let _g = TEST_LOCK.lock().unwrap();
        _test_set("tok-A", false, None);
        let port = _test_bind().await.unwrap();
        let (code, _) = http(port, "GET", "/health", None, None).await;
        assert_eq!(code, 401);
        let (code2, _) = http(port, "GET", "/health", Some("wrong"), None).await;
        assert_eq!(code2, 401);
    }

    #[tokio::test]
    async fn list_tools_returns_full_registry() {
        let _g = TEST_LOCK.lock().unwrap();
        _test_set("tok-B", false, None);
        let port = _test_bind().await.unwrap();
        let (code, body) = http(port, "GET", "/tools", Some("tok-B"), None).await;
        assert_eq!(code, 200, "body: {body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        let tools = v["tools"].as_array().unwrap();
        // Must include the canonical read tools + the two writers.
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        for must in [
            "list_notes",
            "read_note",
            "search",
            "write_note",
            "append_to_note",
        ] {
            assert!(names.contains(&must), "missing tool {must} in {names:?}");
        }
        // Each tool carries a JSON schema.
        assert!(tools[0]["input_schema"].is_object());
    }

    #[tokio::test]
    async fn write_tool_403_when_allow_write_false() {
        let _g = TEST_LOCK.lock().unwrap();
        // Spin a temp workspace so we don't 503 on missing workspace.
        let tmp = std::env::temp_dir().join(format!("solomd-rest-test-{}", super::super::agent_run::mint_run_id()));
        fs::create_dir_all(&tmp).unwrap();
        _test_set("tok-C", false, Some(tmp.clone()));
        let port = _test_bind().await.unwrap();
        let (code, body) = http(
            port,
            "POST",
            "/tools/write_note",
            Some("tok-C"),
            Some(r#"{"path":"hello.md","content":"hi","allow_overwrite":true}"#),
        )
        .await;
        assert_eq!(code, 403, "body: {body}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn read_tool_round_trips_via_http() {
        let _g = TEST_LOCK.lock().unwrap();
        // Seed a tiny workspace with one markdown file so list_notes returns it.
        let tmp = std::env::temp_dir().join(format!("solomd-rest-rt-{}", super::super::agent_run::mint_run_id()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("note.md"), "# title\n\nhello\n").unwrap();
        _test_set("tok-D", false, Some(tmp.clone()));
        let port = _test_bind().await.unwrap();
        let (code, body) = http(
            port,
            "POST",
            "/tools/list_notes",
            Some("tok-D"),
            Some("{}"),
        )
        .await;
        assert_eq!(code, 200, "body: {body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        // list_notes returns { notes: [...] }.
        let notes = v["result"]["notes"].as_array().expect("notes array");
        assert!(!notes.is_empty(), "expected at least one note: {body}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn unknown_tool_returns_404() {
        let _g = TEST_LOCK.lock().unwrap();
        _test_set("tok-E", false, None);
        let port = _test_bind().await.unwrap();
        let (code, _) = http(port, "POST", "/tools/no_such", Some("tok-E"), Some("{}")).await;
        assert_eq!(code, 404);
    }
}
