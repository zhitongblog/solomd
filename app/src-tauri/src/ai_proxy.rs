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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

// Use `super::` paths so this module compiles under both the lib mount
// (`pub mod ai_proxy` in lib.rs) and the bin mount (`#[path = "ai_proxy.rs"]
// mod ai_proxy` in runner.rs). Both put our siblings one scope up.
use super::agent_run::{RunHandle, RunKind, TraceStep};
use super::agent_tools;
use super::pricing;

// ---------------------------------------------------------------------------
// Provider aliases
// ---------------------------------------------------------------------------

/// Resolve a provider id to its canonical form. Today the only alias is
/// `local` → `ollama`, introduced for v4.0 Recipes (P2): YAML files written
/// by hand often say `provider: local`, which is more intuitive than the
/// brand name. Both ai-providers.ts and the Recipe loader call this helper
/// so the aliasing lives in exactly one place.
pub fn resolve_provider(id: &str) -> &str {
    match id {
        "local" => "ollama",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// Public request/event types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct RewriteRequest {
    /// Stable id used for keychain key storage (e.g. "openai", "deepseek",
    /// "qwen"). Each provider gets its own key slot in the OS keychain so
    /// users can keep multiple keys at once.
    pub provider: String,
    /// API wire format. Maps to the streaming implementation used:
    ///   - "openai"     — OpenAI Chat Completions (also DeepSeek, Qwen,
    ///                    GLM, Kimi, Doubao, xAI, Mistral, Groq, Gemini's
    ///                    OpenAI-compat endpoint, etc.)
    ///   - "anthropic"  — Anthropic Messages API
    ///   - "ollama"     — local Ollama (no API key required)
    /// Defaults to `provider` when missing for backwards compatibility.
    #[serde(default)]
    pub api_format: Option<String>,
    /// Model id, e.g. "gpt-4.1-mini", "deepseek-chat", "qwen-plus".
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
    /// Optional caller-provided request id. When present, the backend uses
    /// this instead of `make_request_id()` so the frontend can wire its
    /// event listeners BEFORE invoking the command — closes a race where
    /// a fast failure (e.g. ollama 404 on a missing model) emits
    /// `ai-error` while the JS listener still has `requestId === null`
    /// and silently drops the error, leaving the inline rewrite overlay
    /// stuck on "Rewriting…" with no visible feedback.
    #[serde(default)]
    pub request_id: Option<String>,
}

/// v4.0 pillar 1 — Inline Agent Panel chat message.
///
/// Roles follow the OpenAI chat convention: `system` / `user` / `assistant`.
/// `tool` is added in the v4.0 tool-call loop — the message body for a
/// `tool` role is the tool result string, paired with `tool_call_id`.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Set on `tool` role messages — the id of the tool_call this is
    /// answering. Frontend doesn't have to populate this on user messages;
    /// the tool-call loop fills it in for results it appends.
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

/// Multi-turn chat request. Same provider/model/base_url plumbing as
/// `RewriteRequest` but takes a full `messages` array — the caller is
/// responsible for assembling history + system prompt.
///
/// v4.0 fields per C3.2:
/// - `tools`: which tool names to enable (None = all read-only).
/// - `allow_write`: gates write_note / append_to_note. Default false.
/// - `run_id`: existing run id to attach to. If absent, ai_chat mints one.
/// - `workspace`: absolute path. Required if run_id is absent (so we know
///   where to write the run dir). Optional if run_id is supplied (the run
///   dir is already created and we resolve back to its workspace).
/// - `tool_loop_cap`: max number of tool-use iterations. Default 8.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub provider: String,
    #[serde(default)]
    pub api_format: Option<String>,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub allow_write: Option<bool>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub tool_loop_cap: Option<u32>,
    /// Optional caller-provided request id. When present, the backend uses
    /// this instead of `make_request_id()` so the frontend can wire its
    /// event listeners BEFORE invoking the command — closes a race where
    /// a fast failure (e.g. ollama 404 on a missing model) emits
    /// `ai-error` while the JS listener still has `currentRunId === null`
    /// and silently drops the error, leaving the panel stuck on
    /// "streaming…" with no visible feedback.
    #[serde(default)]
    pub request_id: Option<String>,
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

/// v4.0 — emitted before each tool dispatch so the frontend can show a
/// pending tool-call card. Matches C3.2 step 1.
#[derive(Debug, Clone, Serialize)]
struct ToolCallEvent {
    request_id: String,
    run_id: String,
    tool_call_id: String,
    tool: String,
    args: Value,
}

/// v4.0 — emitted after the in-process tool returns. Matches C3.2 step 3.
#[derive(Debug, Clone, Serialize)]
struct ToolResultEvent {
    request_id: String,
    run_id: String,
    tool_call_id: String,
    result: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Emitted alongside `solomd://ai-done` — gives the frontend the run_id so
/// it can stash a "view trace" pointer per assistant message. The legacy
/// `DoneEvent` keeps shipping for backwards compat with the existing UI.
#[derive(Debug, Clone, Serialize)]
struct RunStartedEvent {
    request_id: String,
    run_id: String,
}

// ---------------------------------------------------------------------------
// Cancellation registry
// ---------------------------------------------------------------------------

static CANCEL_FLAGS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Bug O: per-(provider, base_url) memo of OpenAI-compat servers that
/// reject `stream_options.include_usage` with a 400. Some older self-hosted
/// vLLM forks and a couple of SiliconFlow tiers don't recognise the field
/// and respond `{"error": "unknown body param: stream_options"}`. The
/// streaming path retries once without the field on first 400 and caches
/// the key here so subsequent requests skip directly to the no-options
/// body. Keyed as `"<provider>|<base_url>"`. In-memory only — re-checks
/// once per process restart, no persistence.
static STREAM_OPTIONS_UNSUPPORTED: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn stream_options_cache_key(provider: &str, base_url: &str) -> String {
    format!("{provider}|{base_url}")
}

fn stream_options_unsupported(key: &str) -> bool {
    STREAM_OPTIONS_UNSUPPORTED
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .map(|s| s.contains(key))
        .unwrap_or(false)
}

fn mark_stream_options_unsupported(key: &str) {
    if let Ok(mut s) = STREAM_OPTIONS_UNSUPPORTED
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
    {
        s.insert(key.to_string());
    }
}

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

/// Make a minimal call to the provider to confirm the key + base_url work.
/// Returns Ok with a short message (e.g. model count) on success, Err with
/// a human-readable reason on failure. Used by AISettings to show a green
/// "Verified ✓" / red "Invalid key" pill right after the user clicks Save.
#[tauri::command]
pub async fn ai_verify_key(
    provider: String,
    key: Option<String>,
    api_format: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    let format = api_format.unwrap_or_else(|| provider.clone());
    let key_str = match key {
        Some(k) if !k.trim().is_empty() => k,
        _ => match read_key(&provider) {
            Ok(k) => k,
            Err(e) => return Err(e),
        },
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    match format.as_str() {
        "openai" => {
            let base = base_url
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            let url = format!("{}/models", base.trim_end_matches('/'));
            let res = client
                .get(&url)
                .bearer_auth(&key_str)
                .send()
                .await
                .map_err(|e| format!("network: {e}"))?;
            let status = res.status();
            if status.is_success() {
                let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
                let n = body
                    .get("data")
                    .and_then(|d| d.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                Ok(format!("OK · {n} models available"))
            } else {
                let txt = res.text().await.unwrap_or_default();
                Err(format!("HTTP {status}: {}", truncate(&txt, 200)))
            }
        }
        "anthropic" => {
            // Anthropic doesn't have a free /models endpoint — send a 1-token ping.
            let url = "https://api.anthropic.com/v1/messages";
            let body = serde_json::json!({
                "model": "claude-haiku-4-5",
                "max_tokens": 1,
                "messages": [{"role":"user","content":"ping"}]
            });
            let res = client
                .post(url)
                .header("x-api-key", &key_str)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("network: {e}"))?;
            let status = res.status();
            if status.is_success() {
                Ok("OK · key accepted".to_string())
            } else {
                let txt = res.text().await.unwrap_or_default();
                Err(format!("HTTP {status}: {}", truncate(&txt, 200)))
            }
        }
        "ollama" => {
            let base = base_url
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            let url = format!("{}/api/tags", base.trim_end_matches('/'));
            let res = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("network: {e} (is Ollama running?)"))?;
            if res.status().is_success() {
                let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
                let n = body
                    .get("models")
                    .and_then(|d| d.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                Ok(format!("OK · {n} local models"))
            } else {
                Err(format!("HTTP {}: ollama not reachable", res.status()))
            }
        }
        other => Err(format!("unknown api_format: {other}")),
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
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

/// Public counterpart of `read_key`. The recipe runner (and any future
/// outside-of-`ai_chat` caller that wants to drive `run_chat_*_loop`) needs
/// this to fetch the per-provider key the same way the streaming
/// entrypoint does. No new logic — just reuses the keychain entry helper.
pub fn get_api_key(provider: &str) -> Result<String, String> {
    read_key(provider)
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

/// v4.0 pillar 1 — multi-turn chat streaming entrypoint with tool-call loop.
///
/// Returns a request id; events are emitted on:
///   - `solomd://ai-chunk` — streaming text deltas
///   - `solomd://ai-tool-call` — about to dispatch a tool (C3.2 step 1)
///   - `solomd://ai-tool-result` — tool returned (C3.2 step 3)
///   - `solomd://ai-done` — final assistant turn ended cleanly
///   - `solomd://ai-error` — any failure
///   - `solomd://ai-run-started` — emitted right after run dir is created;
///                                 carries the run_id for trace replay UI
///
/// Workspace persistence: when `run_id` is absent and `workspace` is
/// provided, ai_chat mints a new run dir under
/// `<workspace>/.solomd/agent-runs/<run-id>/` and persists the conversation
/// + every tool call to `trace.jsonl` + `run.md` per C1 / C2.
///
/// Ollama path stays single-turn — we don't wire tools because the open
/// models we ship don't reliably emit tool_use blocks. Degrades gracefully:
/// if the user has tools enabled but selects Ollama, the chat just runs
/// without tool calls.
#[tauri::command]
pub async fn ai_chat(app: AppHandle, request: ChatRequest) -> Result<String, String> {
    let request_id = request
        .request_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(make_request_id);
    let cancel = register_cancel_flag(&request_id);

    let format = request
        .api_format
        .clone()
        .unwrap_or_else(|| request.provider.clone());

    let api_key = if format == "ollama" {
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

    // Set up the run handle if a workspace was supplied. We can't fail the
    // command outright if the dir creation hits a permission error — the
    // chat should still happen, just without on-disk persistence. In that
    // case `run_handle` stays None and trace writes silently no-op.
    let run_handle: Option<Arc<RunHandle>> = match (&request.run_id, &request.workspace) {
        (Some(_run_id), Some(_ws)) => {
            // P3 will land "attach to existing run". For v4.0, panel chats
            // always start a fresh run; this branch is a placeholder.
            None
        }
        (None, Some(ws)) if !ws.is_empty() => {
            let path = std::path::Path::new(ws);
            match RunHandle::start(
                path,
                RunKind::Panel,
                &request.provider,
                &request.model,
                None,
            ) {
                Ok(h) => {
                    let h = Arc::new(h);
                    let _ = app.emit(
                        "solomd://ai-run-started",
                        RunStartedEvent {
                            request_id: request_id.clone(),
                            run_id: h.run_id.clone(),
                        },
                    );
                    Some(h)
                }
                Err(_e) => None,
            }
        }
        _ => None,
    };

    // Persist the user prompt(s) into run.md / trace.jsonl up front so
    // partial runs are inspectable.
    if let Some(rh) = &run_handle {
        for m in &request.messages {
            if m.role == "system" {
                let _ = rh.append_trace(TraceStep {
                    kind: "prompt".to_string(),
                    role: Some("system".to_string()),
                    content: Some(m.content.clone()),
                    ..Default::default()
                });
            }
        }
        if let Some(last_user) = request
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .cloned()
        {
            let _ = rh.append_trace(TraceStep {
                kind: "prompt".to_string(),
                role: Some("user".to_string()),
                content: Some(last_user.content.clone()),
                ..Default::default()
            });
            let _ = rh.append_run_md(&format!("## User\n\n{}\n\n", last_user.content));
        }
    }

    let id_for_task = request_id.clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        // Each provider runner now returns `(full_text, tokens_in_total,
        // tokens_out_total)` so the panel can persist real numbers into
        // meta.json + the run_ended trace step. The cost is computed
        // here with the shared pricing table — provider+model aware,
        // 0 for unknown pairs.
        let result: Result<(String, u64, u64), String> = match format.as_str() {
            "openai" => {
                run_chat_openai_loop(
                    &app_clone,
                    &id_for_task,
                    &request,
                    &api_key,
                    cancel.clone(),
                    run_handle.clone(),
                )
                .await
            }
            "anthropic" => {
                run_chat_anthropic_loop(
                    &app_clone,
                    &id_for_task,
                    &request,
                    &api_key,
                    cancel.clone(),
                    run_handle.clone(),
                )
                .await
            }
            "ollama" => {
                run_chat_ollama(&app_clone, &id_for_task, &request, cancel.clone()).await
            }
            other => Err(format!("unknown api_format: {other}")),
        };

        match &result {
            Ok((full_text, tokens_in, tokens_out)) => {
                let cost = pricing::estimate_cost_usd(
                    &request.provider,
                    &request.model,
                    *tokens_in,
                    *tokens_out,
                );
                if let Some(rh) = &run_handle {
                    let _ = rh.append_run_md(&format!("## Assistant\n\n{}\n\n", full_text));
                    let _ = rh.finish("ok", *tokens_in, *tokens_out, cost, None);
                }
                let _ = app_clone.emit(
                    "solomd://ai-done",
                    DoneEvent {
                        request_id: id_for_task.clone(),
                        full_text: full_text.clone(),
                    },
                );
            }
            Err(err) => {
                if let Some(rh) = &run_handle {
                    let status = if err == "cancelled" { "cancelled" } else { "error" };
                    // We don't have per-turn totals on the error path —
                    // the runner returned early. Persist 0/0 + 0 cost and
                    // let the user see the "error" status; partial token
                    // counts can be read from any model_done lines in the
                    // trace.jsonl if needed.
                    let _ = rh.finish(status, 0, 0, 0.0, Some(err.clone()));
                }
                let _ = app_clone.emit(
                    "solomd://ai-error",
                    ErrorEvent {
                        request_id: id_for_task.clone(),
                        error: err.clone(),
                    },
                );
            }
        }
        drop_cancel_flag(&id_for_task);
    });

    Ok(request_id)
}

/// Kicks off a streaming AI rewrite. Returns the synthetic request id; the
/// caller listens for `solomd://ai-chunk`, `solomd://ai-done`, and
/// `solomd://ai-error` events filtered by that id.
#[tauri::command]
pub async fn ai_rewrite(app: AppHandle, request: RewriteRequest) -> Result<String, String> {
    let request_id = request
        .request_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(make_request_id);
    let cancel = register_cancel_flag(&request_id);

    // Resolve which wire format to use: explicit `api_format` from the
    // frontend, or the legacy `provider` value as a fallback. Apply the
    // `local` → `ollama` alias here too so Recipes (v4.0 P2) that say
    // `provider: local` work without a separate code path.
    let format = request
        .api_format
        .clone()
        .map(|f| resolve_provider(&f).to_string())
        .unwrap_or_else(|| resolve_provider(&request.provider).to_string());

    // Ollama doesn't need a key — every other format does.
    let api_key = if format == "ollama" {
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
        let result = match format.as_str() {
            "openai" => run_openai(&app, &id_for_task, &request, &api_key, cancel.clone()).await,
            "anthropic" => {
                run_anthropic(&app, &id_for_task, &request, &api_key, cancel.clone()).await
            }
            "ollama" => run_ollama(&app, &id_for_task, &request, cancel.clone()).await,
            other => Err(format!("unknown api_format: {other}")),
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
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    // Convention: base URL already includes the version path (`/v1`,
    // `/api/v3`, `/v1beta/openai`, etc.) — same as the OpenAI SDK default.
    // The Rust side just appends `/chat/completions`.
    let url = format!("{base}/chat/completions");

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

/// Legacy single-turn OpenAI chat — retained for the off chance that v3.x
/// callers still hit it. v4.0's panel goes through `run_chat_openai_loop`.
#[allow(dead_code)]
async fn run_chat_openai(
    app: &AppHandle,
    request_id: &str,
    req: &ChatRequest,
    api_key: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let base = req
        .base_url
        .as_ref()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let url = format!("{base}/chat/completions");

    let messages_json: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();

    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": messages_json,
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
        while let Some(idx) = find_event_boundary(&buf) {
            let event = buf[..idx].to_string();
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

/// Legacy single-turn Anthropic chat — retained for callers still routed
/// outside the tool-call loop. Panel goes through `run_chat_anthropic_loop`.
#[allow(dead_code)]
async fn run_chat_anthropic(
    app: &AppHandle,
    request_id: &str,
    req: &ChatRequest,
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

    // Anthropic separates `system` from `messages`. Pull every system-role
    // message out of the chat history into a single concatenated system
    // string; everything else stays in `messages`. (Adjacent user / assistant
    // alternation is the caller's responsibility.)
    let system_str = req
        .messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n\n");
    let chat_msgs: Vec<serde_json::Value> = req
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();

    let body = serde_json::json!({
        "model": req.model,
        "system": system_str,
        "messages": chat_msgs,
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
                        // This legacy single-turn path is the rewrite
                        // overlay's Anthropic runner — usage capture not
                        // wired (rewrite UI doesn't surface a cost
                        // footer); the v4.0 panel goes through
                        // run_chat_anthropic_loop above.
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

pub async fn run_chat_ollama(
    app: &AppHandle,
    request_id: &str,
    req: &ChatRequest,
    cancel: Arc<AtomicBool>,
) -> Result<(String, u64, u64), String> {
    let base = req
        .base_url
        .as_ref()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let url = format!("{base}/api/chat");

    let messages_json: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();

    let body = serde_json::json!({
        "model": req.model,
        "stream": true,
        "messages": messages_json,
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
    // Ollama's final `done: true` chunk carries `prompt_eval_count` (input
    // tokens consumed by the prompt + system) and `eval_count` (output
    // tokens generated). Cost lookup is 0 for ollama anyway, but we still
    // surface the counts for the trace footer + Recent Runs list.
    let mut tokens_in: u64 = 0;
    let mut tokens_out: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let bytes = chunk.map_err(|e| format!("ollama stream error: {e}"))?;
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
            // `prompt_eval_count` / `eval_count` are typically only present
            // on the final `done: true` chunk, but read them every chunk
            // and keep the latest non-zero values just in case a build
            // backports them earlier.
            if let Some(n) = json.get("prompt_eval_count").and_then(|v| v.as_u64()) {
                if n > tokens_in {
                    tokens_in = n;
                }
            }
            if let Some(n) = json.get("eval_count").and_then(|v| v.as_u64()) {
                if n > tokens_out {
                    tokens_out = n;
                }
            }
            if json.get("done").and_then(|b| b.as_bool()).unwrap_or(false) {
                return Ok((full, tokens_in, tokens_out));
            }
            if let Some(err) = json.get("error").and_then(|s| s.as_str()) {
                return Err(format!("ollama: {err}"));
            }
        }
    }
    Ok((full, tokens_in, tokens_out))
}

// ---------------------------------------------------------------------------
// v4.0 — tool-call loops (Anthropic + OpenAI)
// ---------------------------------------------------------------------------

/// Single LLM turn that may emit either text-only or tool_use blocks.
/// Returned to the loop so it can decide whether to dispatch tools and
/// re-iterate.
#[derive(Debug, Default, Clone)]
struct TurnOutcome {
    text: String,
    /// `tool_use` blocks parsed from the stream. Empty when the model
    /// finished with text-only. Each entry: (tool_call_id, name, args_json).
    tool_uses: Vec<(String, String, Value)>,
    /// `stop_reason` (Anthropic) / `finish_reason` (OpenAI) verbatim.
    finish_reason: String,
    /// Provider-specific passthrough fields on the tool_call object that
    /// must be echoed back verbatim on the next turn. Today this captures
    /// Gemini's `extra_content.google.thought_signature` (its OpenAI-compat
    /// layer 400s on the next request without it). Keyed by tool_call_id;
    /// only populated by the OpenAI-format streaming parser.
    tool_extras: std::collections::HashMap<String, Value>,
    /// Usage extracted from this turn's stream end. Sum across loop
    /// iterations to get the run-level totals. Stays at 0 when the
    /// provider didn't emit a `usage` block (some self-hosted
    /// OpenAI-compat servers and older models skip it).
    tokens_in: u64,
    tokens_out: u64,
}

/// Build the Anthropic-flavored `tools: [...]` array from the requested
/// tool list. Strips write-tools when `allow_write` is false.
fn build_anthropic_tools(req: &ChatRequest) -> Value {
    let allow_write = req.allow_write.unwrap_or(false);
    let names: Vec<String> = match &req.tools {
        Some(v) => v.clone(),
        None => agent_tools::READ_TOOLS.iter().map(|s| s.to_string()).collect(),
    };
    let arr: Vec<Value> = names
        .iter()
        .filter(|n| allow_write || !agent_tools::is_write_tool(n))
        .filter_map(|n| {
            agent_tools::tool_descriptor(n).map(|(desc, schema)| {
                serde_json::json!({
                    "name": n,
                    "description": desc,
                    "input_schema": schema,
                })
            })
        })
        .collect();
    Value::Array(arr)
}

/// OpenAI-flavored tool array — wraps the same schema as
/// `{"type":"function","function":{...}}`.
fn build_openai_tools(req: &ChatRequest) -> Value {
    let allow_write = req.allow_write.unwrap_or(false);
    let names: Vec<String> = match &req.tools {
        Some(v) => v.clone(),
        None => agent_tools::READ_TOOLS.iter().map(|s| s.to_string()).collect(),
    };
    let arr: Vec<Value> = names
        .iter()
        .filter(|n| allow_write || !agent_tools::is_write_tool(n))
        .filter_map(|n| {
            agent_tools::tool_descriptor(n).map(|(desc, schema)| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": n,
                        "description": desc,
                        "parameters": schema,
                    }
                })
            })
        })
        .collect();
    Value::Array(arr)
}

/// Resolve the workspace path the loop should pass to `dispatch_tool`. We
/// need it for every tool. If the request didn't carry one, tools that
/// require workspace access fail loudly — better than silently using $CWD.
fn workspace_from_req(req: &ChatRequest) -> Option<PathBuf> {
    req.workspace
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Trim a result Value to a string preview suitable for the trace's
/// truncated `result` field. Keeps the full JSON in memory only briefly.
fn json_preview(v: &Value) -> String {
    match serde_json::to_string(v) {
        Ok(s) => s,
        Err(_) => v.to_string(),
    }
}

// ---- Anthropic tool-call loop --------------------------------------------

pub async fn run_chat_anthropic_loop(
    app: &AppHandle,
    request_id: &str,
    req: &ChatRequest,
    api_key: &str,
    cancel: Arc<AtomicBool>,
    run_handle: Option<Arc<RunHandle>>,
) -> Result<(String, u64, u64), String> {
    let cap = req.tool_loop_cap.unwrap_or(8).max(1).min(20);
    let workspace = workspace_from_req(req);
    // Accumulate run-level token totals across each turn. Anthropic
    // resets `usage` per request, so summing per-turn is the right move.
    let mut tokens_in_total: u64 = 0;
    let mut tokens_out_total: u64 = 0;

    // Anthropic uses a separate `system` field. Pull system messages out.
    let system_str = req
        .messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n\n");
    // Build initial chat history. Each item is a serde_json `Value` so we
    // can append assistant tool_use blocks + tool_result blocks across turns
    // without re-typing structs.
    let mut history: Vec<Value> = req
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            // Tool messages are special — Anthropic represents them as a
            // user message with a `tool_result` content block. The frontend
            // doesn't usually pre-fill these (the loop generates them).
            if m.role == "tool" {
                serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                        "content": m.content.clone(),
                    }]
                })
            } else {
                serde_json::json!({"role": m.role, "content": m.content})
            }
        })
        .collect();

    let tools = build_anthropic_tools(req);
    let tools_n = tools.as_array().map(|a| a.len() as u64).unwrap_or(0);
    let mut last_text = String::new();

    for iter in 0..cap {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        if let Some(rh) = &run_handle {
            let _ = rh.append_trace(TraceStep {
                kind: "model_call".to_string(),
                provider: Some("anthropic".to_string()),
                model: Some(req.model.clone()),
                messages_n: Some(history.len() as u64),
                tools_n: Some(tools_n),
                ..Default::default()
            });
        }
        let outcome = anthropic_one_turn(
            app,
            request_id,
            req,
            api_key,
            &system_str,
            &history,
            &tools,
            cancel.clone(),
        )
        .await?;
        // Sum per-turn usage into the run-level totals. Anthropic returns
        // fresh numbers each turn (not cumulative) so plain addition works.
        tokens_in_total = tokens_in_total.saturating_add(outcome.tokens_in);
        tokens_out_total = tokens_out_total.saturating_add(outcome.tokens_out);
        if let Some(rh) = &run_handle {
            let _ = rh.append_trace(TraceStep {
                kind: "model_done".to_string(),
                provider: Some("anthropic".to_string()),
                model: Some(req.model.clone()),
                text: Some(outcome.text.clone()),
                finish_reason: Some(outcome.finish_reason.clone()),
                tokens_in: Some(outcome.tokens_in),
                tokens_out: Some(outcome.tokens_out),
                ..Default::default()
            });
        }
        last_text = outcome.text.clone();

        // No tool_use blocks → done.
        if outcome.tool_uses.is_empty() {
            return Ok((last_text, tokens_in_total, tokens_out_total));
        }

        // Hit cap on the *previous* iteration check — safe since cap >= 1.
        if iter + 1 >= cap {
            // Treat as final turn even though the model wanted to call a tool.
            return Ok((last_text, tokens_in_total, tokens_out_total));
        }

        // Append the assistant message verbatim (text + tool_use blocks).
        let mut assistant_blocks: Vec<Value> = Vec::new();
        if !outcome.text.is_empty() {
            assistant_blocks.push(serde_json::json!({"type":"text","text": outcome.text}));
        }
        for (id, name, args) in &outcome.tool_uses {
            assistant_blocks.push(serde_json::json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": args,
            }));
        }
        history.push(serde_json::json!({
            "role": "assistant",
            "content": assistant_blocks,
        }));

        // Dispatch each tool, append a single user message containing all
        // tool_result blocks (Anthropic's expected pairing).
        let mut result_blocks: Vec<Value> = Vec::new();
        for (id, name, args) in outcome.tool_uses.iter() {
            // Emit tool-call event.
            let _ = app.emit(
                "solomd://ai-tool-call",
                ToolCallEvent {
                    request_id: request_id.to_string(),
                    run_id: run_handle
                        .as_ref()
                        .map(|h| h.run_id.clone())
                        .unwrap_or_default(),
                    tool_call_id: id.clone(),
                    tool: name.clone(),
                    args: args.clone(),
                },
            );
            if let Some(rh) = &run_handle {
                let _ = rh.append_trace(TraceStep {
                    kind: "tool_call".to_string(),
                    tool: Some(name.clone()),
                    args: Some(args.clone()),
                    tool_call_id: Some(id.clone()),
                    ..Default::default()
                });
                let _ = rh.append_run_md(&format!(
                    "### Tool: {} {}\n\n",
                    name,
                    serde_json::to_string(args).unwrap_or_default()
                ));
            }

            let (result_value, error_str) = match &workspace {
                Some(ws) => match agent_tools::dispatch_tool(app, ws, name, args.clone()).await {
                    Ok(v) => (v, None),
                    Err(e) => (Value::String(e.clone()), Some(e)),
                },
                None => {
                    let err = "no workspace provided".to_string();
                    (Value::String(err.clone()), Some(err))
                }
            };
            let preview = json_preview(&result_value);
            // Emit tool-result event.
            let _ = app.emit(
                "solomd://ai-tool-result",
                ToolResultEvent {
                    request_id: request_id.to_string(),
                    run_id: run_handle
                        .as_ref()
                        .map(|h| h.run_id.clone())
                        .unwrap_or_default(),
                    tool_call_id: id.clone(),
                    result: result_value.clone(),
                    error: error_str.clone(),
                },
            );
            if let Some(rh) = &run_handle {
                let _ = rh.append_trace(TraceStep {
                    kind: "tool_result".to_string(),
                    tool_call_id: Some(id.clone()),
                    result: Some(preview.clone()),
                    error: error_str.clone(),
                    ..Default::default()
                });
                let body_preview: String = preview.chars().take(2048).collect();
                let _ = rh.append_run_md(&format!("```\n{}\n```\n\n", body_preview));
            }
            result_blocks.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": preview,
                "is_error": error_str.is_some(),
            }));
        }
        history.push(serde_json::json!({"role": "user", "content": result_blocks}));
    }

    // Loop exited via cap. last_text is the final assistant text we got.
    Ok((last_text, tokens_in_total, tokens_out_total))
}

