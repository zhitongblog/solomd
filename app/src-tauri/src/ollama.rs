//! Ollama polish for v4.0 Pillar 5.
//!
//! Pure additive: the existing `ai_proxy::run_ollama` chat runner is left
//! untouched. This module adds three things on top:
//!
//!   * `detect()` — a 1-second probe of `http://localhost:11434/api/tags` so
//!     the AI Settings panel can show a green / red status pill plus the
//!     list of installed models without the user having to click "Test
//!     connection".
//!   * `pull(model, on_chunk)` — a streaming wrapper around `/api/pull`
//!     that surfaces `{ status, completed, total }` chunks so the panel can
//!     draw a thin progress bar while qwen2.5:1.5b downloads.
//!   * `open_install_page()` — opens https://ollama.com via
//!     `tauri-plugin-opener` for the "Install Ollama" CTA when detection
//!     fails.
//!
//! All three are exposed as Tauri commands at the bottom of the file. The
//! base URL can be overridden for tests via the `SOLOMD_OLLAMA_BASE_URL`
//! env var, which is the hook the integration tests use to point `detect`
//! at a fixture HTTP server on a random port.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Result of probing the local Ollama HTTP server.
///
/// `ok` is true iff `/api/tags` responded with a 2xx and a parseable body.
/// `version` is best-effort — Ollama's `/api/version` endpoint is a separate
/// call and we may skip it on older servers; treat `None` as "unknown".
/// `models` is the list of installed model tags (e.g. `["qwen2.5:1.5b"]`),
/// possibly empty if the user has Ollama running but hasn't pulled anything.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Detection {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub models: Vec<String>,
}

/// One streaming progress chunk from `/api/pull`. Mirrors the JSON-Lines
/// keys Ollama emits; `completed` and `total` may be missing for the
/// "pulling manifest" / "verifying sha256 digest" / "success" status lines.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PullProgress {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// `true` once Ollama emits the final "success" status (or `done:true`
    /// in newer servers), so the frontend can flip the UI to "Pulled —
    /// ready" without polling `/api/tags` again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
}

// ---------------------------------------------------------------------------
// Cancellation registry (separate from ai_proxy's so pulls can be cancelled
// independently of in-flight chat streams).
// ---------------------------------------------------------------------------

static PULL_CANCEL_FLAGS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn register_pull_cancel(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = PULL_CANCEL_FLAGS.lock() {
        map.insert(id.to_string(), flag.clone());
    }
    flag
}

fn drop_pull_cancel(id: &str) {
    if let Ok(mut map) = PULL_CANCEL_FLAGS.lock() {
        map.remove(id);
    }
}

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

/// The address we probe when nothing else is configured.
pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

