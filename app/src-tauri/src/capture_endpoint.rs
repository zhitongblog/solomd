//! HTTP capture endpoint — v2.4.
//!
//! A localhost HTTP server that accepts new-note submissions from external
//! clients (browser extension, iOS shortcuts, shell scripts, curl). Same
//! shape as `dev_bridge.rs` (hand-rolled HTTP/1.1, single bearer token,
//! 127.0.0.1 only) but **production-ready** — shipped in release builds
//! and gated by a Settings → Integrations toggle instead of `cfg(debug_assertions)`.
//!
//! Wire format:
//!
//!   POST http://127.0.0.1:7777/capture
//!     Headers: Authorization: Bearer <token>
//!              Content-Type: application/json
//!     Body:    { "title"?, "content", "url"?, "tags"?, "inbox"? }
//!     -> 200   { "ok": true, "path": "/abs/path/to/inbox/..." }
//!     -> 401   missing or wrong bearer token
//!     -> 503   no workspace folder open
//!
//! Off by default. The user opts in from Settings → Integrations, copies
//! the displayed bearer token into their browser extension / shell, and
//! pings the endpoint. Toggling off shuts down the listener and clears
//! the on-disk port/token files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ---------------------------------------------------------------------------
// Public state shared between the Tauri command layer and the running server.
// ---------------------------------------------------------------------------

/// Frontend-facing snapshot of the capture endpoint's current state.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CaptureState {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub token: String,
    pub inbox_folder: String,
}

#[derive(Debug, Clone)]
struct InnerState {
    enabled: bool,
    running: bool,
    port: u16,
    token: String,
    /// Workspace folder. Pushed in by the frontend whenever the user opens
    /// or switches a folder. None → endpoint returns 503.
    workspace: Option<PathBuf>,
    /// Sub-folder inside the workspace where new notes land. Default `inbox`.
    inbox_folder: String,
    /// Set when the active server should stop accepting new connections.
    shutdown_gen: u64,
}

static STATE: Lazy<Mutex<InnerState>> = Lazy::new(|| {
    Mutex::new(InnerState {
        enabled: false,
        running: false,
        port: 7777,
        token: String::new(),
        workspace: None,
        inbox_folder: "inbox".to_string(),
        shutdown_gen: 0,
    })
});

static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Token generation. Same construction as dev_bridge — 32 hex chars derived
// from system time + pid + LCG mixer. Loopback-only, paired with an opt-in
// toggle, so we don't need true crypto secrecy.
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

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

/// Read the current state. Cheap — just clones the in-memory snapshot.
#[tauri::command]
pub fn capture_get_state() -> CaptureState {
    let s = STATE.lock().expect("capture state lock");
    CaptureState {
        enabled: s.enabled,
        running: s.running,
        port: s.port,
        token: s.token.clone(),
        inbox_folder: s.inbox_folder.clone(),
    }
}

/// Toggle the endpoint on/off. When turning on, a token is minted (if the
/// caller didn't pass one) and the listener is bound. When turning off, the
/// existing listener is asked to stop accepting new connections.
#[tauri::command]
pub async fn capture_set_enabled(
    app: AppHandle,
    enabled: bool,
    port: Option<u16>,
) -> Result<CaptureState, String> {
    {
        let mut s = STATE.lock().expect("capture state lock");
        s.enabled = enabled;
        if let Some(p) = port {
            s.port = p;
        }
        if enabled && s.token.is_empty() {
            s.token = random_token();
        }
        if !enabled {
            // Bumping the shutdown generation makes the running accept loop
            // notice on its next iteration (we poll a short timeout).
            s.shutdown_gen = s.shutdown_gen.wrapping_add(1);
            s.running = false;
        }
    }
    if enabled {
        spawn_if_needed(app);
    }
    Ok(capture_get_state())
}