async fn anthropic_one_turn(
    app: &AppHandle,
    request_id: &str,
    req: &ChatRequest,
    api_key: &str,
    system_str: &str,
    history: &[Value],
    tools: &Value,
    cancel: Arc<AtomicBool>,
) -> Result<TurnOutcome, String> {
    let base = req
        .base_url
        .as_ref()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{base}/v1/messages");

    let mut body = serde_json::json!({
        "model": req.model,
        "system": system_str,
        "messages": history,
        "stream": true,
        "max_tokens": 4096,
    });
    if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        body["tools"] = tools.clone();
    }

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

    // Block accumulators keyed by `index` from `content_block_start`.
    // Anthropic streams: content_block_start (type=text|tool_use) →
    //   content_block_delta (text_delta or input_json_delta) →
    //   content_block_stop. Final message_delta gives `stop_reason`.
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct Block {
        kind: String,         // "text" or "tool_use"
        text: String,
        tool_id: String,
        tool_name: String,
        partial_json: String, // accumulator for tool_use input_json_delta
    }
    let mut blocks: BTreeMap<u64, Block> = BTreeMap::new();
    let mut stop_reason = String::new();
    // Anthropic splits usage across two events:
    //   - `message_start` carries `usage.input_tokens` (and any cache_*
    //     fields). Output_tokens here is "1" as a placeholder.
    //   - `message_delta` near the end carries the final `usage.output_tokens`.
    // We capture both. cache_read_input_tokens is folded into tokens_in if
    // present (the user paid for it on the route either way).
    let mut tokens_in: u64 = 0;
    let mut tokens_out: u64 = 0;

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

            for line in event.lines() {
                let line = line.trim_start();
                let payload = match line.strip_prefix("data:") {
                    Some(p) => p.trim(),
                    None => continue,
                };
                let json: Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let kind = json.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match kind {
                    "message_start" => {
                        // `message_start` payload shape:
                        //   { "type": "message_start",
                        //     "message": { ..., "usage": { "input_tokens": N,
                        //                                  "cache_read_input_tokens": K,
                        //                                  "cache_creation_input_tokens": C,
                        //                                  "output_tokens": 1 } } }
                        if let Some(usage) = json.pointer("/message/usage") {
                            let inp = usage
                                .get("input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let cache_read = usage
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let cache_create = usage
                                .get("cache_creation_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            // Anthropic bills cache_creation_input_tokens at
                            // a premium and cache_read_input_tokens at a
                            // discount, but the user's pricing table is
                            // per-token regardless — sum everything into
                            // tokens_in so downstream cost math doesn't
                            // under-count cached prefixes.
                            tokens_in = inp.saturating_add(cache_read).saturating_add(cache_create);
                        }
                    }
                    "content_block_start" => {
                        let i = json.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                        let block_v = json.get("content_block").cloned().unwrap_or(Value::Null);
                        let btype = block_v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        let mut b = Block::default();
                        b.kind = btype.to_string();
                        if btype == "tool_use" {
                            b.tool_id = block_v
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            b.tool_name = block_v
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                        }
                        blocks.insert(i, b);
                    }
                    "content_block_delta" => {
                        let i = json.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                        let delta = json.get("delta").cloned().unwrap_or(Value::Null);
                        let dtype = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        let entry = blocks.entry(i).or_insert_with(Block::default);
                        if dtype == "text_delta" {
                            if let Some(t) =
                                delta.get("text").and_then(|s| s.as_str())
                            {
                                if !t.is_empty() {
                                    entry.text.push_str(t);
                                    emit_chunk(app, request_id, t);
                                }
                            }
                        } else if dtype == "input_json_delta" {
                            if let Some(p) =
                                delta.get("partial_json").and_then(|s| s.as_str())
                            {
                                entry.partial_json.push_str(p);
                            }
                        }
                    }
                    "message_delta" => {
                        if let Some(d) = json.get("delta") {
                            if let Some(reason) = d.get("stop_reason").and_then(|s| s.as_str()) {
                                stop_reason = reason.to_string();
                            }
                        }
                        // `message_delta` is where Anthropic finalises
                        // output_tokens (sibling of `delta`, not nested
                        // inside it).
                        if let Some(usage) = json.get("usage") {
                            if let Some(n) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                                if n > tokens_out {
                                    tokens_out = n;
                                }
                            }
                        }
                    }
                    "message_stop" => {
                        // Drain into TurnOutcome below.
                        let mut outcome = TurnOutcome::default();
                        outcome.finish_reason = stop_reason.clone();
                        outcome.tokens_in = tokens_in;
                        outcome.tokens_out = tokens_out;
                        for (_, b) in blocks {
                            match b.kind.as_str() {
                                "text" => outcome.text.push_str(&b.text),
                                "tool_use" => {
                                    let args: Value = if b.partial_json.trim().is_empty() {
                                        Value::Object(Default::default())
                                    } else {
                                        serde_json::from_str(&b.partial_json)
                                            .unwrap_or(Value::String(b.partial_json.clone()))
                                    };
                                    outcome.tool_uses.push((b.tool_id, b.tool_name, args));
                                }
                                _ => {}
                            }
                        }
                        return Ok(outcome);
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

    // Stream ended without a `message_stop` — flush whatever we got.
    let mut outcome = TurnOutcome::default();
    outcome.finish_reason = stop_reason;
    outcome.tokens_in = tokens_in;
    outcome.tokens_out = tokens_out;
    for (_, b) in blocks {
        match b.kind.as_str() {
            "text" => outcome.text.push_str(&b.text),
            "tool_use" => {
                let args: Value = if b.partial_json.trim().is_empty() {
                    Value::Object(Default::default())
                } else {
                    serde_json::from_str(&b.partial_json)
                        .unwrap_or(Value::String(b.partial_json.clone()))
                };
                outcome.tool_uses.push((b.tool_id, b.tool_name, args));
            }
            _ => {}
        }
    }
    Ok(outcome)
}

// ---- OpenAI tool-call loop -----------------------------------------------

pub async fn run_chat_openai_loop(
    app: &AppHandle,
    request_id: &str,
    req: &ChatRequest,
    api_key: &str,
    cancel: Arc<AtomicBool>,
    run_handle: Option<Arc<RunHandle>>,
) -> Result<(String, u64, u64), String> {
    let cap = req.tool_loop_cap.unwrap_or(8).max(1).min(20);
    let workspace = workspace_from_req(req);
    // Run-level token totals — OpenAI Chat Completions resets `usage`
    // per request, so a per-turn sum is the right accounting.
    let mut tokens_in_total: u64 = 0;
    let mut tokens_out_total: u64 = 0;

    // OpenAI Chat Completions wants `messages` as flat objects with optional
    // `tool_calls` / `tool_call_id`. Build the initial array preserving any
    // tool messages from the frontend.
    let mut history: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            if m.role == "tool" {
                serde_json::json!({
                    "role": "tool",
                    "content": m.content.clone(),
                    "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                })
            } else {
                serde_json::json!({"role": m.role, "content": m.content})
            }
        })
        .collect();

    let tools = build_openai_tools(req);
    let tools_n = tools.as_array().map(|a| a.len() as u64).unwrap_or(0);
    let mut last_text = String::new();

    for iter in 0..cap {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        if let Some(rh) = &run_handle {
            let _ = rh.append_trace(TraceStep {
                kind: "model_call".to_string(),
                provider: Some("openai".to_string()),
                model: Some(req.model.clone()),
                messages_n: Some(history.len() as u64),
                tools_n: Some(tools_n),
                ..Default::default()
            });
        }
        let outcome = openai_one_turn(
            app,
            request_id,
            req,
            api_key,
            &history,
            &tools,
            cancel.clone(),
        )
        .await?;
        // Sum per-turn usage; OpenAI-compat servers reset the counters
        // every request so a plain add is correct.
        tokens_in_total = tokens_in_total.saturating_add(outcome.tokens_in);
        tokens_out_total = tokens_out_total.saturating_add(outcome.tokens_out);
        if let Some(rh) = &run_handle {
            let _ = rh.append_trace(TraceStep {
                kind: "model_done".to_string(),
                provider: Some("openai".to_string()),
                model: Some(req.model.clone()),
                text: Some(outcome.text.clone()),
                finish_reason: Some(outcome.finish_reason.clone()),
                tokens_in: Some(outcome.tokens_in),
                tokens_out: Some(outcome.tokens_out),
                ..Default::default()
            });
        }
        last_text = outcome.text.clone();

        if outcome.tool_uses.is_empty() {
            return Ok((last_text, tokens_in_total, tokens_out_total));
        }
        if iter + 1 >= cap {
            return Ok((last_text, tokens_in_total, tokens_out_total));
        }

        // Append assistant message with tool_calls. content may be empty.
        // Provider-specific extras (e.g. Gemini's `extra_content` with the
        // `thought_signature` token) are merged into each tool_call so the
        // next turn re-sends them — without this, Gemini's OpenAI-compat
        // layer 400s with "Function call is missing a thought_signature".
        let tool_calls_v: Vec<Value> = outcome
            .tool_uses
            .iter()
            .map(|(id, name, args)| {
                let mut tc = serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string()),
                    }
                });
                if let Some(extras) = outcome.tool_extras.get(id) {
                    if let (Some(obj), Some(extras_obj)) =
                        (tc.as_object_mut(), extras.as_object())
                    {
                        for (k, v) in extras_obj {
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                }
                tc
            })
            .collect();
        let mut assistant_msg = serde_json::json!({
            "role": "assistant",
            "tool_calls": tool_calls_v,
        });
        if !outcome.text.is_empty() {
            assistant_msg["content"] = Value::String(outcome.text.clone());
        }
        history.push(assistant_msg);

        // Dispatch each tool, append one `tool` role message per call.
        for (id, name, args) in outcome.tool_uses.iter() {
            let _ = app.emit(
                "solomd://ai-tool-call",
                ToolCallEvent {
                    request_id: request_id.to_string(),
                    run_id: run_handle
                        .as_ref()
                        .map(|h| h.run_id.clone())
                        .unwrap_or_default(),
                    tool_call_id: id.clone(),
                    tool: name.clone(),
                    args: args.clone(),
                },
            );
            if let Some(rh) = &run_handle {
                let _ = rh.append_trace(TraceStep {
                    kind: "tool_call".to_string(),
                    tool: Some(name.clone()),
                    args: Some(args.clone()),
                    tool_call_id: Some(id.clone()),
                    ..Default::default()
                });
                let _ = rh.append_run_md(&format!(
                    "### Tool: {} {}\n\n",
                    name,
                    serde_json::to_string(args).unwrap_or_default()
                ));
            }

            let (result_value, error_str) = match &workspace {
                Some(ws) => match agent_tools::dispatch_tool(app, ws, name, args.clone()).await {
                    Ok(v) => (v, None),
                    Err(e) => (Value::String(e.clone()), Some(e)),
                },
                None => {
                    let err = "no workspace provided".to_string();
                    (Value::String(err.clone()), Some(err))
                }
            };
            let preview = json_preview(&result_value);
            let _ = app.emit(
                "solomd://ai-tool-result",
                ToolResultEvent {
                    request_id: request_id.to_string(),
                    run_id: run_handle
                        .as_ref()
                        .map(|h| h.run_id.clone())
                        .unwrap_or_default(),
                    tool_call_id: id.clone(),
                    result: result_value.clone(),
                    error: error_str.clone(),
                },
            );
            if let Some(rh) = &run_handle {
                let _ = rh.append_trace(TraceStep {
                    kind: "tool_result".to_string(),
                    tool_call_id: Some(id.clone()),
                    result: Some(preview.clone()),
                    error: error_str.clone(),
                    ..Default::default()
                });
                let body_preview: String = preview.chars().take(2048).collect();
                let _ = rh.append_run_md(&format!("```\n{}\n```\n\n", body_preview));
            }
            history.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": id,
                "content": preview,
            }));
        }
    }

    Ok((last_text, tokens_in_total, tokens_out_total))
}

