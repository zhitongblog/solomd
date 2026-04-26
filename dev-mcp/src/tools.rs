//! Tool definitions for solomd-dev-mcp.
//!
//! Tools roughly mirror the user-facing GUI flow:
//!
//!   * `solomd_get_settings` / `solomd_set_setting` — read/write
//!     localStorage settings (autoGitEnabled, aiEnabled, etc.).
//!   * `solomd_get_workspace` / `solomd_set_workspace` — read/write the
//!     currentFolder. Must be called while SoloMD is closed (WebKit
//!     holds the SQLite open).
//!   * `solomd_get_tabs` / `solomd_set_tabs` — read/write the open-tabs
//!     state.
//!   * `solomd_git_status|init|commit|log|rollback|file_at` —
//!     functional equivalents of the seven `git_history` Tauri commands
//!     in app/src-tauri. Drives the same backend logic the GUI uses.
//!   * `solomd_read_file` / `solomd_write_file` — convenience for
//!     verifying disk state.
//!   * `solomd_screenshot` — full-screen `screencapture -x` to a temp
//!     file. Path returned for the caller to read.
//!   * `solomd_app_status` — list running SoloMD processes (dev vs
//!     installed) so the caller knows which build it's testing against.
//!
//! All git operations are implemented inline in this crate (small,
//! self-contained re-implementations of `app/src-tauri/src/git_history.rs`)
//! rather than path-deping the Tauri crate, which pulls in a massive
//! transitive graph (tauri runtime, plugins, etc.) we don't need here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use git2::{
    Commit, DiffOptions, IndexAddOption, Oid, Repository, Signature, Sort, StatusOptions,
};
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, Implementation, ServerCapabilities, ServerInfo},
    schemars::{self, JsonSchema},
    tool, tool_handler, tool_router,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::process::Command as AsyncCommand;

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct DevServer {
    _inner: Arc<()>,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl DevServer {
    pub fn new() -> Self {
        Self {
            _inner: Arc::new(()),
            tool_router: Self::tool_router(),
        }
    }
}

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

/// WebKit stores LocalStorage values as UTF-16 LE inside a SQLite blob.
fn ls_path(bundle: &str) -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let (folder, hash) = match bundle {
        "dev" => (
            "solomd",
            "y_a-QbuPa1QmlFcuFGdl2gs24bBFFTCBTT8ilCLEsu0",
        ),
        "prod" => (
            "app.solomd",
            "bvB3gbOLx5VDrjmfAOI5KBKeMsCcGefh6CxQA9MFkBM",
        ),
        other => return Err(anyhow!("unknown bundle: {other} (use dev or prod)")),
    };
    let p = PathBuf::from(home)
        .join("Library/WebKit")
        .join(folder)
        .join("WebsiteData/Default")
        .join(hash)
        .join(hash)
        .join("LocalStorage/localstorage.sqlite3");
    if !p.exists() {
        return Err(anyhow!("no LocalStorage at {}", p.display()));
    }
    Ok(p)
}

fn ls_get(bundle: &str, key: &str) -> Result<JsonValue> {
    let path = ls_path(bundle)?;
    let conn = Connection::open(&path)?;
    let raw: Option<Vec<u8>> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?",
            [key],
            |r| r.get(0),
        )
        .ok();
    match raw {
        None => Ok(JsonValue::Null),
        Some(bytes) => {
            let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes);
            Ok(serde_json::from_str(&text)?)
        }
    }
}

fn ls_put(bundle: &str, key: &str, value: &JsonValue) -> Result<()> {
    let path = ls_path(bundle)?;
    let json = serde_json::to_string(value)?;
    let (utf16, _, _) = encoding_rs::UTF_16LE.encode(&json);
    let conn = Connection::open(&path)?;
    let updated = conn.execute(
        "UPDATE ItemTable SET value = ? WHERE key = ?",
        rusqlite::params![&utf16[..], key],
    )?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO ItemTable(key, value) VALUES(?, ?)",
            rusqlite::params![key, &utf16[..]],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// git2 helpers — mirror app/src-tauri/src/git_history.rs
// ---------------------------------------------------------------------------

fn open_repo(folder: &str) -> Result<Repository> {
    Repository::open(Path::new(folder)).map_err(|e| anyhow!("git open failed: {e}"))
}

fn build_signature(repo: &Repository) -> Result<Signature<'static>> {
    let cfg = repo.config()?;
    let name = cfg
        .get_string("user.name")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "SoloMD".to_string());
    let email = cfg
        .get_string("user.email")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "solomd@local".to_string());
    Signature::now(&name, &email).map_err(Into::into)
}

fn rel_path(repo: &Repository, abs: &str) -> Option<String> {
    let workdir = repo.workdir()?;
    let abs_path = Path::new(abs);
    if let Ok(stripped) = abs_path.strip_prefix(workdir) {
        return Some(stripped.to_string_lossy().replace('\\', "/"));
    }
    let abs_canon = match abs_path.parent().and_then(|p| p.canonicalize().ok()) {
        Some(parent) => parent.join(abs_path.file_name()?),
        None => abs_path.canonicalize().ok()?,
    };
    let workdir_canon = workdir.canonicalize().ok()?;
    let stripped = abs_canon.strip_prefix(&workdir_canon).ok()?;
    Some(stripped.to_string_lossy().replace('\\', "/"))
}

fn stage(repo: &Repository, pathspec: Option<&str>) -> Result<()> {
    let mut index = repo.index()?;
    if let Some(rel) = pathspec {
        index.update_all([rel].iter(), None).ok();
        if let Some(workdir) = repo.workdir() {
            if workdir.join(rel).exists() {
                index.add_path(Path::new(rel))?;
            }
        }
    } else {
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    }
    index.write()?;
    Ok(())
}

fn commit_staged(
    repo: &Repository,
    sig: &Signature<'_>,
    message: &str,
) -> Result<Option<String>> {
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let parents: Vec<Commit<'_>> = match repo.head() {
        Ok(head) => {
            let oid = head.target().ok_or_else(|| anyhow!("head has no target"))?;
            let parent = repo.find_commit(oid)?;
            if parent.tree_id() == tree_oid {
                return Ok(None);
            }
            vec![parent]
        }
        Err(_) => vec![],
    };
    let parent_refs: Vec<&Commit<'_>> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), sig, sig, message, &tree, &parent_refs)?;
    Ok(Some(oid.to_string()))
}

#[derive(Serialize)]
struct CommitInfo {
    sha: String,
    short_sha: String,
    message: String,
    author: String,
    time: i64,
}