/// Mint a fresh bearer token. The old one stops working immediately —
/// in-flight requests already past auth check are unaffected, but the
/// next request with the old header gets 401.
#[tauri::command]
pub fn capture_regenerate_token() -> CaptureState {
    {
        let mut s = STATE.lock().expect("capture state lock");
        s.token = random_token();
    }
    capture_get_state()
}

/// Set the inbox sub-folder (relative to workspace). Defaults to "inbox".
#[tauri::command]
pub fn capture_set_inbox_folder(folder: String) -> CaptureState {
    {
        let mut s = STATE.lock().expect("capture state lock");
        let trimmed = folder.trim().trim_matches('/').trim_matches('\\');
        s.inbox_folder = if trimmed.is_empty() {
            "inbox".to_string()
        } else {
            trimmed.to_string()
        };
    }
    capture_get_state()
}

/// Frontend pushes the active workspace folder here whenever it changes.
/// Server reads this on every request — when None, the endpoint replies
/// 503 with a friendly error.
#[tauri::command]
pub fn capture_set_workspace(folder: Option<String>) {
    let mut s = STATE.lock().expect("capture state lock");
    s.workspace = folder
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(PathBuf::from);
}

// ---------------------------------------------------------------------------
// Server boot.
// ---------------------------------------------------------------------------

fn spawn_if_needed(app: AppHandle) {
    if SERVER_RUNNING.swap(true, Ordering::SeqCst) {
        // Another accept-loop is already alive; it'll pick up the new
        // token / config on the next request.
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app).await {
            eprintln!("[capture_endpoint] fatal: {e}");
        }
        SERVER_RUNNING.store(false, Ordering::SeqCst);
    });
}

async fn serve(app: AppHandle) -> Result<(), String> {
    let port = STATE.lock().expect("capture state lock").port;
    let listener = TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{port}: {e}"))?;
    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    {
        let mut s = STATE.lock().expect("capture state lock");
        s.port = bound_port;
        s.running = true;
    }

    let my_gen = STATE.lock().expect("capture state lock").shutdown_gen;
    write_port_token(&app, bound_port);

    eprintln!(
        "[capture_endpoint] listening on http://127.0.0.1:{bound_port}"
    );

    loop {
        // Bail out if the user toggled the endpoint off.
        let (enabled, gen_now) = {
            let s = STATE.lock().expect("capture state lock");
            (s.enabled, s.shutdown_gen)
        };
        if !enabled || gen_now != my_gen {
            break;
        }

        // Accept with a small timeout so we can re-check the toggle.
        let accept = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
        let stream = match accept {
            Ok(Ok((s, _))) => s,
            Ok(Err(e)) => {
                eprintln!("[capture_endpoint] accept: {e}");
                continue;
            }
            Err(_) => continue, // timeout — loop back, re-check toggle
        };
        let app2 = app.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, app2).await {
                eprintln!("[capture_endpoint] conn: {e}");
            }
        });
    }

    {
        let mut s = STATE.lock().expect("capture state lock");
        s.running = false;
    }
    cleanup_port_token(&app);
    eprintln!("[capture_endpoint] stopped");
    Ok(())
}

/// Mirror dev_bridge: drop a `capture-endpoint.{port,token}` pair next to
/// the dev-bridge files so external clients (e.g. a Mac shortcut) can
/// auto-discover the port and token without the user manually editing
/// their script. Best-effort — we don't fail the boot if the write fails.
fn write_port_token(app: &AppHandle, port: u16) {
    let token = STATE.lock().expect("capture state lock").token.clone();
    let dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join("capture-endpoint.port"), port.to_string());
    let token_path = dir.join("capture-endpoint.token");
    let _ = std::fs::write(&token_path, &token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &token_path,
            std::fs::Permissions::from_mode(0o600),
        );
    }
}

fn cleanup_port_token(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::remove_file(dir.join("capture-endpoint.port"));
        let _ = std::fs::remove_file(dir.join("capture-endpoint.token"));
    }
}

