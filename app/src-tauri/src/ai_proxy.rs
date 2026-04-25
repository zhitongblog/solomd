//! AI proxy for v2.0 F4 — inline AI rewrite (BYOK).
//!
//! Three providers: OpenAI, Anthropic, Ollama. The user picks one in
//! settings, supplies a model + (optional) base URL + an API key. Keys are
//! stored in the OS-native credential store (macOS keychain, Windows credential
//! manager, libsecret on Linux) via the `keyring` crate — never in
//! localStorage and never logged.
//!
//! The `ai_rewrite` command kicks off a streaming chat completion request to
//! the chosen provider. Chunks are forwarded to the frontend via the
//! `solomd://ai-chunk` event, with `solomd://ai-done` terminating a clean
//! stream and `solomd://ai-error` surfacing any failure. Each request gets a
//! unique `request_id` (returned synchronously) so the overlay can match
//! events to its own pending stream and cancel via `ai_cancel`.
//!
//! Cancellation is cooperative: a per-request `Arc<AtomicBool>` flag is
//! checked on every parsed chunk; setting it makes the streaming task exit on
//! the next iteration and emit `solomd://ai-error` with `"cancelled"`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Public request/event types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct RewriteRequest {
    /// "openai" | "anthropic" | "ollama"
    pub provider: String,
    /// e.g. "gpt-4.1-mini", "claude-haiku-4-5", "llama3.2"
    pub model: String,
    /// System prompt — describes the assistant's role.
    pub system: String,
    /// User instruction (e.g. "Rewrite this in fewer words"). The selection
    /// is appended below as `Text:\n<selection>`.
    pub user: String,
    /// The text the user highlighted in the editor.
    pub selection: String,
    /// Optional override (e.g. self-hosted OpenAI-compatible endpoint, or a
    /// non-default Ollama port). Empty / missing = provider default.
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ChunkEvent {
    request_id: String,
    chunk: String,
}

#[derive(Debug, Clone, Serialize)]
struct DoneEvent {
    request_id: String,
    full_text: String,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorEvent {
    request_id: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Cancellation registry
// ---------------------------------------------------------------------------

static CANCEL_FLAGS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Monotonic suffix so two requests created in the same millisecond don't
/// collide on `request_id`.
static REQ_COUNTER: AtomicU64 = AtomicU64::new(0);

fn make_request_id() -> String {
    let n = REQ_COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("req-{ts}-{n}")
}

fn register_cancel_flag(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = CANCEL_FLAGS.lock() {
        map.insert(id.to_string(), flag.clone());
    }
    flag
}

fn drop_cancel_flag(id: &str) {
    if let Ok(mut map) = CANCEL_FLAGS.lock() {
        map.remove(id);
    }
}

// ---------------------------------------------------------------------------
// Keychain commands
// ---------------------------------------------------------------------------

fn keychain_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("solomd", &format!("ai-{provider}"))
        .map_err(|e| format!("keychain entry failed: {e}"))
}

#[tauri::command]
pub fn ai_set_key(provider: String, key: String) -> Result<(), String> {
    let entry = keychain_entry(&provider)?;
    entry
        .set_password(&key)
        .map_err(|e| format!("failed to store key: {e}"))
}

#[tauri::command]
pub fn ai_has_key(provider: String) -> Result<bool, String> {
    let entry = keychain_entry(&provider)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

#[tauri::command]
pub fn ai_clear_key(provider: String) -> Result<(), String> {
    let entry = keychain_entry(&provider)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

fn read_key(provider: &str) -> Result<String, String> {
    let entry = keychain_entry(provider)?;
    entry
        .get_password()
        .map_err(|e| match e {
            keyring::Error::NoEntry => "no API key set for provider".to_string(),
            other => format!("keychain read failed: {other}"),
        })
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_cancel(request_id: String) -> Result<(), String> {
    if let Ok(map) = CANCEL_FLAGS.lock() {
        if let Some(flag) = map.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Streaming entrypoint
// ---------------------------------------------------------------------------

/// Kicks off a streaming AI rewrite. Returns the synthetic request id; the
/// caller listens for `solomd://ai-chunk`, `solomd://ai-done`, and
/// `solomd://ai-error` events filtered by that id.
#[tauri::command]
pub async fn ai_rewrite(app: AppHandle, request: RewriteRequest) -> Result<String, String> {
    let request_id = make_request_id();
    let cancel = register_cancel_flag(&request_id);

    // Ollama doesn't need a key — only OpenAI / Anthropic do.
    let api_key = if request.provider == "ollama" {
        String::new()
    } else {
        match read_key(&request.provider) {
            Ok(k) => k,
            Err(e) => {
                drop_cancel_flag(&request_id);
                return Err(e);
            }
        }
    };

    let id_for_task = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = match request.provider.as_str() {
            "openai" => run_openai(&app, &id_for_task, &request, &api_key, cancel.clone()).await,
            "anthropic" => {
                run_anthropic(&app, &id_for_task, &request, &api_key, cancel.clone()).await
            }
            "ollama" => run_ollama(&app, &id_for_task, &request, cancel.clone()).await,
            other => Err(format!("unknown provider: {other}")),
        };

        match result {
            Ok(full_text) => {
                let _ = app.emit(
                    "solomd://ai-done",
                    DoneEvent {
                        request_id: id_for_task.clone(),
                        full_text,
                    },
                );
            }
            Err(err) => {
                let _ = app.emit(
                    "solomd://ai-error",
                    ErrorEvent {
                        request_id: id_for_task.clone(),
                        error: err,
                    },
                );
            }
        }
        drop_cancel_flag(&id_for_task);
    });

    Ok(request_id)
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

fn build_user_message(req: &RewriteRequest) -> String {
    format!("{}\n\nText:\n{}", req.user, req.selection)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Generous timeout per request; streaming connections can be long.
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))
}

fn cancelled() -> String {
    "cancelled".to_string()
}

fn emit_chunk(app: &AppHandle, request_id: &str, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    let _ = app.emit(
        "solomd://ai-chunk",
        ChunkEvent {
            request_id: request_id.to_string(),
            chunk: chunk.to_string(),
        },
    );
}

// --- OpenAI -----------------------------------------------------------------

async fn run_openai(
    app: &AppHandle,
    request_id: &str,
    req: &RewriteRequest,
    api_key: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let base = req
        .base_url
        .as_ref()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.openai.com".to_string());
    let url = format!("{base}/v1/chat/completions");

    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": [
            {"role": "system", "content": req.system},
            {"role": "user", "content": build_user_message(req)},
        ],
    });