fn commit_info(c: &Commit<'_>) -> CommitInfo {
    let sha = c.id().to_string();
    CommitInfo {
        short_sha: sha[..7.min(sha.len())].to_string(),
        sha,
        message: c.summary().unwrap_or("").to_string(),
        author: c.author().name().unwrap_or("?").to_string(),
        time: c.author().when().seconds(),
    }
}

// ---------------------------------------------------------------------------
// Tool argument structs
// ---------------------------------------------------------------------------

fn default_bundle() -> String { "dev".into() }

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct BundleArgs {
    /// `dev` (default) for `pnpm tauri dev`, `prod` for the installed dmg.
    #[serde(default = "default_bundle")]
    pub bundle: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetSettingArgs {
    #[serde(default = "default_bundle")]
    pub bundle: String,
    /// settings.v1 key, e.g. `autoGitEnabled`, `aiProvider`.
    pub key: String,
    /// JSON-typed value. true | false | "string" | 42, etc.
    pub value: JsonValue,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetWorkspaceArgs {
    #[serde(default = "default_bundle")]
    pub bundle: String,
    /// Absolute path to set as currentFolder.
    pub folder: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetTabsArgs {
    #[serde(default = "default_bundle")]
    pub bundle: String,
    /// Single open tab. (For now we only support a single-tab setup; extend if needed.)
    pub file_path: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitFolderArgs {
    /// Absolute workspace folder path.
    pub folder: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitCommitArgs {
    pub folder: String,
    /// Optional absolute file path; if set, only stage that file.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Optional commit message; if absent, uses an auto timestamp message.
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitFileArgs {
    pub folder: String,
    pub file_path: String,
    /// Limit. 0 = default 50.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitFileShaArgs {
    pub folder: String,
    pub file_path: String,
    pub sha: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct PathArgs { pub path: String }

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct WriteFileArgs { pub path: String, pub content: String }

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct EmptyArgs {}

// ---------------------------------------------------------------------------
// RAG (v2.3) — re-implementation of `app/src-tauri/src/rag.rs` so this
// crate stays decoupled from the Tauri app. The on-disk schema MUST match
// — both sides write into <workspace>/.solomd/embeddings.sqlite.
// ---------------------------------------------------------------------------

const RAG_EMBED_DIM: usize = 256;
const RAG_MIN_CHUNK_TOKENS: usize = 8;
const RAG_MAX_CHUNK_CHARS: usize = 1500;
const RAG_INDEX_VERSION: u32 = 2;

const RAG_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS rag_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rag_chunks (
    path TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    snippet TEXT NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (path, chunk_idx)
);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_path ON rag_chunks(path);
CREATE TABLE IF NOT EXISTS rag_files (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL
);
"#;

fn rag_db_path(folder: &str) -> PathBuf {
    Path::new(folder).join(".solomd").join("embeddings.sqlite")
}

fn rag_open_db(folder: &str) -> Result<Connection> {
    let p = rag_db_path(folder);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&p)?;
    conn.execute_batch(RAG_SCHEMA)?;
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM rag_meta WHERE key='index_version'",
            [],
            |r| r.get(0),
        )
        .ok();
    let want = RAG_INDEX_VERSION.to_string();
    if stored.as_deref() != Some(want.as_str()) {
        conn.execute_batch("DELETE FROM rag_chunks; DELETE FROM rag_files;")?;
        conn.execute(
            "INSERT OR REPLACE INTO rag_meta(key, value) VALUES('index_version', ?1)",
            rusqlite::params![want],
        )?;
    }
    Ok(conn)
}

fn rag_fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn rag_embed(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; RAG_EMBED_DIM];
    if text.is_empty() {
        return v;
    }
    let normalized: String = text.chars().map(|c| c.to_ascii_lowercase()).collect();
    let chars: Vec<char> = normalized.chars().collect();
    rag_add_char_ngrams(&chars, 2, 0.5, &mut v);
    rag_add_char_ngrams(&chars, 3, 1.0, &mut v);
    for word in normalized
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        let h = rag_fnv1a64(word.as_bytes());
        let idx = (h as usize) % RAG_EMBED_DIM;
        let sign = if (h >> 32) & 1 == 0 { 1.0 } else { -1.0 };
        v[idx] += 2.0 * sign;
        let prefix_len = word.chars().count().min(5);
        if prefix_len >= 3 {
            let prefix: String = word.chars().take(prefix_len).collect();
            let h2 = rag_fnv1a64(prefix.as_bytes());
            let idx2 = (h2 as usize) % RAG_EMBED_DIM;
            let sign2 = if (h2 >> 32) & 1 == 0 { 1.0 } else { -1.0 };
            v[idx2] += sign2;
        }
    }
    let mag: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if mag > 0.0 {
        for x in v.iter_mut() {
            *x /= mag;
        }
    }
    v
}

fn rag_add_char_ngrams(chars: &[char], n: usize, weight: f32, v: &mut [f32]) {
    if chars.len() < n {
        let s: String = chars.iter().collect();
        let h = rag_fnv1a64(s.as_bytes());
        let idx = (h as usize) % v.len();
        let sign = if (h >> 32) & 1 == 0 { 1.0 } else { -1.0 };
        v[idx] += weight * sign;
        return;
    }
    let mut buf = [0u8; 16];
    for i in 0..=(chars.len() - n) {
        let mut len = 0;
        for &c in &chars[i..i + n] {
            let s = c.encode_utf8(&mut buf[len..]);
            len += s.len();
        }
        let h = rag_fnv1a64(&buf[..len]);
        let idx = (h as usize) % v.len();
        let sign = if (h >> 32) & 1 == 0 { 1.0 } else { -1.0 };
        v[idx] += weight * sign;
    }
}

fn rag_cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

fn rag_bytes_to_vec(b: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(b.len() / 4);
    for chunk in b.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    out
}

fn rag_vec_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

fn rag_strip_front_matter(raw: &str) -> &str {
    let trimmed = raw.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return raw;
    }
    let after_first = match trimmed.find('\n') {
        Some(i) => &trimmed[i + 1..],
        None => return raw,
    };
    if let Some(end) = after_first.find("\n---") {
        let rest_offset = end + "\n---".len();
        let rest = &after_first[rest_offset..];
        return rest.strip_prefix('\n').unwrap_or(rest);
    }
    raw
}

#[derive(Clone)]
struct RagChunk {
    char_start: u32,
    char_end: u32,
    text: String,
}

fn rag_chunk_text(content: &str) -> Vec<RagChunk> {
    let body = rag_strip_front_matter(content);
    let offset_to_body = content.chars().count() - body.chars().count();
    let mut chunks: Vec<RagChunk> = Vec::new();
    let mut buf = String::new();
    let mut buf_start: usize = 0;
    let mut cur_offset: usize = 0;
    let lines: Vec<&str> = body.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        let lc = line.chars().count();
        if line.trim().is_empty() {
            if !buf.trim().is_empty() {
                rag_push_chunk(&mut chunks, &buf, buf_start + offset_to_body);
                buf.clear();
            }
            cur_offset += lc + 1;
            buf_start = cur_offset;
            continue;
        }
        if buf.is_empty() {
            buf_start = cur_offset;
        } else {
            buf.push('\n');
        }
        buf.push_str(line);
        cur_offset += lc;
        if i < lines.len() - 1 {
            cur_offset += 1;
        }
        if buf.chars().count() >= RAG_MAX_CHUNK_CHARS {
            rag_push_chunk(&mut chunks, &buf, buf_start + offset_to_body);
            buf.clear();
            buf_start = cur_offset;
        }
    }
    if !buf.trim().is_empty() {
        rag_push_chunk(&mut chunks, &buf, buf_start + offset_to_body);
    }
    chunks
}

fn rag_push_chunk(out: &mut Vec<RagChunk>, text: &str, char_start: usize) {
    let trimmed = text.trim_end_matches('\n').to_string();
    let n = trimmed.chars().count();
    if n == 0 {
        return;
    }
    let token_count = trimmed.split_whitespace().count();
    if token_count < RAG_MIN_CHUNK_TOKENS && n < 20 {
        if let Some(prev) = out.last_mut() {
            prev.text.push('\n');
            prev.text.push_str(&trimmed);
            prev.char_end = (char_start + n) as u32;
            return;
        }
    }
    out.push(RagChunk {
        char_start: char_start as u32,
        char_end: (char_start + n) as u32,
        text: trimmed,
    });
}

fn rag_list_markdown(folder: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let root = Path::new(folder);
    if !root.is_dir() {
        return out;
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.file_name().and_then(|s| s.to_str()) == Some(".solomd") {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                let lower = p
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase())
                    .unwrap_or_default();
                if matches!(lower.as_str(), "md" | "markdown" | "mdown" | "txt") {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn rag_index_one(conn: &Connection, path: &Path) -> Result<usize> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Ok(0),
    };
    let chunks = rag_chunk_text(&raw);
    let p = path.to_string_lossy().to_string();
    conn.execute("DELETE FROM rag_chunks WHERE path = ?1", rusqlite::params![&p])?;
    let mut stmt = conn.prepare(
        "INSERT INTO rag_chunks(path, chunk_idx, char_start, char_end, snippet, embedding)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (i, ch) in chunks.iter().enumerate() {
        let v = rag_embed(&ch.text);
        let bytes = rag_vec_to_bytes(&v);
        let snippet: String = ch.text.chars().take(240).collect();
        stmt.execute(rusqlite::params![
            &p,
            i as i64,
            ch.char_start as i64,
            ch.char_end as i64,
            &snippet,
            &bytes
        ])?;
    }
    drop(stmt);
    let meta = std::fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT OR REPLACE INTO rag_files(path, mtime, size) VALUES(?1, ?2, ?3)",
        rusqlite::params![&p, mtime, meta.len() as i64],
    )?;
    Ok(chunks.len())
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct RagFolderArgs {
    pub folder: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct RagSearchArgs {
    pub folder: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

// ---------------------------------------------------------------------------
// Dev-bridge (v2.3) — talks to the localhost JSON-RPC server inside SoloMD's
// debug build. See app/src-tauri/src/dev_bridge.rs for the protocol.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DevEvalArgs {
    /// JavaScript source to run in SoloMD's main WebView. The script runs
    /// inside an `async` IIFE — you can use `await`. Whatever the IIFE
    /// returns (or its last expression) is JSON-serialised and sent back.
    pub script: String,
    /// Per-call timeout in ms. Default 5000.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DevSelectorArgs {
    /// CSS selector (e.g. `.cm-editor`, `button[data-id='save']`).
    pub selector: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DevTextArgs {
    pub selector: String,
    /// If true, return text of every match as an array. Default false (first match only).
    #[serde(default)]
    pub all: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DevDispatchArgs {
    pub selector: String,
    /// DOM event type (`click`, `keydown`, `input`, `custom-thing`, ...).
    pub event: String,
    /// Optional `EventInit` dict, JSON-typed. For keyboard events use e.g.
    /// `{ "key": "Enter", "bubbles": true }`.
    #[serde(default)]
    pub init: Option<JsonValue>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DevWaitForArgs {
    pub selector: String,
    /// Total wait budget in ms (poll interval is 100ms internally). Default 5000.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Look up the SoloMD app config dir (where dev_bridge writes port/token).
/// Mirrors what `app.path().app_config_dir()` returns under tauri 2 — it
/// uses the bundle identifier from `tauri.conf.json` (`app.solomd`), the
/// same path for both `pnpm tauri dev` and the installed dmg. Only debug
/// builds actually write the file though, so a stale prod install won't
/// produce one.
fn dev_bridge_config_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    #[cfg(target_os = "macos")]
    let dir = PathBuf::from(home).join("Library/Application Support/app.solomd");
    #[cfg(target_os = "linux")]
    let dir = PathBuf::from(&home).join(".config/app.solomd");
    #[cfg(target_os = "windows")]
    let dir = {
        let appdata = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(home.clone()).join("AppData/Roaming"));
        appdata.join("app.solomd")
    };
    Ok(dir)
}

fn read_dev_bridge_endpoint() -> Result<(u16, String)> {
    let dir = dev_bridge_config_dir()?;
    let port_path = dir.join("dev-bridge.port");
    let token_path = dir.join("dev-bridge.token");
    if !port_path.exists() || !token_path.exists() {
        return Err(anyhow!(
            "SoloMD dev build not running — start with `pnpm tauri dev` from app/. \
             (looked for {} and {})",
            port_path.display(),
            token_path.display()
        ));
    }
    let port: u16 = std::fs::read_to_string(&port_path)
        .map_err(|e| anyhow!("read {}: {e}", port_path.display()))?
        .trim()
        .parse()
        .map_err(|e| anyhow!("parse port: {e}"))?;
    let token = std::fs::read_to_string(&token_path)
        .map_err(|e| anyhow!("read {}: {e}", token_path.display()))?
        .trim()
        .to_string();
    Ok((port, token))
}

/// Single shared reqwest client. Cheap to clone, internally pooled.
///
/// We explicitly disable any system / env-var HTTP proxy: the dev-bridge
/// runs on 127.0.0.1, and many dev environments set `http_proxy` /
/// `all_proxy` to a local mitm/clash proxy that doesn't know how to route
/// arbitrary loopback ports — without `no_proxy` the request gets sent
/// through the proxy and comes back as 502 Bad Gateway.
fn http_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .no_proxy()
            .build()
            .expect("reqwest client")
    })
}

/// Run a raw script in the WebView. Returns whatever the script's final
/// value evaluated to. `wrap_in_return` lets call sites pass an expression
/// (we wrap with `return (...)`) vs a full statement block.
async fn dev_eval_raw(script: &str, timeout_ms: u64) -> Result<JsonValue> {
    let (port, token) = read_dev_bridge_endpoint()?;
    let url = format!("http://127.0.0.1:{port}/eval");
    let body = serde_json::json!({ "script": script, "timeout_ms": timeout_ms });
    let resp = http_client()
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("dev-bridge POST {url}: {e}"))?;
    let status = resp.status();
    let parsed: JsonValue = resp.json().await.map_err(|e| anyhow!("decode resp: {e}"))?;
    if !status.is_success() {
        return Err(anyhow!("dev-bridge {status}: {parsed}"));
    }
    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        Ok(parsed.get("value").cloned().unwrap_or(JsonValue::Null))
    } else {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("(no error message)")
            .to_string();
        Err(anyhow!("script error: {err}"))
    }
}