// ---------------------------------------------------------------------------
// Connection handling. Hand-rolled HTTP/1.1 — same minimal parser as
// dev_bridge::handle_conn. Single route, no chunked encoding, no keep-alive.
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
                &serde_json::json!({"ok": false, "error": e}).to_string(),
            )
            .await;
            return Ok(());
        }
    };

    if req.method == "OPTIONS" {
        let _ = write_resp(&mut stream, 204, "No Content", "").await;
        return Ok(());
    }

    if req.method == "GET" && req.path == "/" {
        let _ = write_resp(
            &mut stream,
            200,
            "OK",
            "{\"ok\":true,\"server\":\"solomd-capture\"}",
        )
        .await;
        return Ok(());
    }

    if req.method == "POST" && req.path == "/capture" {
        // Auth check.
        let token = STATE.lock().expect("capture state lock").token.clone();
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

        match handle_capture(&req.body) {
            Ok(path) => {
                let body =
                    serde_json::json!({"ok": true, "path": path}).to_string();
                let _ = write_resp(&mut stream, 200, "OK", &body).await;
            }
            Err(CaptureError::NoWorkspace) => {
                let _ = write_resp(
                    &mut stream,
                    503,
                    "Service Unavailable",
                    "{\"ok\":false,\"error\":\"no workspace folder open in SoloMD; open a folder first\"}",
                )
                .await;
            }
            Err(CaptureError::BadRequest(msg)) => {
                let body =
                    serde_json::json!({"ok": false, "error": msg}).to_string();
                let _ = write_resp(&mut stream, 400, "Bad Request", &body).await;
            }
            Err(CaptureError::Io(msg)) => {
                let body =
                    serde_json::json!({"ok": false, "error": msg}).to_string();
                let _ = write_resp(&mut stream, 500, "Internal Server Error", &body).await;
            }
        }
        return Ok(());
    }

    let _ = write_resp(
        &mut stream,
        404,
        "Not Found",
        "{\"ok\":false,\"error\":\"unknown route\"}",
    )
    .await;
    Ok(())
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
// Capture core — pure: takes a JSON body, returns a created file path.
// Exposed for the e2e test as `capture_write_inner`.
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum CaptureError {
    NoWorkspace,
    BadRequest(String),
    Io(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::NoWorkspace => write!(f, "no workspace folder open"),
            CaptureError::BadRequest(s) => write!(f, "{s}"),
            CaptureError::Io(s) => write!(f, "{s}"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct CaptureBody {
    title: Option<String>,
    content: Option<String>,
    url: Option<String>,
    tags: Option<Vec<String>>,
    /// Defaults to true — captures land in the inbox by default.
    inbox: Option<bool>,
}

fn handle_capture(body: &[u8]) -> Result<String, CaptureError> {
    let parsed: CaptureBody = serde_json::from_slice(body)
        .map_err(|e| CaptureError::BadRequest(format!("parse body: {e}")))?;
    let content = parsed
        .content
        .as_deref()
        .ok_or_else(|| CaptureError::BadRequest("missing field: content".into()))?
        .to_string();

    let (workspace, inbox_folder) = {
        let s = STATE.lock().expect("capture state lock");
        (s.workspace.clone(), s.inbox_folder.clone())
    };
    let workspace = workspace.ok_or(CaptureError::NoWorkspace)?;

    capture_write_inner(
        &workspace,
        &inbox_folder,
        parsed.title.as_deref(),
        &content,
        parsed.url.as_deref(),
        parsed.tags.as_deref(),
        parsed.inbox.unwrap_or(true),
        local_iso8601_now(),
    )
}

/// Pure write — no global state touched. Public so the e2e test can drive
/// it without spinning up the HTTP server.
#[allow(clippy::too_many_arguments)]
pub fn capture_write_inner(
    workspace: &Path,
    inbox_folder: &str,
    title: Option<&str>,
    content: &str,
    url: Option<&str>,
    tags: Option<&[String]>,
    inbox: bool,
    captured_at: String,
) -> Result<String, CaptureError> {
    if !workspace.is_dir() {
        return Err(CaptureError::Io(format!(
            "workspace folder does not exist: {}",
            workspace.display()
        )));
    }

    // Resolve title: explicit → first H1 → "Untitled".
    let derived_title = title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| extract_first_h1(content))
        .unwrap_or_else(|| "Untitled".to_string());

    // Build slug + filename.
    let slug = slugify(&derived_title);
    let prefix = filename_prefix();
    let filename = if slug.is_empty() {
        format!("{prefix}.md")
    } else {
        format!("{prefix}-{slug}.md")
    };

    let target_dir = workspace.join(inbox_folder);
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| CaptureError::Io(format!("mkdir {}: {e}", target_dir.display())))?;

    // Avoid clobbering an existing file with the same minute-resolution name.
    let mut target = target_dir.join(&filename);
    let mut suffix = 2u32;
    while target.exists() {
        let alt = if slug.is_empty() {
            format!("{prefix}-{suffix}.md")
        } else {
            format!("{prefix}-{slug}-{suffix}.md")
        };
        target = target_dir.join(alt);
        suffix += 1;
    }

    let body = render_note(&derived_title, content, url, tags, inbox, &captured_at);
    std::fs::write(&target, body)
        .map_err(|e| CaptureError::Io(format!("write {}: {e}", target.display())))?;

    Ok(target.to_string_lossy().to_string())
}

fn render_note(
    title: &str,
    content: &str,
    url: Option<&str>,
    tags: Option<&[String]>,
    inbox: bool,
    captured_at: &str,
) -> String {
    let mut out = String::with_capacity(content.len() + 256);
    out.push_str("---\n");
    out.push_str(&format!("title: {}\n", yaml_scalar(title)));
    if let Some(u) = url {
        let u = u.trim();
        if !u.is_empty() {
            out.push_str(&format!("source: {}\n", yaml_scalar(u)));
        }
    }
    if let Some(ts) = tags {
        let cleaned: Vec<String> = ts
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if !cleaned.is_empty() {
            let inner = cleaned
                .iter()
                .map(|t| yaml_scalar(t))
                .collect::<Vec<_>>()
                .join(", ");
            out.push_str(&format!("tags: [{inner}]\n"));
        }
    }
    out.push_str(&format!("inbox: {}\n", if inbox { "true" } else { "false" }));
    out.push_str(&format!("captured_at: {captured_at}\n"));
    out.push_str("---\n\n");

    // Strip an existing front-matter block from the incoming content so we
    // don't double-stack `---` blocks if the caller pre-formatted.
    let body = strip_front_matter(content);
    out.push_str(body);
    if !body.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn strip_front_matter(input: &str) -> &str {
    let trimmed = input.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return input;
    }
    let after_first = match trimmed.find('\n') {
        Some(i) => &trimmed[i + 1..],
        None => return input,
    };
    if let Some(end) = after_first.find("\n---") {
        let rest_offset = end + "\n---".len();
        let rest = &after_first[rest_offset..];
        return rest.strip_prefix('\n').unwrap_or(rest);
    }
    input
}

fn yaml_scalar(s: &str) -> String {
    // Quote anything that could trip YAML's plain-scalar parser. Conservative
    // but readable: a `:` is only ambiguous when followed by whitespace
    // (otherwise `https://x.com` would be force-quoted, which is ugly), and
    // a `#` is only a comment marker when preceded by whitespace.
    let mut needs_quote = s.is_empty()
        || s.contains('"')
        || s.contains('\'')
        || s.contains('\n')
        || s.contains(',')
        || s.contains('[')
        || s.contains(']')
        || s.contains('{')
        || s.contains('}')
        || s.starts_with('-')
        || s.starts_with('?')
        || s.starts_with('&')
        || s.starts_with('*')
        || s.starts_with('!')
        || s.starts_with('|')
        || s.starts_with('>')
        || s.starts_with('@')
        || s.starts_with('`')
        || s.starts_with(' ')
        || s.starts_with('#')
        || s.ends_with(' ');
    if !needs_quote {
        // `: ` (colon followed by space) terminates a plain scalar's key.
        let bytes = s.as_bytes();
        for i in 0..bytes.len() {
            if bytes[i] == b':' && (i + 1 >= bytes.len() || bytes[i + 1] == b' ') {
                needs_quote = true;
                break;
            }
            if bytes[i] == b'#' && i > 0 && bytes[i - 1] == b' ' {
                needs_quote = true;
                break;
            }
        }
    }
    if !needs_quote {
        return s.to_string();
    }
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn extract_first_h1(content: &str) -> Option<String> {
    for line in content.lines().take(40) {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("# ") {
            let h = rest.trim().to_string();
            if !h.is_empty() {
                return Some(h);
            }
        }
    }
    None
}

fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if ch.is_alphanumeric() {
            // Preserve CJK / accented chars as-is — readable filenames win
            // on every modern FS we ship to (APFS, NTFS, ext4 all UTF-8).
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    // Cap to avoid pathologically long filenames from giant titles.
    if trimmed.chars().count() > 60 {
        trimmed.chars().take(60).collect()
    } else {
        trimmed
    }
}

/// `YYYY-MM-DD-HHMM` in local time. Hand-rolled to avoid pulling chrono.
fn filename_prefix() -> String {
    let (y, mo, d, h, mi, _) = local_now_parts();
    format!("{:04}-{:02}-{:02}-{:02}{:02}", y, mo, d, h, mi)
}

/// `YYYY-MM-DDTHH:MM:SS+HH:MM` local time, ISO 8601 with offset.
pub fn local_iso8601_now() -> String {
    let (y, mo, d, h, mi, s) = local_now_parts();
    let off_secs = local_offset_seconds();
    let sign = if off_secs >= 0 { '+' } else { '-' };
    let off_abs = off_secs.unsigned_abs();
    let oh = off_abs / 3600;
    let om = (off_abs % 3600) / 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
        y, mo, d, h, mi, s, sign, oh, om
    )
}

/// (year, month, day, hour, minute, second) — local time.
fn local_now_parts() -> (i64, u32, u32, u32, u32, u32) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let local_secs = secs + local_offset_seconds();
    civil_from_unix(local_secs)
}

fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    // Howard Hinnant's civil-from-days. Same algo as git_history.rs.
    let days = secs.div_euclid(86_400);
    let mut sod = secs.rem_euclid(86_400);
    let h = (sod / 3600) as u32;
    sod %= 3600;
    let m = (sod / 60) as u32;
    let s = (sod % 60) as u32;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo_raw = if mp < 10 { mp + 3 } else { mp - 9 };
    let mo = mo_raw as u32;
    let y = if mo <= 2 { y + 1 } else { y };
    (y, mo, d, h, m, s)
}

/// Local UTC offset, in seconds. Best-effort: we ask `localtime_r` via libc.
/// If we can't determine it (e.g. mis-configured zoneinfo), fall back to UTC.
fn local_offset_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    #[cfg(unix)]
    unsafe {
        // Need libc::localtime_r — but tauri brings it in transitively. Use
        // raw FFI to avoid a new top-level dep.
        extern "C" {
            fn localtime_r(time: *const i64, result: *mut Tm) -> *mut Tm;
        }
        #[repr(C)]
        struct Tm {
            tm_sec: i32,
            tm_min: i32,
            tm_hour: i32,
            tm_mday: i32,
            tm_mon: i32,
            tm_year: i32,
            tm_wday: i32,
            tm_yday: i32,
            tm_isdst: i32,
            tm_gmtoff: i64,
            tm_zone: *const i8,
        }
        let t: i64 = secs;
        let mut out: Tm = std::mem::zeroed();
        let r = localtime_r(&t as *const i64, &mut out as *mut Tm);
        if r.is_null() {
            return 0;
        }
        out.tm_gmtoff
    }
    #[cfg(not(unix))]
    {
        let _ = secs;
        // Windows: GetTimeZoneInformation. Skipped for now — the v2.4 capture
        // endpoint is functional with a UTC `captured_at` on Windows; users
        // rarely care that the timestamp is in Z vs. local offset.
        0
    }
}