    let client = http_client()?;
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("openai request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("openai {status}: {txt}"));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let bytes = chunk.map_err(|e| format!("openai stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        // Process complete SSE events terminated by blank line.
        while let Some(idx) = find_event_boundary(&buf) {
            let event = buf[..idx].to_string();
            // Drop the boundary (\n\n or \r\n\r\n).
            let after = if buf[idx..].starts_with("\r\n\r\n") {
                idx + 4
            } else {
                idx + 2
            };
            buf = buf[after..].to_string();

            for line in event.lines() {
                let line = line.trim_start();
                let payload = match line.strip_prefix("data:") {
                    Some(p) => p.trim(),
                    None => continue,
                };
                if payload == "[DONE]" {
                    return Ok(full);
                }
                let json: serde_json::Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(content) = json
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|s| s.as_str())
                {
                    if !content.is_empty() {
                        full.push_str(content);
                        emit_chunk(app, request_id, content);
                    }
                }
            }
        }
    }
    Ok(full)
}

// --- Anthropic --------------------------------------------------------------

async fn run_anthropic(
    app: &AppHandle,
    request_id: &str,
    req: &RewriteRequest,
    api_key: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let base = req
        .base_url
        .as_ref()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{base}/v1/messages");

    let body = serde_json::json!({
        "model": req.model,
        "system": req.system,
        "messages": [
            {"role": "user", "content": build_user_message(req)},
        ],
        "stream": true,
        "max_tokens": 4096,
    });

    let client = http_client()?;
    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic {status}: {txt}"));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let bytes = chunk.map_err(|e| format!("anthropic stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = find_event_boundary(&buf) {
            let event = buf[..idx].to_string();
            let after = if buf[idx..].starts_with("\r\n\r\n") {
                idx + 4
            } else {
                idx + 2
            };
            buf = buf[after..].to_string();

            // Anthropic SSE: `event: <type>\ndata: <json>`. We only need the
            // `data:` line; type is encoded in the JSON's `type` field too.
            for line in event.lines() {
                let line = line.trim_start();
                let payload = match line.strip_prefix("data:") {
                    Some(p) => p.trim(),
                    None => continue,
                };
                let json: serde_json::Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let kind = json.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match kind {
                    "content_block_delta" => {
                        if let Some(text) = json
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|s| s.as_str())
                        {
                            if !text.is_empty() {
                                full.push_str(text);
                                emit_chunk(app, request_id, text);
                            }
                        }
                    }
                    "message_stop" => {
                        return Ok(full);
                    }
                    "error" => {
                        let msg = json
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("anthropic stream error");
                        return Err(msg.to_string());
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(full)
}

// --- Ollama -----------------------------------------------------------------

async fn run_ollama(
    app: &AppHandle,
    request_id: &str,
    req: &RewriteRequest,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let base = req
        .base_url
        .as_ref()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let url = format!("{base}/api/chat");

    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": [
            {"role": "system", "content": req.system},
            {"role": "user", "content": build_user_message(req)},
        ],
    });

    let client = http_client()?;
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ollama request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("ollama {status}: {txt}"));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let bytes = chunk.map_err(|e| format!("ollama stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        // Ollama emits one JSON object per line.
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
            if let Some(content) = json
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|s| s.as_str())
            {
                if !content.is_empty() {
                    full.push_str(content);
                    emit_chunk(app, request_id, content);
                }
            }
            if json.get("done").and_then(|b| b.as_bool()).unwrap_or(false) {
                return Ok(full);
            }
            if let Some(err) = json.get("error").and_then(|s| s.as_str()) {
                return Err(format!("ollama: {err}"));
            }
        }
    }
    Ok(full)
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/// Returns the byte index of the start of the blank-line separator that
/// terminates an SSE event, or None if no complete event is buffered yet.
/// Handles both `\n\n` and `\r\n\r\n` separators.
fn find_event_boundary(buf: &str) -> Option<usize> {
    // Prefer CRLF if both happen to appear; the trim in the caller skips it.
    if let Some(i) = buf.find("\r\n\r\n") {
        return Some(i);
    }
    buf.find("\n\n")
}