/// Clean up a user-typed Ollama address so it can be joined with
/// `/api/...`. Users setting up a LAN server type things like
/// `192.168.1.20:11434`, `http://nas:11434/`, or paste the OpenAI-compat
/// URL `http://nas:11434/v1` out of another tool's docs — all three of
/// which used to produce a request that could never succeed.
///
///   * empty / whitespace-only  → `None` (caller falls back to the default)
///   * no scheme                → `http://` is prepended
///   * trailing `/`             → dropped
///   * trailing `/v1`           → dropped (that's the OpenAI-compat prefix;
///                                the native API lives at the root)
pub fn normalize_base_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let cleaned = with_scheme
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Returns the Ollama base URL to probe / pull from.
///
/// Precedence: the `SOLOMD_OLLAMA_BASE_URL` env var (used by integration
/// tests to point at a fixture server on a random port, and as an escape
/// hatch for packaged deployments) → the caller-supplied override, which
/// is the Base URL field in AI Settings → `http://localhost:11434`.
pub fn base_url(override_base: Option<&str>) -> String {
    if let Some(env) = std::env::var("SOLOMD_OLLAMA_BASE_URL")
        .ok()
        .and_then(|s| normalize_base_url(&s))
    {
        return env;
    }
    override_base
        .and_then(normalize_base_url)
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Is `base` pointing at this machine? Local probes get a tight 1s budget
/// (a missing Ollama refuses the connection instantly anyway); a LAN or
/// tunnelled host needs a longer one before we call it "not detected".
fn is_local(base: &str) -> bool {
    let host = base
        .split("://")
        .nth(1)
        .unwrap_or(base)
        .split('/')
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    // IPv6 literals are bracketed (`[::1]:11434`); everything else splits
    // on the port colon.
    let host = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

/// Probe the local Ollama server. Always returns a `Detection`, never an
/// error — connection refused, DNS failure, timeout, malformed JSON all
/// collapse to `Detection { ok: false, .. }` so the UI can render a single
/// "Not detected" branch.
pub async fn detect(override_base: Option<&str>) -> Detection {
    let base = base_url(override_base);
    // A LAN box may be a Wi-Fi hop or a VPN away; 1s is enough for
    // localhost but wrongly reports a healthy remote server as missing.
    let budget = if is_local(&base) { 1 } else { 5 };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(budget))
        .connect_timeout(Duration::from_secs(budget))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Detection::default(),
    };

    let url = format!("{base}/api/tags");
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return Detection::default(),
    };
    if !resp.status().is_success() {
        return Detection::default();
    }
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Detection::default(),
    };

    let models = json
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Best-effort version probe. We don't fail detection if it errors —
    // older Ollama servers may not have /api/version, and the AI Settings
    // panel doesn't need it for the green dot.
    let version = match client.get(format!("{base}/api/version")).send().await {
        Ok(r) if r.status().is_success() => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("version").and_then(|s| s.as_str()).map(String::from)),
        _ => None,
    };

    Detection {
        ok: true,
        version,
        models,
    }
}

// ---------------------------------------------------------------------------
// pull()
// ---------------------------------------------------------------------------