/// Wrap a JS *expression* into a script that returns its value. Used by
/// the higher-level convenience tools.
fn expr_script(expr: &str) -> String {
    format!("return ({expr});")
}

/// Escape a string for use inside a JS single-quoted literal.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Use \uXXXX for any control characters or things that could
            // close a script tag. Cheap belt-and-suspenders.
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

// ---------------------------------------------------------------------------
// Tool router
// ---------------------------------------------------------------------------

#[tool_router]
impl DevServer {
    #[tool(description = "Read SoloMD's persisted settings (settings.v1) from WebKit LocalStorage. Args: { bundle?: 'dev'|'prod' = 'dev' }.")]
    pub async fn solomd_get_settings(
        &self,
        Parameters(args): Parameters<BundleArgs>,
    ) -> Result<CallToolResult, McpError> {
        let v = ls_get(&args.bundle, "solomd.settings.v1")
            .map_err(|e| err(format!("get_settings failed: {e}")))?;
        Ok(json_result(v))
    }

    #[tool(description = "Set a single key in SoloMD's settings.v1. SoloMD must be CLOSED (WebKit holds the SQLite). Args: { bundle?, key, value }.")]
    pub async fn solomd_set_setting(
        &self,
        Parameters(args): Parameters<SetSettingArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut current = ls_get(&args.bundle, "solomd.settings.v1")
            .map_err(|e| err(format!("read settings: {e}")))?;
        if !current.is_object() { current = JsonValue::Object(Default::default()); }
        if let Some(obj) = current.as_object_mut() {
            obj.insert(args.key.clone(), args.value.clone());
        }
        ls_put(&args.bundle, "solomd.settings.v1", &current)
            .map_err(|e| err(format!("write settings: {e}")))?;
        Ok(text_result(format!("set {} = {}", args.key, args.value)))
    }