async fn openai_one_turn(
    app: &AppHandle,
    request_id: &str,
    req: &ChatRequest,
    api_key: &str,
    history: &[Value],
    tools: &Value,
    cancel: Arc<AtomicBool>,
) -> Result<TurnOutcome, String> {
    let base = req
        .base_url
        .as_ref()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let url = format!("{base}/chat/completions");

    // Bug O: build the body, omitting `stream_options` if a previous
    // request to this (provider, base_url) returned 400 because the
    // server didn't recognise the field. See STREAM_OPTIONS_UNSUPPORTED.
    let cache_key = stream_options_cache_key(&req.provider, &base);
    let include_stream_options = !stream_options_unsupported(&cache_key);
    let build_body = |with_options: bool| -> Value {
        let mut b = serde_json::json!({
            "model": req.model,
            "stream": true,
            "messages": history,
        });
        if with_options {
            // OpenAI-compat servers only emit the final `usage` block when
            // the client opts in via `stream_options.include_usage`. The
            // Chat Completions API has accepted this since mid-2024;
            // older self-hosted forks (older vLLM, certain SiliconFlow
            // tiers) reject it with a 400 — handled below.
            b["stream_options"] = serde_json::json!({"include_usage": true});
        }
        if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            b["tools"] = tools.clone();
        }
        b
    };

    let client = http_client()?;
    let send_once = |body: Value| {
        let url = url.clone();
        let api_key = api_key.to_string();
        let client = client.clone();
        async move {
            client
                .post(&url)
                .bearer_auth(&api_key)
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("openai request failed: {e}"))
        }
    };

    let mut resp = send_once(build_body(include_stream_options)).await?;

    if !resp.status().is_success() {
        let status = resp.status();
        // Retry once without `stream_options` if the server complained
        // about it — single substring match keeps detection cheap and
        // robust across "unknown body param", "unknown field",
        // "include_usage not supported", etc. Cache the result so we
        // skip the bad first request next time.
        if status == reqwest::StatusCode::BAD_REQUEST && include_stream_options {
            let txt = resp.text().await.unwrap_or_default();
            let lower = txt.to_lowercase();
            if lower.contains("stream_options")
                || lower.contains("include_usage")
                || lower.contains("unknown")
            {
                mark_stream_options_unsupported(&cache_key);
                resp = send_once(build_body(false)).await?;
                if !resp.status().is_success() {
                    let s = resp.status();
                    let t = resp.text().await.unwrap_or_default();
                    return Err(format!("openai {s}: {t}"));
                }
            } else {
                return Err(format!("openai {status}: {txt}"));
            }
        } else {
            let txt = resp.text().await.unwrap_or_default();
            return Err(format!("openai {status}: {txt}"));
        }
    }

    // DEBUG (gemini thought_signature hunt): if the env var is set, dump
    // every raw SSE line to that file so we can see what fields Gemini's
    // OpenAI-compat layer puts on tool_call deltas. Set with:
    //   SOLOMD_OPENAI_DEBUG_DUMP=/tmp/openai-stream.log pnpm tauri dev
    let debug_dump_path: Option<std::path::PathBuf> = std::env::var("SOLOMD_OPENAI_DEBUG_DUMP")
        .ok()
        .map(std::path::PathBuf::from);

    // Streamed tool_calls come back as deltas keyed by `index`; we
    // accumulate per-index id/name + a string buffer for `arguments`.
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct ToolAccum {
        id: String,
        name: String,
        arguments: String,
        /// Provider-specific passthrough fields seen on this tool_call delta
        /// (anything outside id / type / function). Gemini's OpenAI-compat
        /// layer puts `extra_content.google.thought_signature` here and
        /// requires it back on the next turn.
        extras: serde_json::Map<String, Value>,
    }
    let mut text = String::new();
    let mut tools_acc: BTreeMap<u64, ToolAccum> = BTreeMap::new();
    let mut finish_reason = String::new();
    // Most providers send `usage` as a separate top-level field on the
    // last data chunk (the one with empty choices, or a sibling of the
    // `[DONE]` chunk). DeepSeek attaches it to the last choice's chunk
    // instead. Capture both shapes and prefer the larger numbers when
    // they conflict — the totals are monotonic-non-decreasing across the
    // stream so this stays robust.
    let mut tokens_in: u64 = 0;
    let mut tokens_out: u64 = 0;

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        let bytes = chunk.map_err(|e| format!("openai stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(idx) = find_event_boundary(&buf) {
            let event = buf[..idx].to_string();
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
                if let Some(dp) = &debug_dump_path {
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dp)
                        .and_then(|mut f| {
                            use std::io::Write;
                            writeln!(f, "{payload}")
                        });
                }
                if payload == "[DONE]" {
                    let mut outcome = TurnOutcome::default();
                    outcome.text = text;
                    outcome.finish_reason = finish_reason;
                    outcome.tokens_in = tokens_in;
                    outcome.tokens_out = tokens_out;
                    for (_, t) in tools_acc {
                        let args: Value = if t.arguments.trim().is_empty() {
                            Value::Object(Default::default())
                        } else {
                            serde_json::from_str(&t.arguments)
                                .unwrap_or(Value::String(t.arguments.clone()))
                        };
                        if !t.extras.is_empty() {
                            outcome
                                .tool_extras
                                .insert(t.id.clone(), Value::Object(t.extras));
                        }
                        outcome.tool_uses.push((t.id, t.name, args));
                    }
                    return Ok(outcome);
                }
                let json: Value = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // `usage` is emitted on the last chunk before [DONE] when
                // include_usage is set. Some providers (DeepSeek) put it on
                // the same chunk as the last delta, so we read it on every
                // payload and keep the latest non-zero numbers.
                if let Some(usage) = json.get("usage") {
                    if let Some(n) = usage.get("prompt_tokens").and_then(|v| v.as_u64()) {
                        if n > tokens_in {
                            tokens_in = n;
                        }
                    }
                    if let Some(n) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                        if n > tokens_out {
                            tokens_out = n;
                        }
                    }
                }
                let choice = json.get("choices").and_then(|c| c.get(0));
                if let Some(c) = choice {
                    if let Some(reason) = c.get("finish_reason").and_then(|s| s.as_str()) {
                        if !reason.is_empty() {
                            finish_reason = reason.to_string();
                        }
                    }
                    let delta = c.get("delta").cloned().unwrap_or(Value::Null);
                    if let Some(content) = delta.get("content").and_then(|s| s.as_str()) {
                        if !content.is_empty() {
                            text.push_str(content);
                            emit_chunk(app, request_id, content);
                        }
                    }
                    if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                        for tc in tcs {
                            let i = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                            let entry = tools_acc.entry(i).or_default();
                            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                if !id.is_empty() {
                                    entry.id = id.to_string();
                                }
                            }
                            if let Some(f) = tc.get("function") {
                                if let Some(n) = f.get("name").and_then(|v| v.as_str()) {
                                    if !n.is_empty() {
                                        entry.name = n.to_string();
                                    }
                                }
                                if let Some(a) = f.get("arguments").and_then(|v| v.as_str()) {
                                    entry.arguments.push_str(a);
                                }
                            }
                            // Capture any non-standard fields (Gemini's
                            // extra_content with thought_signature, future
                            // provider quirks). Last-write-wins per delta —
                            // providers tend to send these once at end-of-call.
                            if let Some(obj) = tc.as_object() {
                                for (k, v) in obj {
                                    if !matches!(k.as_str(), "index" | "id" | "type" | "function") {
                                        entry.extras.insert(k.clone(), v.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut outcome = TurnOutcome::default();
    outcome.text = text;
    outcome.finish_reason = finish_reason;
    outcome.tokens_in = tokens_in;
    outcome.tokens_out = tokens_out;
    for (_, t) in tools_acc {
        let args: Value = if t.arguments.trim().is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_str(&t.arguments).unwrap_or(Value::String(t.arguments.clone()))
        };
        if !t.extras.is_empty() {
            outcome
                .tool_extras
                .insert(t.id.clone(), Value::Object(t.extras));
        }
        outcome.tool_uses.push((t.id, t.name, args));
    }
    Ok(outcome)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_aliases_to_ollama() {
        assert_eq!(resolve_provider("local"), "ollama");
    }

    #[test]
    fn other_providers_pass_through_unchanged() {
        for id in ["openai", "anthropic", "ollama", "deepseek", "qwen"] {
            assert_eq!(resolve_provider(id), id, "provider {id} should not be rewritten");
        }
    }

    /// Bug C — `ai_rewrite` must reuse a caller-provided `request_id` so
    /// the frontend can wire its event listeners BEFORE invoking the
    /// command. We can't drive the network from a unit test, so we
    /// exercise the same `unwrap_or_else(make_request_id)` selector on a
    /// constructed `RewriteRequest` and confirm the supplied id wins.
    #[test]
    fn rewrite_request_uses_caller_provided_request_id() {
        fn pick(req: &RewriteRequest) -> String {
            req.request_id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(make_request_id)
        }

        let with_id = RewriteRequest {
            provider: "openai".to_string(),
            api_format: Some("openai".to_string()),
            model: "gpt-4o-mini".to_string(),
            system: "s".to_string(),
            user: "u".to_string(),
            selection: "sel".to_string(),
            base_url: None,
            request_id: Some("xyz".to_string()),
        };
        assert_eq!(pick(&with_id), "xyz");

        // Empty string falls through to the generated id (treat empty as
        // "none" — matches the same rule applied to ChatRequest).
        let empty = RewriteRequest {
            request_id: Some(String::new()),
            ..with_id.clone()
        };
        let id = pick(&empty);
        assert!(id.starts_with("req-"), "expected generated id, got {id}");

        // Missing field → generated id.
        let missing = RewriteRequest {
            request_id: None,
            ..with_id
        };
        let id = pick(&missing);
        assert!(id.starts_with("req-"), "expected generated id, got {id}");
    }

    /// Bug O — the per-(provider, base_url) cache flips a server from
    /// "try with stream_options" to "skip it" after a single failure.
    #[test]
    fn stream_options_cache_marks_and_reads_back() {
        let key = stream_options_cache_key("test-provider", "http://localhost:9999");
        // OnceLock-backed sets persist for the test process; pick a key
        // that no other test touches.
        assert!(!stream_options_unsupported(&key));
        mark_stream_options_unsupported(&key);
        assert!(stream_options_unsupported(&key));
    }
}