/// Stream `/api/pull` progress for `model`. `on_chunk` is invoked once per
/// JSON line received; cancellation is checked between lines.
///
/// The Ollama wire format for `/api/pull` is JSON-Lines:
/// ```json
/// {"status":"pulling manifest"}
/// {"status":"pulling abc123","completed":1024,"total":1048576,"digest":"sha256:..."}
/// {"status":"success"}
/// ```
/// We pass these through almost verbatim; `done` is set on the final
/// "success" line so the frontend can stop the spinner without sniffing
/// for status strings.
pub async fn pull<F>(
    model: &str,
    override_base: Option<&str>,
    cancel: Arc<AtomicBool>,
    on_chunk: F,
) -> Result<(), String>
where
    F: Fn(PullProgress) + Send,
{
    let base = base_url(override_base);
    let url = format!("{base}/api/pull");
    let client = reqwest::Client::builder()
        // No timeout — pulls can take many minutes on a 10+ GB model.
        // Cancellation is the user's escape hatch.
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("ollama http client init failed: {e}"))?;

    let body = serde_json::json!({ "name": model, "stream": true });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ollama pull request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("ollama pull HTTP {status}: {txt}"));
    }

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        let bytes = chunk.map_err(|e| format!("ollama pull stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf = buf[nl + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            let json: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // Surface server-reported errors as a hard failure rather than
            // a progress chunk so the UI can show a red toast.
            if let Some(err) = json.get("error").and_then(|s| s.as_str()) {
                return Err(format!("ollama: {err}"));
            }
            let status = json
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let completed = json.get("completed").and_then(|n| n.as_u64());
            let total = json.get("total").and_then(|n| n.as_u64());
            // Newer Ollama servers emit `done:true` on the terminal line;
            // older ones rely on the `"status":"success"` text. Accept both.
            let done_flag =
                json.get("done").and_then(|b| b.as_bool()).unwrap_or(false) || status == "success";

            on_chunk(PullProgress {
                status,
                completed,
                total,
                done: done_flag,
            });

            if done_flag {
                return Ok(());
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Probe the local Ollama server. Always succeeds; check `Detection.ok` to
/// branch the UI.
#[tauri::command]
pub async fn ollama_detect(base_url: Option<String>) -> Detection {
    detect(base_url.as_deref()).await
}

#[derive(Debug, Clone, Serialize)]
struct PullEvent {
    request_id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    done: bool,
}

/// Pull `model` from the Ollama registry, emitting `solomd://ollama-pull`
/// events tagged with `request_id`. Resolves once the stream finishes (or
/// the user cancels via `ollama_cancel_pull`); the final event has
/// `done: true`.
#[tauri::command]
pub async fn ollama_pull(
    app: AppHandle,
    model: String,
    request_id: String,
    base_url: Option<String>,
) -> Result<(), String> {
    let cancel = register_pull_cancel(&request_id);
    let app_for_chunks = app.clone();
    let id_for_chunks = request_id.clone();
    let result = pull(&model, base_url.as_deref(), cancel.clone(), move |p| {
        let _ = app_for_chunks.emit(
            "solomd://ollama-pull",
            PullEvent {
                request_id: id_for_chunks.clone(),
                status: p.status,
                completed: p.completed,
                total: p.total,
                done: p.done,
            },
        );
    })
    .await;
    drop_pull_cancel(&request_id);
    result
}

/// Cancel an in-flight `ollama_pull`. Idempotent: cancelling an unknown id
/// is a no-op.
#[tauri::command]
pub fn ollama_cancel_pull(request_id: String) -> Result<(), String> {
    if let Ok(map) = PULL_CANCEL_FLAGS.lock() {
        if let Some(flag) = map.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

/// Open https://ollama.com in the user's default browser. Used by the
/// "Install Ollama" CTA when detection fails.
#[tauri::command]
pub async fn open_ollama_install_page(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://ollama.com", None::<&str>)
        .map_err(|e| format!("failed to open install page: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Tiny single-shot HTTP/1.1 server that serves the same response body
    /// to every connection. Returns the bound address. The server stays up
    /// for `connections` accepts, then exits.
    ///
    /// We hand-roll this rather than pull in `wiremock` because the only
    /// new dev-dep we'd otherwise need is hyper/wiremock (~50 MB of build
    /// time). `tokio::net` is already in the main deps.
    async fn serve_fixture(body: &'static str, status_line: &'static str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // Serve up to 4 requests so the same fixture can answer
            // /api/tags + /api/version probes inside one detect() call.
            for _ in 0..4 {
                let (mut socket, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        addr
    }

    /// Server that never responds — used to verify the 1-second timeout.
    async fn serve_blackhole() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                // Hold the connection open without writing anything so the
                // client times out reading the response.
                let _ = socket.read(&mut [0u8; 1024]).await;
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        });
        addr
    }

    /// Guard that sets SOLOMD_OLLAMA_BASE_URL on construct and unsets on
    /// drop. Tests run on multiple threads by default, but we still want
    /// each test to see its own URL — so we serialize via the same env var
    /// + a process-wide mutex.
    struct EnvGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }
    impl EnvGuard {
        fn set(url: String) -> Self {
            static LOCK: Lazy<std::sync::Mutex<()>> = Lazy::new(|| std::sync::Mutex::new(()));
            let lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
            std::env::set_var("SOLOMD_OLLAMA_BASE_URL", url);
            EnvGuard { _lock: lock }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("SOLOMD_OLLAMA_BASE_URL");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_happy_path_returns_models() {
        let addr = serve_fixture(
            r#"{"models":[{"name":"qwen2.5:1.5b"},{"name":"llama3.2"}]}"#,
            "200 OK",
        )
        .await;
        let _g = EnvGuard::set(format!("http://{addr}"));
        let d = detect(None).await;
        assert!(d.ok, "expected ok detection, got {d:?}");
        assert_eq!(
            d.models,
            vec!["qwen2.5:1.5b".to_string(), "llama3.2".to_string()]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_empty_models_still_ok() {
        let addr = serve_fixture(r#"{"models":[]}"#, "200 OK").await;
        let _g = EnvGuard::set(format!("http://{addr}"));
        let d = detect(None).await;
        assert!(d.ok);
        assert!(d.models.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_malformed_json_is_not_ok() {
        let addr = serve_fixture(r#"this is not json"#, "200 OK").await;
        let _g = EnvGuard::set(format!("http://{addr}"));
        let d = detect(None).await;
        assert!(!d.ok);
        assert!(d.models.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_http_error_is_not_ok() {
        let addr = serve_fixture(r#"{"err":"x"}"#, "500 Internal Server Error").await;
        let _g = EnvGuard::set(format!("http://{addr}"));
        let d = detect(None).await;
        assert!(!d.ok);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_timeout_within_two_seconds() {
        let addr = serve_blackhole().await;
        let _g = EnvGuard::set(format!("http://{addr}"));
        let started = std::time::Instant::now();
        let d = detect(None).await;
        let elapsed = started.elapsed();
        assert!(!d.ok);
        // The 1s timeout + a generous slack for CI; reqwest's request
        // timeout fires at ~1.0s, so 2s is plenty of headroom.
        assert!(
            elapsed < Duration::from_secs(2),
            "detect() took too long: {elapsed:?}",
        );
    }

    #[test]
    fn normalize_base_url_fills_in_the_missing_bits() {
        // A bare LAN address is what users actually type.
        assert_eq!(
            normalize_base_url("192.168.1.20:11434").as_deref(),
            Some("http://192.168.1.20:11434"),
        );
        assert_eq!(
            normalize_base_url("  http://nas.local:11434/  ").as_deref(),
            Some("http://nas.local:11434"),
        );
        // The OpenAI-compat suffix people copy out of other tools' docs.
        assert_eq!(
            normalize_base_url("http://nas:11434/v1").as_deref(),
            Some("http://nas:11434"),
        );
        assert_eq!(
            normalize_base_url("https://ollama.example.com").as_deref(),
            Some("https://ollama.example.com"),
        );
        assert_eq!(normalize_base_url("   "), None);
        assert_eq!(normalize_base_url(""), None);
    }

    #[test]
    fn base_url_uses_the_override_then_the_default() {
        // An empty env var still takes the process-wide lock, so this test
        // can't race the ones that set a real fixture URL.
        let _g = EnvGuard::set(String::new());
        assert_eq!(base_url(None), DEFAULT_BASE_URL);
        assert_eq!(base_url(Some("")), DEFAULT_BASE_URL);
        assert_eq!(base_url(Some("10.0.0.5:11434")), "http://10.0.0.5:11434");
    }

    #[test]
    fn base_url_env_var_beats_the_override() {
        let _g = EnvGuard::set("http://127.0.0.1:9/".to_string());
        assert_eq!(base_url(Some("10.0.0.5:11434")), "http://127.0.0.1:9");
    }

    #[test]
    fn is_local_only_matches_this_machine() {
        assert!(is_local("http://localhost:11434"));
        assert!(is_local("http://127.0.0.1:11434"));
        assert!(is_local("http://[::1]:11434"));
        assert!(!is_local("http://192.168.1.20:11434"));
        assert!(!is_local("https://ollama.example.com"));
    }

    /// The LAN regression: a server that is up but NOT on localhost has to
    /// be detected when the user points the Base URL field at it. Before
    /// v4.11.18 `detect()` ignored the field and always probed localhost,
    /// so every remote Ollama reported "not detected".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_honours_the_configured_base_url() {
        let addr = serve_fixture(r#"{"models":[{"name":"qwen2.5:7b"}]}"#, "200 OK").await;
        // Empty env var (guard held) — the override alone must win over the
        // localhost default.
        let _g = EnvGuard::set(String::new());
        let d = detect(Some(&format!("{addr}"))).await; // scheme-less, as typed
        assert!(d.ok, "expected ok detection, got {d:?}");
        assert_eq!(d.models, vec!["qwen2.5:7b".to_string()]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_connection_refused_is_not_ok() {
        // 127.0.0.1:1 is reserved/closed on every OS we ship for.
        let _g = EnvGuard::set("http://127.0.0.1:1".to_string());
        let d = detect(None).await;
        assert!(!d.ok);
        assert!(d.models.is_empty());
    }
}