    #[tool(description = "Read SoloMD's workspace state (currentFolder, recentFiles).")]
    pub async fn solomd_get_workspace(
        &self,
        Parameters(args): Parameters<BundleArgs>,
    ) -> Result<CallToolResult, McpError> {
        let v = ls_get(&args.bundle, "solomd.workspace.v1")
            .map_err(|e| err(format!("get_workspace: {e}")))?;
        Ok(json_result(v))
    }

    #[tool(description = "Set SoloMD's currentFolder. SoloMD must be CLOSED. Args: { bundle?, folder }.")]
    pub async fn solomd_set_workspace(
        &self,
        Parameters(args): Parameters<SetWorkspaceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut ws = ls_get(&args.bundle, "solomd.workspace.v1")
            .unwrap_or(JsonValue::Object(Default::default()));
        if !ws.is_object() { ws = JsonValue::Object(Default::default()); }
        if let Some(obj) = ws.as_object_mut() {
            obj.insert("currentFolder".into(), JsonValue::String(args.folder.clone()));
        }
        ls_put(&args.bundle, "solomd.workspace.v1", &ws)
            .map_err(|e| err(format!("write workspace: {e}")))?;
        Ok(text_result(format!("workspace.currentFolder = {}", args.folder)))
    }

    #[tool(description = "Read SoloMD's tabs state (open tabs + activeTabId).")]
    pub async fn solomd_get_tabs(
        &self,
        Parameters(args): Parameters<BundleArgs>,
    ) -> Result<CallToolResult, McpError> {
        let v = ls_get(&args.bundle, "solomd.tabs.v1")
            .map_err(|e| err(format!("get_tabs: {e}")))?;
        Ok(json_result(v))
    }

    #[tool(description = "Replace SoloMD's tabs state with a single open tab pointing at the given file. SoloMD must be CLOSED. Args: { bundle?, file_path }.")]
    pub async fn solomd_set_tabs(
        &self,
        Parameters(args): Parameters<SetTabsArgs>,
    ) -> Result<CallToolResult, McpError> {
        let content = std::fs::read_to_string(&args.file_path)
            .map_err(|e| err(format!("read file: {e}")))?;
        let id = format!("tab-dev-{}", chrono_secs());
        let tab = serde_json::json!({
            "id": id,
            "filePath": args.file_path,
            "title": Path::new(&args.file_path).file_name().and_then(|s| s.to_str()).unwrap_or("note.md"),
            "content": content,
            "savedContent": content,
            "language": "markdown",
            "cursorLine": 1, "cursorCol": 1,
        });
        let v = serde_json::json!({ "tabs": [tab], "activeTabId": id });
        ls_put(&args.bundle, "solomd.tabs.v1", &v)
            .map_err(|e| err(format!("write tabs: {e}")))?;
        Ok(text_result(format!("active tab -> {}", args.file_path)))
    }