// ---------------------------------------------------------------------------
// Hand-rolled minimal HTTP/1.1 reader/writer. Same structure as dev_bridge.
// ---------------------------------------------------------------------------

async fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 1024];
    let header_end;
    loop {
        if buf.len() > 64 * 1024 {
            return Err("headers too large".into());
        }
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| format!("read: {e}"))?;
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

    // Body length cap — 8 MiB is plenty for a single note. Anything bigger
    // is almost certainly a misconfigured client trying to push a video.
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

async fn write_resp(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
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

// ---------------------------------------------------------------------------
// Helpers exposed for the e2e test.
// ---------------------------------------------------------------------------

/// Set the in-memory state directly. Used by the e2e test to avoid running
/// the Tauri command layer.
#[doc(hidden)]
pub fn _test_set_state(workspace: Option<PathBuf>, token: String, inbox_folder: String) {
    let mut s = STATE.lock().expect("capture state lock");
    s.workspace = workspace;
    s.token = token;
    s.inbox_folder = inbox_folder;
    s.enabled = true;
}

#[doc(hidden)]
pub fn _test_current_token() -> String {
    STATE.lock().expect("capture state lock").token.clone()
}

#[doc(hidden)]
pub fn _test_handle_capture(body: &[u8]) -> Result<String, CaptureError> {
    handle_capture(body)
}

/// Spin a standalone server for live curl testing — no Tauri AppHandle
/// required. Used by `examples/capture_drive.rs`. Binds, accepts, and
/// returns the bound port. Caller is responsible for keeping the tokio
/// runtime alive.
#[doc(hidden)]
pub async fn _test_bind_and_serve() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind: {e}"))?;
    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    {
        let mut s = STATE.lock().expect("capture state lock");
        s.port = bound_port;
        s.running = true;
    }
    tokio::spawn(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((s, _)) => s,
                Err(_) => continue,
            };
            tokio::spawn(async move {
                // Read + dispatch without needing an AppHandle. We don't
                // call write_port_token here (no app paths), and we won't
                // touch the live STATE.workspace either — caller seeds it.
                let (mut s, _) = (stream, ());
                let req = match read_request(&mut s).await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = write_resp(
                            &mut s,
                            400,
                            "Bad Request",
                            &serde_json::json!({"ok": false, "error": e}).to_string(),
                        )
                        .await;
                        return;
                    }
                };
                if req.method == "OPTIONS" {
                    let _ = write_resp(&mut s, 204, "No Content", "").await;
                    return;
                }
                if req.method == "GET" && req.path == "/" {
                    let _ = write_resp(&mut s, 200, "OK", "{\"ok\":true}").await;
                    return;
                }
                if req.method == "POST" && req.path == "/capture" {
                    let token = STATE.lock().expect("capture state lock").token.clone();
                    if !auth_ok(&req, &token) {
                        let _ = write_resp(
                            &mut s,
                            401,
                            "Unauthorized",
                            "{\"ok\":false,\"error\":\"missing or wrong token\"}",
                        )
                        .await;
                        return;
                    }
                    match handle_capture(&req.body) {
                        Ok(p) => {
                            let body = serde_json::json!({"ok": true, "path": p}).to_string();
                            let _ = write_resp(&mut s, 200, "OK", &body).await;
                        }
                        Err(CaptureError::NoWorkspace) => {
                            let _ = write_resp(
                                &mut s,
                                503,
                                "Service Unavailable",
                                "{\"ok\":false,\"error\":\"no workspace open\"}",
                            )
                            .await;
                        }
                        Err(CaptureError::BadRequest(msg)) => {
                            let body = serde_json::json!({"ok": false, "error": msg}).to_string();
                            let _ = write_resp(&mut s, 400, "Bad Request", &body).await;
                        }
                        Err(CaptureError::Io(msg)) => {
                            let body = serde_json::json!({"ok": false, "error": msg}).to_string();
                            let _ = write_resp(&mut s, 500, "Internal Server Error", &body).await;
                        }
                    }
                    return;
                }
                let _ = write_resp(
                    &mut s,
                    404,
                    "Not Found",
                    "{\"ok\":false,\"error\":\"unknown route\"}",
                )
                .await;
            });
        }
    });
    Ok(bound_port)
}

#[doc(hidden)]
pub fn _test_check_auth(header: Option<&str>) -> bool {
    let token = STATE.lock().expect("capture state lock").token.clone();
    let req = Request {
        method: "POST".into(),
        path: "/capture".into(),
        headers: {
            let mut h = HashMap::new();
            if let Some(v) = header {
                h.insert("authorization".to_string(), v.to_string());
            }
            h
        },
        body: vec![],
    };
    auth_ok(&req, &token)
}

// ---------------------------------------------------------------------------
// Tests — internal helpers only. The full HTTP flow is exercised by
// `tests/capture_e2e_test.rs`.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_basic() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("  multi   spaces  "), "multi-spaces");
        assert_eq!(slugify("---"), "");
    }

    #[test]
    fn slug_keeps_cjk() {
        // CJK chars are preserved (readable on every shipping platform).
        let got = slugify("你好 世界");
        assert!(got.contains('你'));
        assert!(got.contains('世'));
    }

    #[test]
    fn token_is_32_hex() {
        let t = random_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn first_h1_extraction() {
        assert_eq!(
            extract_first_h1("preamble\n\n# The Title\n\nbody"),
            Some("The Title".to_string()),
        );
        assert_eq!(extract_first_h1("no headings here"), None);
    }

    #[test]
    fn yaml_scalar_quotes_when_needed() {
        assert_eq!(yaml_scalar("plain"), "plain");
        assert_eq!(yaml_scalar("has: colon"), "\"has: colon\"");
        assert_eq!(yaml_scalar("with \"quote\""), "\"with \\\"quote\\\"\"");
        // URLs and `time:value` style strings are NOT force-quoted because
        // the colon isn't followed by a space — that's what the YAML spec
        // distinguishes.
        assert_eq!(yaml_scalar("https://example.com"), "https://example.com");
        assert_eq!(yaml_scalar("12:34"), "12:34");
    }

    #[test]
    fn front_matter_is_stripped_when_present() {
        let stripped = strip_front_matter("---\nfoo: 1\n---\nbody\n");
        assert_eq!(stripped, "body\n");
        let untouched = strip_front_matter("no front matter here");
        assert_eq!(untouched, "no front matter here");
    }

    #[test]
    fn render_note_emits_required_fields() {
        let body = render_note(
            "T",
            "hello",
            Some("https://x"),
            Some(&["a".to_string(), "b".to_string()]),
            true,
            "2026-04-26T11:30:00+08:00",
        );
        assert!(body.starts_with("---\n"));
        assert!(body.contains("title: T\n"));
        assert!(body.contains("source: https://x\n"));
        assert!(body.contains("tags: [a, b]\n"));
        assert!(body.contains("inbox: true\n"));
        assert!(body.contains("captured_at: 2026-04-26T11:30:00+08:00\n"));
        assert!(body.ends_with("hello\n"));
    }
}