    #[tool(description = "Run git_workspace_status against a folder (initialized? head_sha? dirty?).")]
    pub async fn solomd_git_status(
        &self,
        Parameters(args): Parameters<GitFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let folder = args.folder;
        let repo = match Repository::open(Path::new(&folder)) {
            Ok(r) => r,
            Err(_) => {
                return Ok(json_result(serde_json::json!({
                    "initialized": false, "head_sha": null, "branch": null, "dirty": false,
                })));
            }
        };
        let head_sha = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
        let head_msg = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).and_then(|c| c.summary().map(String::from));
        let branch = repo.head().ok().and_then(|h| h.shorthand().map(String::from));
        let dirty = {
            let mut opts = StatusOptions::new();
            opts.include_untracked(true).recurse_untracked_dirs(true);
            repo.statuses(Some(&mut opts))
                .map(|s| s.iter().any(|e| {
                    let p = e.path().unwrap_or("").to_lowercase();
                    (p.ends_with(".md") || p.ends_with(".markdown") || p.ends_with(".txt"))
                        && !e.status().is_empty()
                }))
                .unwrap_or(false)
        };
        Ok(json_result(serde_json::json!({
            "initialized": true,
            "head_sha": head_sha,
            "head_message": head_msg,
            "branch": branch,
            "dirty": dirty,
        })))
    }

    #[tool(description = "Initialize a folder as a git repo and make an initial commit. Args: { folder }.")]
    pub async fn solomd_git_init(
        &self,
        Parameters(args): Parameters<GitFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let path = Path::new(&args.folder);
        if !path.exists() { return Err(err(format!("no such folder: {}", args.folder))); }
        let repo = Repository::open(path).or_else(|_| Repository::init(path))
            .map_err(|e| err(format!("init: {e}")))?;
        // Default .gitignore
        let gi = path.join(".gitignore");
        if !gi.exists() {
            let _ = std::fs::write(&gi, ".DS_Store\nThumbs.db\nnode_modules/\n");
        }
        stage(&repo, None).map_err(|e| err(e.to_string()))?;
        let sig = build_signature(&repo).map_err(|e| err(e.to_string()))?;
        let sha = commit_staged(&repo, &sig, "init: SoloMD workspace")
            .map_err(|e| err(e.to_string()))?
            .unwrap_or_default();
        Ok(text_result(format!("init ok (sha: {})", sha)))
    }

    #[tool(description = "Run git_auto_commit. Stages and commits. Returns the new sha or null if tree unchanged. Args: { folder, file_path?, message? }.")]
    pub async fn solomd_git_commit(
        &self,
        Parameters(args): Parameters<GitCommitArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = open_repo(&args.folder).map_err(|e| err(e.to_string()))?;
        let pathspec = match args.file_path.as_ref() {
            Some(abs) => match rel_path(&repo, abs) {
                Some(r) => Some(r),
                None => return Err(err(format!("file outside workspace: {}", abs))),
            },
            None => None,
        };
        stage(&repo, pathspec.as_deref()).map_err(|e| err(e.to_string()))?;
        let sig = build_signature(&repo).map_err(|e| err(e.to_string()))?;
        let msg = args.message.unwrap_or_else(|| format!("auto: dev-mcp {}", chrono_secs()));
        let sha = commit_staged(&repo, &sig, &msg).map_err(|e| err(e.to_string()))?;
        Ok(json_result(serde_json::json!({ "sha": sha })))
    }

    #[tool(description = "List commits that touched a single file, newest first. Args: { folder, file_path, limit? }.")]
    pub async fn solomd_git_log(
        &self,
        Parameters(args): Parameters<GitFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = open_repo(&args.folder).map_err(|e| err(e.to_string()))?;
        let rel = rel_path(&repo, &args.file_path)
            .ok_or_else(|| err(format!("file outside workspace: {}", args.file_path)))?;
        let head_oid = match repo.head().ok().and_then(|h| h.target()) {
            Some(o) => o,
            None => return Ok(json_result(serde_json::json!([]))),
        };
        let mut walk = repo.revwalk().map_err(|e| err(e.to_string()))?;
        walk.set_sorting(Sort::TIME).ok();
        walk.push(head_oid).map_err(|e| err(e.to_string()))?;
        let cap = args.limit.unwrap_or(50).max(1) as usize;
        let mut out: Vec<CommitInfo> = Vec::with_capacity(cap);
        for oid in walk {
            let oid = match oid { Ok(o) => o, Err(_) => continue };
            let commit = match repo.find_commit(oid) { Ok(c) => c, Err(_) => continue };
            // Did this commit touch `rel`?
            let tree = match commit.tree() { Ok(t) => t, Err(_) => continue };
            let touches = if commit.parent_count() == 0 {
                tree.get_path(Path::new(&rel)).is_ok()
            } else {
                let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
                let mut opts = DiffOptions::new();
                opts.pathspec(&rel);
                repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
                    .map(|d| d.deltas().len() > 0).unwrap_or(false)
            };
            if !touches { continue; }
            out.push(commit_info(&commit));
            if out.len() >= cap { break; }
        }
        Ok(json_result(serde_json::to_value(&out).unwrap()))
    }

    #[tool(description = "Read a file's content at a specific commit (without modifying disk). Args: { folder, file_path, sha }.")]
    pub async fn solomd_git_file_at(
        &self,
        Parameters(args): Parameters<GitFileShaArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = open_repo(&args.folder).map_err(|e| err(e.to_string()))?;
        let rel = rel_path(&repo, &args.file_path)
            .ok_or_else(|| err(format!("file outside workspace: {}", args.file_path)))?;
        let oid = Oid::from_str(&args.sha).map_err(|e| err(format!("bad sha: {e}")))?;
        let commit = repo.find_commit(oid).map_err(|e| err(e.to_string()))?;
        let tree = commit.tree().map_err(|e| err(e.to_string()))?;
        let entry = tree.get_path(Path::new(&rel))
            .map_err(|e| err(format!("not in commit: {e}")))?;
        let object = entry.to_object(&repo).map_err(|e| err(e.to_string()))?;
        let blob = object.as_blob().ok_or_else(|| err("not a blob"))?;
        let content = String::from_utf8_lossy(blob.content()).to_string();
        Ok(text_result(content))
    }

    #[tool(description = "Roll back a single file's working-copy content to a specific commit. Args: { folder, file_path, sha }.")]
    pub async fn solomd_git_rollback(
        &self,
        Parameters(args): Parameters<GitFileShaArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Reuse our own file_at then write to disk.
        let folder = args.folder.clone();
        let file_path = args.file_path.clone();
        let sha = args.sha.clone();
        let repo = open_repo(&folder).map_err(|e| err(e.to_string()))?;
        let rel = rel_path(&repo, &file_path)
            .ok_or_else(|| err(format!("file outside workspace: {}", file_path)))?;
        let oid = Oid::from_str(&sha).map_err(|e| err(format!("bad sha: {e}")))?;
        let commit = repo.find_commit(oid).map_err(|e| err(e.to_string()))?;
        let tree = commit.tree().map_err(|e| err(e.to_string()))?;
        let entry = tree.get_path(Path::new(&rel))
            .map_err(|e| err(format!("not in commit: {e}")))?;
        let object = entry.to_object(&repo).map_err(|e| err(e.to_string()))?;
        let blob = object.as_blob().ok_or_else(|| err("not a blob"))?;
        std::fs::write(&file_path, blob.content())
            .map_err(|e| err(format!("write: {e}")))?;
        Ok(text_result(format!("rollback ok ({} bytes -> {})", blob.content().len(), file_path)))
    }

    #[tool(description = "Read a file from disk. Args: { path }.")]
    pub async fn solomd_read_file(
        &self,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, McpError> {
        let s = std::fs::read_to_string(&args.path)
            .map_err(|e| err(format!("read: {e}")))?;
        Ok(text_result(s))
    }

    #[tool(description = "Write a file to disk. Args: { path, content }.")]
    pub async fn solomd_write_file(
        &self,
        Parameters(args): Parameters<WriteFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        std::fs::write(&args.path, &args.content)
            .map_err(|e| err(format!("write: {e}")))?;
        Ok(text_result(format!("wrote {} bytes -> {}", args.content.len(), args.path)))
    }

    #[tool(description = "Take a full-screen screenshot. Returns the absolute path to a PNG that the caller can read.")]
    pub async fn solomd_screenshot(
        &self,
        Parameters(_args): Parameters<EmptyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let path = format!("/tmp/solomd-dev-mcp-{}.png", chrono_secs());
        let status = AsyncCommand::new("screencapture")
            .args(["-x", "-o", &path])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status().await.map_err(|e| err(format!("screencapture spawn: {e}")))?;
        if !status.success() {
            return Err(err(format!("screencapture exited: {status}")));
        }
        Ok(text_result(path))
    }

    #[tool(description = "v2.3 live-edit self-test. Reports current viewMode, the contract of CSS class names the live-edit extension is expected to emit (so the caller can grep for them in a screenshot or DOM dump), and the active tab's markdown so the caller can know which classes SHOULD be present. Args: { bundle?: 'dev'|'prod' }.")]
    pub async fn solomd_get_editor_decorations(
        &self,
        Parameters(args): Parameters<BundleArgs>,
    ) -> Result<CallToolResult, McpError> {
        // CSS classes emitted by app/src/lib/cm-live-render.ts. Keep this
        // list in sync with the LIVE_EDIT_CLASSES constant exported there
        // — both are the contract the dev-MCP self-test checks against.
        let live_edit_classes = vec![
            "cm-md-heading-line-1",
            "cm-md-heading-line-2",
            "cm-md-heading-line-3",
            "cm-md-heading-line-4",
            "cm-md-heading-line-5",
            "cm-md-heading-line-6",
            "cm-md-strong",
            "cm-md-em",
            "cm-md-strike",
            "cm-md-code",
            "cm-md-link",
            "cm-md-quote-line",
            "cm-md-fenced-line",
        ];

        let settings = ls_get(&args.bundle, "solomd.settings.v1")
            .unwrap_or(JsonValue::Null);
        let view_mode = settings
            .get("viewMode")
            .and_then(|v| v.as_str())
            .unwrap_or("edit")
            .to_string();
        let live_edit_active = view_mode == "liveEdit";

        // Pull the active tab's content so the caller can correlate
        // expected decorations (e.g. "this doc has a `# H1` so the DOM
        // should contain `.cm-md-heading-line-1`").
        let tabs = ls_get(&args.bundle, "solomd.tabs.v1").unwrap_or(JsonValue::Null);
        let active_id = tabs
            .get("activeTabId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut active_content = String::new();
        let mut active_path = String::new();
        if let Some(arr) = tabs.get("tabs").and_then(|v| v.as_array()) {
            for tab in arr {
                if tab.get("id").and_then(|v| v.as_str()) == Some(active_id) {
                    active_content = tab
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    active_path = tab
                        .get("filePath")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    break;
                }
            }
        }

        // Heuristic "expected classes" derived from the active doc — so
        // the caller can self-test by checking that screenshots of the
        // editor in liveEdit mode actually render these.
        let mut expected: Vec<&str> = Vec::new();
        if active_content.lines().any(|l| l.starts_with("# ")) {
            expected.push("cm-md-heading-line-1");
        }
        if active_content.lines().any(|l| l.starts_with("## ")) {
            expected.push("cm-md-heading-line-2");
        }
        if active_content.lines().any(|l| l.starts_with("### ")) {
            expected.push("cm-md-heading-line-3");
        }
        if active_content.contains("**") {
            expected.push("cm-md-strong");
        }
        if active_content.contains('*') {
            expected.push("cm-md-em");
        }
        if active_content.contains('`') {
            expected.push("cm-md-code");
        }
        if active_content.contains("](") {
            expected.push("cm-md-link");
        }
        if active_content.lines().any(|l| l.trim_start().starts_with('>')) {
            expected.push("cm-md-quote-line");
        }
        if active_content.contains("```") {
            expected.push("cm-md-fenced-line");
        }

        Ok(json_result(serde_json::json!({
            "view_mode": view_mode,
            "live_edit_active": live_edit_active,
            "active_tab_path": active_path,
            "active_tab_chars": active_content.chars().count(),
            "live_edit_classes": live_edit_classes,
            "expected_classes_from_active_doc": expected,
            "note": "Live edit decorations only render when view_mode == 'liveEdit'. Take a screenshot via solomd_screenshot and verify the listed classes appear in the rendered DOM (Inspector). To self-test programmatically, use the existing chrome-devtools MCP to evaluate `document.querySelectorAll('.cm-md-heading-line-1').length > 0` on the WebView.",
        })))
    }

    #[tool(description = "v2.3 RAG: report semantic-index status for a workspace folder. Args: { folder }.")]
    pub async fn solomd_rag_status(
        &self,
        Parameters(args): Parameters<RagFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let folder = args.folder.clone();
        let total_files = rag_list_markdown(&folder).len();
        let db_p = rag_db_path(&folder);
        if !db_p.exists() {
            return Ok(json_result(serde_json::json!({
                "ready": false,
                "total_files": total_files,
                "indexed_files": 0,
                "total_chunks": 0,
                "backend": "hash-trigram-256",
                "index_version": RAG_INDEX_VERSION,
                "db_path": db_p.to_string_lossy(),
            })));
        }
        let conn = rag_open_db(&folder).map_err(|e| err(e.to_string()))?;
        let indexed: i64 = conn
            .query_row("SELECT COUNT(*) FROM rag_files", [], |r| r.get(0))
            .unwrap_or(0);
        let chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM rag_chunks", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(json_result(serde_json::json!({
            "ready": indexed > 0,
            "total_files": total_files,
            "indexed_files": indexed,
            "total_chunks": chunks,
            "backend": "hash-trigram-256",
            "index_version": RAG_INDEX_VERSION,
            "db_path": db_p.to_string_lossy(),
        })))
    }

    #[tool(description = "v2.3 RAG: full reindex of a workspace folder (writes <folder>/.solomd/embeddings.sqlite). Args: { folder }.")]
    pub async fn solomd_rag_reindex(
        &self,
        Parameters(args): Parameters<RagFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let folder = args.folder.clone();
        if !Path::new(&folder).is_dir() {
            return Err(err(format!("not a directory: {folder}")));
        }
        let conn = rag_open_db(&folder).map_err(|e| err(e.to_string()))?;
        conn.execute("DELETE FROM rag_chunks", []).ok();
        conn.execute("DELETE FROM rag_files", []).ok();
        let files = rag_list_markdown(&folder);
        let mut total_chunks: usize = 0;
        for f in &files {
            total_chunks += rag_index_one(&conn, f).map_err(|e| err(e.to_string()))?;
        }
        Ok(json_result(serde_json::json!({
            "indexed_files": files.len(),
            "total_chunks": total_chunks,
            "db_path": rag_db_path(&folder).to_string_lossy(),
        })))
    }

    #[tool(description = "v2.3 RAG: semantic search over an indexed workspace. Top-K results by cosine similarity. Args: { folder, query, limit? }.")]
    pub async fn solomd_rag_search(
        &self,
        Parameters(args): Parameters<RagSearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let folder = args.folder.clone();
        let q = args.query.trim().to_string();
        let cap = args.limit.unwrap_or(20).max(1) as usize;
        if q.is_empty() {
            return Ok(json_result(serde_json::json!([])));
        }
        let db_p = rag_db_path(&folder);
        if !db_p.exists() {
            return Err(err("index not built yet — run solomd_rag_reindex first"));
        }
        let conn = rag_open_db(&folder).map_err(|e| err(e.to_string()))?;
        let qv = rag_embed(&q);

        let mut stmt = conn
            .prepare("SELECT path, chunk_idx, char_start, char_end, snippet, embedding FROM rag_chunks")
            .map_err(|e| err(e.to_string()))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Vec<u8>>(5)?,
                ))
            })
            .map_err(|e| err(e.to_string()))?;

        let mut best: HashMap<String, (f32, serde_json::Value)> = HashMap::new();
        for row in rows.flatten() {
            let (path, idx, cs, ce, snippet, blob) = row;
            let v = rag_bytes_to_vec(&blob);
            let s = rag_cosine(&qv, &v);
            let name = Path::new(&path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let item = serde_json::json!({
                "path": path,
                "name": name,
                "chunk_idx": idx,
                "char_start": cs,
                "char_end": ce,
                "score": s,
                "snippet": snippet,
            });
            match best.get(&path) {
                Some((prev, _)) if *prev >= s => {}
                _ => {
                    best.insert(path, (s, item));
                }
            }
        }
        let mut hits: Vec<serde_json::Value> = best.into_values().map(|(_, v)| v).collect();
        hits.sort_by(|a, b| {
            let sa = a.get("score").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let sb = b.get("score").and_then(|x| x.as_f64()).unwrap_or(0.0);
            sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(cap);
        Ok(json_result(serde_json::Value::Array(hits)))
    }

    #[tool(description = "List running SoloMD processes (dev = `target/debug/SoloMD`, prod = `/Applications/SoloMD.app`).")]
    pub async fn solomd_app_status(
        &self,
        Parameters(_args): Parameters<EmptyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let out = AsyncCommand::new("/bin/sh")
            .arg("-c")
            .arg("ps -ax -o pid,etime,command | grep -E 'target/debug/SoloMD|/Applications/SoloMD.app/Contents/MacOS/SoloMD' | grep -v grep")
            .output().await.map_err(|e| err(format!("ps: {e}")))?;
        let s = String::from_utf8_lossy(&out.stdout).to_string();
        let lines: Vec<HashMap<&str, String>> = s.lines().map(|line| {
            let mut parts = line.trim().splitn(3, char::is_whitespace);
            let pid = parts.next().unwrap_or("").to_string();
            let elapsed = parts.next().unwrap_or("").to_string();
            let cmd = parts.next().unwrap_or("").to_string();
            let kind = if cmd.contains("/Applications/") { "prod" } else { "dev" };
            HashMap::from([
                ("pid", pid),
                ("elapsed", elapsed),
                ("kind", kind.to_string()),
                ("cmd", cmd),
            ])
        }).collect();
        Ok(json_result(serde_json::to_value(&lines).unwrap()))
    }

    // -----------------------------------------------------------------
    // v2.3 Dev Bridge — drive the live Vue UI (clicks, DOM reads, etc.).
    // Talks to the localhost JSON-RPC server inside SoloMD's debug build
    // (see app/src-tauri/src/dev_bridge.rs).
    // -----------------------------------------------------------------

    #[tool(description = "v2.3 dev-bridge: evaluate arbitrary JavaScript inside SoloMD's main WebView and return the result. Script runs inside an `async` IIFE — `await` is allowed. Use a `return` statement (or just leave a trailing expression evaluated via async return) to send a value back. Args: { script, timeout_ms? }. Requires `pnpm tauri dev` running.")]
    pub async fn solomd_dev_eval(
        &self,
        Parameters(args): Parameters<DevEvalArgs>,
    ) -> Result<CallToolResult, McpError> {
        let timeout_ms = args.timeout_ms.unwrap_or(5_000);
        match dev_eval_raw(&args.script, timeout_ms).await {
            Ok(v) => Ok(json_result(v)),
            Err(e) => Err(err(e.to_string())),
        }
    }

    #[tool(description = "v2.3 dev-bridge: click the first DOM element matching `selector`. Returns { matched: bool, selector }. Args: { selector }.")]
    pub async fn solomd_dev_click(
        &self,
        Parameters(args): Parameters<DevSelectorArgs>,
    ) -> Result<CallToolResult, McpError> {
        let sel = js_string(&args.selector);
        let script = format!(
            "const el = document.querySelector({sel}); \
             if (!el) return {{ matched: false, selector: {sel} }}; \
             el.click(); \
             return {{ matched: true, selector: {sel}, tag: el.tagName.toLowerCase() }};"
        );
        match dev_eval_raw(&script, 3_000).await {
            Ok(v) => Ok(json_result(v)),
            Err(e) => Err(err(e.to_string())),
        }
    }

    #[tool(description = "v2.3 dev-bridge: read the textContent of one or all DOM elements matching `selector`. With `all: true` returns an array; default returns the first match (or null). Args: { selector, all? }.")]
    pub async fn solomd_dev_text(
        &self,
        Parameters(args): Parameters<DevTextArgs>,
    ) -> Result<CallToolResult, McpError> {
        let sel = js_string(&args.selector);
        let all = args.all.unwrap_or(false);
        let script = if all {
            format!(
                "return Array.from(document.querySelectorAll({sel})).map(e => (e.textContent || '').trim());"
            )
        } else {
            format!(
                "const el = document.querySelector({sel}); \
                 return el ? (el.textContent || '').trim() : null;"
            )
        };
        match dev_eval_raw(&script, 3_000).await {
            Ok(v) => Ok(json_result(v)),
            Err(e) => Err(err(e.to_string())),
        }
    }

    #[tool(description = "v2.3 dev-bridge: dispatch a DOM event on the first matching element. Use this for keyboard input, custom events, etc. that `.click()` can't synthesise. `init` is the EventInit dict (e.g. `{ key: 'Enter', bubbles: true }`). Args: { selector, event, init? }.")]
    pub async fn solomd_dev_dispatch(
        &self,
        Parameters(args): Parameters<DevDispatchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let sel = js_string(&args.selector);
        let event = js_string(&args.event);
        let init_json = match args.init {
            Some(v) => serde_json::to_string(&v).unwrap_or_else(|_| "{}".into()),
            None => "{}".into(),
        };
        // Pick the right Event constructor for common types — KeyboardEvent
        // for keydown/up/press, MouseEvent for click/down/up/move, custom
        // string falls back to CustomEvent.
        let script = format!(
            "const el = document.querySelector({sel}); \
             if (!el) return {{ matched: false }}; \
             const evt_type = {event}; \
             const init = Object.assign({{ bubbles: true, cancelable: true }}, ({init_json})); \
             let ev; \
             if (/^key/i.test(evt_type)) ev = new KeyboardEvent(evt_type, init); \
             else if (/^(mouse|click|dbl|context)/i.test(evt_type)) ev = new MouseEvent(evt_type, init); \
             else if (/^(input|change|focus|blur|select)/i.test(evt_type)) ev = new Event(evt_type, init); \
             else ev = new CustomEvent(evt_type, {{ ...init, detail: init.detail }}); \
             const default_prevented = !el.dispatchEvent(ev); \
             return {{ matched: true, selector: {sel}, event: evt_type, default_prevented }};"
        );
        match dev_eval_raw(&script, 3_000).await {
            Ok(v) => Ok(json_result(v)),
            Err(e) => Err(err(e.to_string())),
        }
    }

    #[tool(description = "v2.3 dev-bridge: report `location.href` of the SoloMD WebView. Use this to confirm the app is on the right route after navigation.")]
    pub async fn solomd_dev_url(
        &self,
        Parameters(_args): Parameters<EmptyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let script = expr_script("location.href");
        match dev_eval_raw(&script, 3_000).await {
            Ok(v) => Ok(json_result(v)),
            Err(e) => Err(err(e.to_string())),
        }
    }

    #[tool(description = "v2.3 dev-bridge: poll until `selector` matches at least one element, or the timeout fires. Returns { matched, elapsed_ms } on success, errors on timeout. Args: { selector, timeout_ms? } (default 5000ms, polled at 100ms).")]
    pub async fn solomd_dev_wait_for(
        &self,
        Parameters(args): Parameters<DevWaitForArgs>,
    ) -> Result<CallToolResult, McpError> {
        let sel = js_string(&args.selector);
        let total = args.timeout_ms.unwrap_or(5_000);
        // Run the polling loop *inside* the WebView — one bridge call only.
        // We give the bridge call a buffer over the JS timeout so the
        // outer `timeout_ms` actually governs the wait.
        let script = format!(
            "const start = Date.now(); \
             const total = {total}; \
             const sel = {sel}; \
             while (Date.now() - start < total) {{ \
               if (document.querySelector(sel)) {{ \
                 return {{ matched: true, elapsed_ms: Date.now() - start, selector: sel }}; \
               }} \
               await new Promise(r => setTimeout(r, 100)); \
             }} \
             throw new Error('wait_for timeout: ' + sel + ' (waited ' + total + 'ms)');"
        );
        match dev_eval_raw(&script, total + 1_000).await {
            Ok(v) => Ok(json_result(v)),
            Err(e) => Err(err(e.to_string())),
        }
    }
}

#[tool_handler]
impl ServerHandler for DevServer {
    fn get_info(&self) -> ServerInfo {
        let implementation = Implementation::new("solomd-dev-mcp", env!("CARGO_PKG_VERSION"))
            .with_title("SoloMD dev test harness");
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(implementation)
            .with_instructions(
                "Internal MCP server for end-to-end self-testing of SoloMD. \
                 Tools: solomd_get_settings/solomd_set_setting, \
                 solomd_get_workspace/solomd_set_workspace, \
                 solomd_get_tabs/solomd_set_tabs, \
                 solomd_git_status/init/commit/log/rollback/file_at, \
                 solomd_rag_status/solomd_rag_reindex/solomd_rag_search, \
                 solomd_read_file/solomd_write_file, \
                 solomd_get_editor_decorations (v2.3 live-edit self-test), \
                 solomd_screenshot, solomd_app_status, \
                 solomd_dev_eval/click/text/dispatch/url/wait_for (v2.3 live UI bridge — needs `pnpm tauri dev`). \
                 Settings/workspace/tabs writes require SoloMD be closed.",
            )
    }
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

fn err(msg: impl Into<String>) -> McpError {
    McpError::internal_error(msg.into(), None)
}

fn text_result(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(s.into())])
}

fn json_result(v: JsonValue) -> CallToolResult {
    let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
    CallToolResult::success(vec![Content::text(pretty)])
}

fn chrono_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
