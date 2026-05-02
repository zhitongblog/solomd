//! v4.0 pillar 1 — in-process agent tool registry (C3.1).
//!
//! The Inline Agent Panel calls these from the Tauri Rust side directly —
//! NOT via the external `solomd-mcp` binary. Each tool wraps existing app
//! logic (`workspace_index`, `search`, `git_history`, `commands` for fs).
//! This avoids a JSON-RPC / subprocess hop, decouples the panel from the
//! external MCP binary's wire format (which P4/Federation evolves
//! independently), and lets P3/replay reuse the same handlers.
//!
//! Each tool is exposed as a Tauri command `agent_tool_<name>` so the
//! frontend can also drive them directly when the user pins a tool to a
//! button. Internally `dispatch_tool` is the entry point used by the
//! `ai_chat` tool-call loop in `ai_proxy.rs`.
//!
//! Helpers in this file mirror — and in some cases duplicate — code from
//! `mcp-server/src/workspace.rs` (per the contracts: copy is fine, no path
//! deps). When `workspace_index` already has live state for the same
//! workspace we reuse it; otherwise we walk the disk lazily.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use once_cell::sync::Lazy;
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use walkdir::WalkDir;

// `super::` paths so this module compiles under both lib + bin mount
// trees (see ai_proxy.rs comment for the same rationale).
use super::git_history;
use super::search;

// ---------------------------------------------------------------------------
// Recipe write-cap registry (v4.0 P2)
// ---------------------------------------------------------------------------
//
// Recipes (`recipe_runner.rs`) can't intercept individual tool dispatches
// inside `ai_proxy.rs`'s chat loops without invasive refactors. Instead,
// before kicking off the loop the runner installs a per-workspace write
// quota; `dispatch_tool_inner` consults that quota every time a write tool
// (`write_note` / `append_to_note`) is requested, refusing once the recipe
// has used its allotment. The registry is keyed by absolute workspace
// path. Limitation: two recipes running concurrently on the same workspace
// (different slugs) share the quota — we accept this since the existing
// cooldown logic in `RecipesState` makes overlap rare in practice.
//
// Panel chats DO NOT install a guard — they're allowed unlimited writes
// up to the user's `tool_loop_cap`, which already bounds them.

#[derive(Debug, Clone)]
struct RecipeWriteCapEntry {
    /// Maximum number of write tool calls allowed for this run.
    cap: u32,
    /// How many have been consumed so far.
    used: u32,
}

static RECIPE_WRITE_CAPS: Lazy<Mutex<HashMap<PathBuf, RecipeWriteCapEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Install a write-cap quota for the given workspace. Subsequent
/// `dispatch_tool` invocations from `write_note` / `append_to_note` will
/// be refused (without dispatching) once `cap` writes have been consumed.
/// Returns the previous entry, if any — caller should typically clear
/// before installing.
pub fn install_recipe_write_cap(workspace: &Path, cap: u32) -> Option<u32> {
    let mut guard = RECIPE_WRITE_CAPS.lock().ok()?;
    let prev = guard.get(workspace).map(|e| e.cap);
    guard.insert(
        workspace.to_path_buf(),
        RecipeWriteCapEntry { cap, used: 0 },
    );
    prev
}

/// Remove the recipe write-cap quota for the given workspace. Returns the
/// number of writes consumed (so the caller can record it to the trace).
pub fn clear_recipe_write_cap(workspace: &Path) -> u32 {
    let mut guard = match RECIPE_WRITE_CAPS.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    guard.remove(workspace).map(|e| e.used).unwrap_or(0)
}

/// Snapshot the current `(used, cap)` for the given workspace, or `None`
/// if no quota is installed. Used by the recipe runner for diagnostics.
#[allow(dead_code)]
pub fn current_recipe_write_cap(workspace: &Path) -> Option<(u32, u32)> {
    RECIPE_WRITE_CAPS
        .lock()
        .ok()
        .and_then(|g| g.get(workspace).map(|e| (e.used, e.cap)))
}

/// Charge one write against the workspace's installed quota. Returns
/// Ok(()) when there is room (and bumps `used`); Err with a human-readable
/// message when the cap would be exceeded. Returns Ok(()) when no quota is
/// installed (panel chats bypass).
fn charge_write_cap(workspace: &Path) -> Result<(), String> {
    let mut guard = match RECIPE_WRITE_CAPS.lock() {
        Ok(g) => g,
        Err(_) => return Ok(()),
    };
    if let Some(entry) = guard.get_mut(workspace) {
        if entry.used >= entry.cap {
            return Err(format!(
                "write-cap exceeded ({}/{}) — refusing further write tool calls for this run",
                entry.used, entry.cap
            ));
        }
        entry.used += 1;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tool list / read-vs-write classification
// ---------------------------------------------------------------------------

/// Every tool name C3.1 declares. Frontend ships these to the LLM as the
/// tool schema; `dispatch_tool` uses this list to validate.
pub const READ_TOOLS: &[&str] = &[
    "list_notes",
    "read_note",
    "search",
    "get_backlinks",
    "list_tags",
    "get_outline",
    "autogit_log",
    "autogit_diff",
    "read_agent_trace",
];
pub const WRITE_TOOLS: &[&str] = &["write_note", "append_to_note"];

#[allow(dead_code)]
pub fn all_tools() -> Vec<&'static str> {
    READ_TOOLS.iter().chain(WRITE_TOOLS.iter()).copied().collect()
}

pub fn is_write_tool(name: &str) -> bool {
    WRITE_TOOLS.contains(&name)
}

// ---------------------------------------------------------------------------
// JSON-Schema descriptors used by ai_proxy when building provider-specific
// tool payloads (Anthropic `tools: [...]`, OpenAI `tools: [{function:...}]`).
// Keep these minimal — the LLM only needs the args shape, not the result.
// ---------------------------------------------------------------------------

pub fn tool_descriptor(name: &str) -> Option<(&'static str, Value)> {
    let (desc, schema) = match name {
        "list_notes" => (
            "List markdown files in the workspace. Returns lightweight metadata (path, name, title, mtime, summary).",
            json!({
                "type": "object",
                "properties": {
                    "folder": { "type": "string", "description": "Optional workspace-relative folder to scope to (e.g. 'daily')." },
                    "limit": { "type": "integer", "description": "Cap result count. Default 200." }
                }
            }),
        ),
        "read_note" => (
            "Read a single markdown note. Returns content + parsed frontmatter, headings, tags, wikilinks.",
            json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative path to a markdown file (e.g. 'daily/2026-04-30.md'). Absolute paths and `..` traversal are rejected." }
                }
            }),
        ),
        "search" => (
            "Full-text search across the workspace's markdown / text files. Returns matching lines + snippets.",
            json!({
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": { "type": "string" },
                    "mode": { "type": "string", "enum": ["literal", "regex"], "description": "literal (default) or regex match" },
                    "limit": { "type": "integer", "description": "Cap on matches. Default 50." }
                }
            }),
        ),
        "get_backlinks" => (
            "Find all notes that link to the given note via [[wikilinks]].",
            json!({
                "type": "object",
                "required": ["note_name"],
                "properties": {
                    "note_name": { "type": "string", "description": "Stem of the target note (no extension), e.g. 'Welcome'." }
                }
            }),
        ),
        "list_tags" => (
            "Enumerate every #tag used in the vault, with per-tag file counts.",
            json!({"type": "object", "properties": {}}),
        ),
        "get_outline" => (
            "Get the heading tree (level/text/line) for a markdown note.",
            json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" }
                }
            }),
        ),
        "autogit_log" => (
            "Recent AutoGit commits that touched a given file.",
            json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" },
                    "limit": { "type": "integer", "description": "Default 20." }
                }
            }),
        ),
        "autogit_diff" => (
            "Unified diff for a given commit on a given file (vs its parent).",
            json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string" },
                    "sha": { "type": "string", "description": "Commit SHA. Defaults to HEAD." }
                }
            }),
        ),
        "read_agent_trace" => (
            "Read a previous agent run's trace.jsonl (returns parsed steps).",
            json!({
                "type": "object",
                "required": ["run_id"],
                "properties": {
                    "run_id": { "type": "string" }
                }
            }),
        ),
        "write_note" => (
            "Create or overwrite a markdown note. Requires --allow-write.",
            json!({
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative path (e.g. 'weekly/2026-W17.md')." },
                    "content": { "type": "string" },
                    "allow_overwrite": { "type": "boolean", "description": "If false (default), fail when the file already exists." }
                }
            }),
        ),
        "append_to_note" => (
            "Append content to the end of an existing note. Requires --allow-write.",
            json!({
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                }
            }),
        ),
        _ => return None,
    };
    Some((desc, schema))
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/// Resolve a *workspace-relative* arg path against the workspace root,
/// blocking traversal outside the workspace at the filesystem level (not just
/// lexically). The canonical pattern lives in `mcp-server/src/safety.rs` —
/// keep this in sync with it.
///
/// The previous implementation had a HIGH-severity bug (v4.0 P1): when the
/// candidate's parent directory didn't yet exist on disk (write paths like
/// `subdir/new.md`), `parent.canonicalize()` failed and the code fell back
/// to the unresolved `candidate` — which still contained `..` segments.
/// `starts_with(workspace)` then trivially passed because the path
/// *lexically* began with the workspace prefix, but `..` segments still
/// escaped at filesystem level when the file was later created/read.
/// Exploit: an LLM passing `{"path": "../../tmp/pwn/x.md"}` resolved to
/// `/tmp/pwn/x.md` and `write_note` happily mkdir-p'd + wrote there.
///
/// The new logic:
/// 1. Reject any input containing a `..` component upfront.
/// 2. Reject absolute paths (LLM tools must stay workspace-scoped).
/// 3. For nonexistent leaves, walk up to find the deepest existing
///    ancestor, canonicalize that, then reattach the remaining segments.
/// 4. Re-verify the resolved path starts with the canonicalized workspace.
fn resolve_in_workspace(workspace: &Path, arg_path: &str) -> Result<PathBuf, String> {
    let trimmed = arg_path.trim();
    if trimmed.is_empty() {
        return Err("path: empty".into());
    }
    let raw = PathBuf::from(trimmed);

    // (1) reject `..` components anywhere in the input — no exceptions.
    for c in raw.components() {
        if matches!(c, Component::ParentDir) {
            return Err(format!("path traversal (..) is not allowed: {arg_path}"));
        }
    }
    // (2) reject absolute paths — agent tools are workspace-scoped.
    if raw.is_absolute() {
        return Err(format!("absolute path not allowed: {arg_path}"));
    }

    let workspace_canon = workspace
        .canonicalize()
        .map_err(|e| format!("workspace not accessible: {e}"))?;
    let candidate = workspace_canon.join(&raw);

    // (3) Resolve safely whether or not the leaf / its parent exists. Walk
    // up the candidate's ancestors until we find one that exists on disk,
    // canonicalize that, then reattach the trailing components verbatim.
    let resolved = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| format!("cannot resolve path {}: {e}", candidate.display()))?
    } else {
        let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
        let mut cursor: &Path = candidate.as_path();
        let existing = loop {
            if cursor.exists() {
                break cursor.to_path_buf();
            }
            match (cursor.file_name(), cursor.parent()) {
                (Some(name), Some(parent)) => {
                    tail.push(name);
                    cursor = parent;
                }
                _ => {
                    return Err(format!(
                        "cannot resolve path {}: no existing ancestor",
                        candidate.display()
                    ));
                }
            }
        };
        let mut resolved = existing
            .canonicalize()
            .map_err(|e| format!("cannot resolve {}: {e}", existing.display()))?;
        for seg in tail.iter().rev() {
            resolved.push(seg);
        }
        resolved
    };

    // (4) Final containment check against the *canonicalized* workspace.
    if !resolved.starts_with(&workspace_canon) {
        return Err(format!(
            "path {} escapes workspace {}",
            resolved.display(),
            workspace_canon.display()
        ));
    }
    Ok(resolved)
}

/// Validate a user-supplied agent-run identifier.
///
/// `read_agent_trace` joins `run_id` directly into a filesystem path
/// (`<workspace>/.solomd/agent-runs/<run_id>/trace.jsonl`). Without this
/// check, an LLM could pass `run_id: "../../etc/passwd"` and read
/// arbitrary files (the `.solomd/agent-runs/` prefix only bounds *which*
/// dir we start from — `..` walks above it).
///
/// We require the canonical shape used by the run writer:
/// `YYYYMMDD-HHMMSS-<hex>` where `<hex>` is 1+ lowercase hex chars. This
/// is a strict allow-list — nothing else (slashes, dots, spaces) gets in.
fn validate_run_id(run_id: &str) -> Result<&str, String> {
    let bytes = run_id.as_bytes();
    // Minimum: 8 + 1 + 6 + 1 + 1 = 17 chars.
    if bytes.len() < 17 {
        return Err(format!("invalid run_id (too short): {run_id}"));
    }
    let is_digit = |b: u8| b.is_ascii_digit();
    let is_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);

    // YYYYMMDD
    if !bytes[..8].iter().all(|&b| is_digit(b)) {
        return Err(format!("invalid run_id (bad date): {run_id}"));
    }
    if bytes[8] != b'-' {
        return Err(format!("invalid run_id (missing dash after date): {run_id}"));
    }
    // HHMMSS
    if !bytes[9..15].iter().all(|&b| is_digit(b)) {
        return Err(format!("invalid run_id (bad time): {run_id}"));
    }
    if bytes[15] != b'-' {
        return Err(format!("invalid run_id (missing dash after time): {run_id}"));
    }
    // Suffix: 1+ lowercase hex chars, nothing else.
    let suffix = &bytes[16..];
    if suffix.is_empty() || !suffix.iter().all(|&b| is_hex(b)) {
        return Err(format!("invalid run_id (bad suffix): {run_id}"));
    }
    Ok(run_id)
}

// ---------------------------------------------------------------------------
// Markdown parsing helpers (mirror of mcp-server/src/workspace.rs +
// workspace_index.rs — copied per contract C3.1's "either works" allowance).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct HeadingRef {
    pub level: u32,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WikilinkRef {
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    pub line: u32,
}

fn split_front_matter(raw: &str) -> (Option<String>, &str) {
    let trimmed = raw.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return (None, raw);
    }
    let after_first = match trimmed.find('\n') {
        Some(i) => &trimmed[i + 1..],
        None => return (None, raw),
    };
    if let Some(end) = after_first.find("\n---") {
        let yaml = &after_first[..end];
        let rest_offset = end + "\n---".len();
        let rest = &after_first[rest_offset..];
        let rest = rest.strip_prefix('\n').unwrap_or(rest);
        return (Some(yaml.to_string()), rest);
    }
    (None, raw)
}

fn extract_headings(body: &str) -> Vec<HeadingRef> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*$").expect("heading regex"));
    let mut out = Vec::new();
    let mut in_fence = false;
    for (line_idx, line) in body.lines().enumerate() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(cap) = RE.captures(line) {
            let level = cap.get(1).map(|m| m.as_str().len() as u32).unwrap_or(1);
            if let Some(m) = cap.get(2) {
                out.push(HeadingRef {
                    level,
                    text: m.as_str().trim().to_string(),
                    line: (line_idx as u32) + 1,
                });
            }
        }
    }
    out
}

fn extract_wikilinks(body: &str) -> Vec<WikilinkRef> {
    static RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\[\[([^\[\]\n]+?)\]\]").expect("wikilink regex"));
    let mut out = Vec::new();
    for (line_idx, line) in body.lines().enumerate() {
        for cap in RE.captures_iter(line) {
            let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let (target_raw, alias) = match inner.split_once('|') {
                Some((t, a)) => (t.trim().to_string(), Some(a.trim().to_string())),
                None => (inner.trim().to_string(), None),
            };
            let (target, heading) = match target_raw.split_once('#') {
                Some((t, h)) => (t.trim().to_string(), Some(h.trim().to_string())),
                None => (target_raw, None),
            };
            if target.is_empty() {
                continue;
            }
            out.push(WikilinkRef {
                target,
                heading,
                alias,
                line: (line_idx as u32) + 1,
            });
        }
    }
    out
}

fn extract_body_tags(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let stripped = strip_inline_code(line);
        scan_tags_in_line(&stripped, &mut out);
    }
    out
}

fn strip_inline_code(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_code = false;
    for ch in s.chars() {
        if ch == '`' {
            in_code = !in_code;
            out.push(' ');
        } else if in_code {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

fn scan_tags_in_line(line: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let preceded_ok = i == 0 || chars[i - 1].is_whitespace();
        if c == '#' && preceded_ok {
            if i + 1 < chars.len() && chars[i + 1].is_alphanumeric() {
                let mut j = i + 1;
                while j < chars.len() && is_tag_continue(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect();
                if !tag.is_empty() {
                    out.push(tag);
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

fn is_tag_continue(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '/' || c == '-'
}

fn collect_yaml_tags(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            for piece in s.split(|c: char| c == ',' || c.is_whitespace()) {
                let t = piece.trim().trim_start_matches('#');
                if !t.is_empty() {
                    out.push(t.to_string());
                }
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_yaml_tags(v, out);
            }
        }
        _ => {}
    }
}

fn extract_summary(body: &str) -> String {
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return trimmed.chars().take(200).collect();
    }
    String::new()
}

fn read_prefix(path: &Path, buf: &mut [u8]) -> Result<usize, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut total = 0usize;
    loop {
        let slot = &mut buf[total..];
        if slot.is_empty() {
            break;
        }
        match f.read(slot) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(total)
}

fn walk_md_files(root: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.depth() == 0 {
                return true;
            }
            !(name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == "dist"
                || name == "build")
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let p = e.into_path();
            let ext_ok = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
                .map(|s| matches!(s.as_str(), "md" | "markdown" | "mdown"))
                .unwrap_or(false);
            if ext_ok { Some(p) } else { None }
        })
}

fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

fn tool_list_notes(workspace: &Path, args: &Value) -> Result<Value, String> {
    let folder = args.get("folder").and_then(|v| v.as_str());
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(200) as usize;
    let scan_root = match folder {
        Some(f) if !f.is_empty() => resolve_in_workspace(workspace, f)?,
        _ => workspace.to_path_buf(),
    };
    let mut notes = Vec::new();
    // Bug N: collect YAML front-matter parse errors so the LLM / UI can
    // flag the offending file rather than silently treating its
    // front-matter as null. Previously `unwrap_or(Value::Null)` swallowed
    // unbalanced quotes / tab indent / etc. with no signal, making
    // "why aren't my tags showing up?" reports hard to diagnose.
    let mut frontmatter_errors: Vec<Value> = Vec::new();
    for path in walk_md_files(&scan_root) {
        if notes.len() >= limit {
            break;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        // Read first 8KB for summary / title.
        let mut buf = vec![0u8; 8 * 1024];
        let n = read_prefix(&path, &mut buf).unwrap_or(0);
        let raw = String::from_utf8_lossy(&buf[..n]).to_string();
        let (fm, body) = split_front_matter(&raw);
        let mut fm_error: Option<String> = None;
        let fm_v: Value = match fm {
            Some(s) => match serde_yaml::from_str::<Value>(&s) {
                Ok(v) => v,
                Err(e) => {
                    fm_error = Some(format!("yaml parse: {e}"));
                    Value::Null
                }
            },
            None => Value::Null,
        };
        if let Some(err) = &fm_error {
            frontmatter_errors.push(json!({
                "path": path.to_string_lossy(),
                "error": err,
            }));
        }
        let headings = extract_headings(body);
        let title = match &fm_v {
            Value::Object(map) => map.get("title").and_then(|t| t.as_str()).map(|s| s.to_string()),
            _ => None,
        }
        .or_else(|| headings.first().map(|h| h.text.clone()));
        let summary = extract_summary(body);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut note = json!({
            "path": path.to_string_lossy(),
            "name": name,
            "title": title,
            "mtime": mtime_secs(&path),
            "size": size,
            "summary": summary,
        });
        if let Some(err) = fm_error {
            note["frontmatter_error"] = Value::String(err);
        }
        notes.push(note);
    }
    let count = notes.len();
    let mut out = json!({"notes": notes, "count": count});
    if !frontmatter_errors.is_empty() {
        out["frontmatter_errors"] = Value::Array(frontmatter_errors);
    }
    Ok(out)
}

fn tool_read_note(workspace: &Path, args: &Value) -> Result<Value, String> {
    let path_arg = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("path: required")?;
    let path = resolve_in_workspace(workspace, path_arg)?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let (fm, body) = split_front_matter(&raw);
    // Bug N: surface YAML front-matter parse errors as `frontmatter_error`
    // instead of silently coercing to Null. The note content still loads
    // and downstream fields (tags from body, headings, wikilinks) keep
    // working — but the caller can now SEE that the YAML block is broken.
    let mut fm_error: Option<String> = None;
    let fm_v: Value = match fm {
        Some(s) => match serde_yaml::from_str::<Value>(&s) {
            Ok(v) => v,
            Err(e) => {
                fm_error = Some(format!("yaml parse: {e}"));
                Value::Null
            }
        },
        None => Value::Null,
    };
    let headings = extract_headings(body);
    let mut tags = extract_body_tags(body);
    if let Value::Object(map) = &fm_v {
        if let Some(t) = map.get("tags") {
            collect_yaml_tags(t, &mut tags);
        }
    }
    tags.sort();
    tags.dedup();
    let wikilinks = extract_wikilinks(body);
    let mut out = json!({
        "path": path.to_string_lossy(),
        "content": raw,
        "frontmatter": fm_v,
        "headings": headings,
        "tags": tags,
        "wikilinks": wikilinks,
        "mtime": mtime_secs(&path),
    });
    if let Some(err) = fm_error {
        out["frontmatter_error"] = Value::String(err);
    }
    Ok(out)
}

fn tool_search(workspace: &Path, args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or("query: required")?
        .to_string();
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("literal");
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

    if mode == "regex" {
        // regex-lite already in deps — compile and walk ourselves.
        let re = Regex::new(&query).map_err(|e| format!("bad regex: {e}"))?;
        let mut hits: Vec<Value> = Vec::new();
        for path in walk_md_files(workspace) {
            if hits.len() >= limit {
                break;
            }
            let raw = match fs::read_to_string(&path) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for (i, line) in raw.lines().enumerate() {
                if hits.len() >= limit {
                    break;
                }
                if re.is_match(line) {
                    let snippet: String = line.chars().take(200).collect();
                    hits.push(json!({
                        "file": path.to_string_lossy(),
                        "line": i + 1,
                        "snippet": snippet,
                    }));
                }
            }
        }
        let count = hits.len();
        return Ok(json!({"hits": hits, "count": count}));
    }
    // literal
    let hits = search::search_in_dir_inner(
        workspace.to_string_lossy().to_string(),
        query,
        limit,
    )?;
    let arr: Vec<Value> = hits
        .iter()
        .map(|h| json!({"file": h.file, "line": h.line, "snippet": h.snippet}))
        .collect();
    let count = arr.len();
    Ok(json!({"hits": arr, "count": count}))
}

fn tool_get_backlinks(workspace: &Path, args: &Value) -> Result<Value, String> {
    let needle = args
        .get("note_name")
        .and_then(|v| v.as_str())
        .ok_or("note_name: required")?
        .to_lowercase();
    let mut out: Vec<Value> = Vec::new();
    for path in walk_md_files(workspace) {
        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let (_, body) = split_front_matter(&raw);
        let links = extract_wikilinks(body);
        for link in links {
            if link.target.to_lowercase() == needle {
                let lines: Vec<&str> = raw.lines().collect();
                let i = (link.line as usize).saturating_sub(1);
                let prev = if i > 0 { lines.get(i - 1) } else { None };
                let cur = lines.get(i);
                let next = lines.get(i + 1);
                let context: Vec<String> = [prev, cur, next]
                    .iter()
                    .filter_map(|x| x.map(|s| s.to_string()))
                    .collect();
                let from_name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                out.push(json!({
                    "from_path": path.to_string_lossy(),
                    "from_name": from_name,
                    "line": link.line,
                    "context": context,
                }));
            }
        }
    }
    let count = out.len();
    Ok(json!({"backlinks": out, "count": count}))
}

fn tool_list_tags(workspace: &Path, _args: &Value) -> Result<Value, String> {
    use std::collections::HashMap;
    let mut by_tag: HashMap<String, (u32, Vec<String>)> = HashMap::new();
    // Bug N: aggregate YAML front-matter parse errors so the caller can
    // see which files have broken YAML — those are the ones whose
    // front-matter `tags:` arrays were silently dropped.
    let mut frontmatter_errors: Vec<Value> = Vec::new();
    for path in walk_md_files(workspace) {
        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let (fm, body) = split_front_matter(&raw);
        let fm_v: Value = match fm {
            Some(s) => match serde_yaml::from_str::<Value>(&s) {
                Ok(v) => v,
                Err(e) => {
                    frontmatter_errors.push(json!({
                        "path": path.to_string_lossy(),
                        "error": format!("yaml parse: {e}"),
                    }));
                    Value::Null
                }
            },
            None => Value::Null,
        };
        let mut tags = extract_body_tags(body);
        if let Value::Object(map) = &fm_v {
            if let Some(t) = map.get("tags") {
                collect_yaml_tags(t, &mut tags);
            }
        }
        tags.sort();
        tags.dedup();
        for tag in tags {
            let entry = by_tag.entry(tag).or_insert_with(|| (0, vec![]));
            entry.0 += 1;
            entry.1.push(path.to_string_lossy().to_string());
        }
    }
    let mut out: Vec<Value> = by_tag
        .into_iter()
        .map(|(tag, (count, files))| json!({"tag": tag, "count": count, "files": files}))
        .collect();
    out.sort_by(|a, b| {
        b["count"].as_u64().unwrap_or(0).cmp(&a["count"].as_u64().unwrap_or(0))
    });
    let count = out.len();
    let mut result = json!({"tags": out, "count": count});
    if !frontmatter_errors.is_empty() {
        result["frontmatter_errors"] = Value::Array(frontmatter_errors);
    }
    Ok(result)
}

fn tool_get_outline(workspace: &Path, args: &Value) -> Result<Value, String> {
    let path_arg = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("path: required")?;
    let path = resolve_in_workspace(workspace, path_arg)?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let (_, body) = split_front_matter(&raw);
    let outline = extract_headings(body);
    Ok(json!({"outline": outline}))
}

fn tool_autogit_log(workspace: &Path, args: &Value) -> Result<Value, String> {
    let path_arg = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("path: required")?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as u32;
    let abs = resolve_in_workspace(workspace, path_arg)?;
    let commits = git_history::git_file_history_inner(
        workspace.to_string_lossy().to_string(),
        abs.to_string_lossy().to_string(),
        limit,
    )?;
    // Convert CommitMeta (which has private fields exposed via Serialize) to JSON.
    let arr = serde_json::to_value(&commits).unwrap_or(Value::Array(vec![]));
    let count = commits.len();
    Ok(json!({"commits": arr, "count": count}))
}

fn tool_autogit_diff(workspace: &Path, args: &Value) -> Result<Value, String> {
    let path_arg = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("path: required")?;
    let abs = resolve_in_workspace(workspace, path_arg)?;
    // Default to HEAD when sha is missing — pull from git_workspace_status.
    let sha = match args.get("sha").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => {
            let st = git_history::git_workspace_status_inner(
                workspace.to_string_lossy().to_string(),
            )?;
            st.head_sha.unwrap_or_else(|| "".to_string())
        }
    };
    if sha.is_empty() {
        return Err("no HEAD commit yet".into());
    }
    let diff = git_history::git_file_diff_inner(
        workspace.to_string_lossy().to_string(),
        abs.to_string_lossy().to_string(),
        sha.clone(),
    )?;
    Ok(json!({
        "sha": diff.to_sha,
        "base": diff.from_sha,
        "diff": diff.unified,
        "path": abs.to_string_lossy(),
    }))
}

fn tool_write_note(workspace: &Path, args: &Value) -> Result<Value, String> {
    let path_arg = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("path: required")?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("content: required")?;
    let allow_overwrite = args
        .get("allow_overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let abs = resolve_in_workspace(workspace, path_arg)?;
    if abs.exists() && !allow_overwrite {
        return Err(format!(
            "{} already exists; pass allow_overwrite=true to replace",
            abs.to_string_lossy()
        ));
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    fs::write(&abs, content).map_err(|e| format!("write: {e}"))?;
    Ok(json!({
        "ok": true,
        "bytes_written": content.as_bytes().len(),
        "path": abs.to_string_lossy(),
    }))
}

fn tool_append_to_note(workspace: &Path, args: &Value) -> Result<Value, String> {
    use std::io::Write;
    let path_arg = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("path: required")?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("content: required")?;
    let abs = resolve_in_workspace(workspace, path_arg)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&abs)
        .map_err(|e| format!("open: {e}"))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("append: {e}"))?;
    Ok(json!({
        "ok": true,
        "bytes_written": content.as_bytes().len(),
        "path": abs.to_string_lossy(),
    }))
}

fn tool_read_agent_trace(workspace: &Path, args: &Value) -> Result<Value, String> {
    // P3 will land a richer reader; for now we just parse trace.jsonl
    // line-by-line into JSON values, dropping malformed lines.
    let run_id_raw = args
        .get("run_id")
        .and_then(|v| v.as_str())
        .ok_or("run_id: required")?;
    // SECURITY: refuse anything that isn't the canonical run_id shape —
    // `run_id` is interpolated directly into the filesystem path below, so
    // an unvalidated `../../etc` would walk above `.solomd/agent-runs/`.
    let run_id = validate_run_id(run_id_raw)?;
    let path = workspace
        .join(".solomd")
        .join("agent-runs")
        .join(run_id)
        .join("trace.jsonl");
    if !path.exists() {
        return Err(format!("no trace for run_id: {run_id}"));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read trace: {e}"))?;
    let steps: Vec<Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    Ok(json!({"steps": steps}))
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Single entry point used by `ai_chat`'s tool-call loop. The `app` handle is
/// reserved for future tools that need it (notify the frontend, emit events,
/// etc.); current tools only need the workspace path. We accept it now so
/// `ai_proxy` doesn't have to refactor when those tools arrive.
pub async fn dispatch_tool(
    _app: &AppHandle,
    workspace: &Path,
    tool: &str,
    args: Value,
) -> Result<Value, String> {
    let workspace = workspace.to_path_buf();
    let tool = tool.to_string();
    // Each tool is sync filesystem work — bounce through spawn_blocking so
    // we don't park the streaming Tokio runtime on a slow disk read.
    tauri::async_runtime::spawn_blocking(move || dispatch_tool_inner(&workspace, &tool, args))
        .await
        .map_err(|e| format!("dispatch join: {e}"))?
}

/// Sync dispatch — also the entry P2 recipes use when running outside the
/// Tauri runtime (recipe execution may happen on a tokio task without an
/// AppHandle in scope). Same dispatch table as `dispatch_tool`, just no
/// thread bounce.
pub fn dispatch_tool_inner(workspace: &Path, tool: &str, args: Value) -> Result<Value, String> {
    // Recipe write-cap (v4.0 P2): if a quota is installed for this
    // workspace and we're about to call a write tool, charge it. Refusal
    // bails before any side-effect — the loop sees an Err result and
    // continues with the model's next turn.
    if is_write_tool(tool) {
        charge_write_cap(workspace)?;
    }
    match tool {
        "list_notes" => tool_list_notes(workspace, &args),
        "read_note" => tool_read_note(workspace, &args),
        "search" => tool_search(workspace, &args),
        "get_backlinks" => tool_get_backlinks(workspace, &args),
        "list_tags" => tool_list_tags(workspace, &args),
        "get_outline" => tool_get_outline(workspace, &args),
        "autogit_log" => tool_autogit_log(workspace, &args),
        "autogit_diff" => tool_autogit_diff(workspace, &args),
        "write_note" => tool_write_note(workspace, &args),
        "append_to_note" => tool_append_to_note(workspace, &args),
        "read_agent_trace" => tool_read_agent_trace(workspace, &args),
        other => Err(format!("unknown tool: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — these mirror dispatch_tool 1:1 so the frontend can call
// any tool directly (e.g. for "Run tool" buttons in the panel) without
// going through the chat loop.
// ---------------------------------------------------------------------------

/// Tauri command arg shape mirror — kept for downstream (P3) replay
/// dispatch, which constructs invocations by name.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ToolArgs {
    pub workspace: String,
    pub args: Value,
}

macro_rules! agent_tool_cmd {
    ($name:ident, $tool:literal) => {
        #[tauri::command]
        pub async fn $name(
            app: AppHandle,
            workspace: String,
            args: Value,
        ) -> Result<Value, String> {
            let ws = PathBuf::from(workspace);
            dispatch_tool(&app, &ws, $tool, args).await
        }
    };
}

agent_tool_cmd!(agent_tool_list_notes, "list_notes");
agent_tool_cmd!(agent_tool_read_note, "read_note");
agent_tool_cmd!(agent_tool_search, "search");
agent_tool_cmd!(agent_tool_get_backlinks, "get_backlinks");
agent_tool_cmd!(agent_tool_list_tags, "list_tags");
agent_tool_cmd!(agent_tool_get_outline, "get_outline");
agent_tool_cmd!(agent_tool_autogit_log, "autogit_log");
agent_tool_cmd!(agent_tool_autogit_diff, "autogit_diff");
agent_tool_cmd!(agent_tool_write_note, "write_note");
agent_tool_cmd!(agent_tool_append_to_note, "append_to_note");
agent_tool_cmd!(agent_tool_read_agent_trace, "read_agent_trace");

/// List recent agent runs by reading `<workspace>/.solomd/agent-runs/`.
/// Returns each run's meta.json (sorted by started_at desc). Used by the
/// AI Settings "recent runs" section.
#[tauri::command]
pub async fn agent_list_runs(workspace: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || agent_list_runs_inner(workspace))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn agent_list_runs_inner(workspace: String) -> Result<Vec<Value>, String> {
    let dir = PathBuf::from(&workspace).join(".solomd").join("agent-runs");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<Value> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let meta_path = entry.path().join("meta.json");
        if !meta_path.exists() {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&meta_path) {
            if let Ok(mut v) = serde_json::from_str::<Value>(&raw) {
                if let Value::Object(map) = &mut v {
                    map.insert(
                        "_dir".to_string(),
                        Value::String(entry.path().to_string_lossy().to_string()),
                    );
                    map.insert(
                        "_run_md".to_string(),
                        Value::String(entry.path().join("run.md").to_string_lossy().to_string()),
                    );
                }
                out.push(v);
            }
        }
    }
    // Sort newest first (started_at desc; tie-break on dir name).
    out.sort_by(|a, b| {
        let sa = a.get("started_at").and_then(|v| v.as_u64()).unwrap_or(0);
        let sb = b.get("started_at").and_then(|v| v.as_u64()).unwrap_or(0);
        sb.cmp(&sa)
    });
    // Cap at 100 — these are listed in a tiny settings panel; older runs
    // remain on disk and can still be opened by file path.
    out.truncate(100);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_workspace() -> PathBuf {
        let id = format!("solomd-tools-{}", std::process::id());
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{id}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        // Seed two notes.
        fs::write(
            dir.join("Welcome.md"),
            "---\ntitle: Welcome\ntags: [intro]\n---\n# Welcome\n\nFirst line.\n\n#topic\n\nSee [[Other note]].\n",
        )
        .unwrap();
        fs::create_dir_all(dir.join("daily")).unwrap();
        fs::write(
            dir.join("daily/2026-04-30.md"),
            "# Today\n\nNeedle in a haystack.\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn list_notes_finds_seed_files() {
        let ws = make_workspace();
        let res = tool_list_notes(&ws, &json!({})).unwrap();
        let count = res["count"].as_u64().unwrap();
        assert!(count >= 2, "expected ≥2 notes, got {count}");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn read_note_parses_frontmatter_and_links() {
        let ws = make_workspace();
        let res = tool_read_note(&ws, &json!({"path": "Welcome.md"})).unwrap();
        assert_eq!(res["frontmatter"]["title"], "Welcome");
        let tags = res["tags"].as_array().unwrap();
        let tag_strs: Vec<&str> = tags.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(tag_strs.contains(&"intro"));
        assert!(tag_strs.contains(&"topic"));
        let wikilinks = res["wikilinks"].as_array().unwrap();
        assert_eq!(wikilinks.len(), 1);
        assert_eq!(wikilinks[0]["target"], "Other note");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn search_finds_match() {
        let ws = make_workspace();
        let res = tool_search(&ws, &json!({"query": "Needle"})).unwrap();
        assert!(res["count"].as_u64().unwrap() >= 1);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn write_then_read_roundtrips() {
        let ws = make_workspace();
        let res = tool_write_note(
            &ws,
            &json!({"path": "out/new.md", "content": "# New file"}),
        )
        .unwrap();
        assert_eq!(res["ok"], true);
        let read_back = tool_read_note(&ws, &json!({"path": "out/new.md"})).unwrap();
        assert!(read_back["content"].as_str().unwrap().contains("New file"));

        // Default refuses to clobber.
        let dup = tool_write_note(
            &ws,
            &json!({"path": "out/new.md", "content": "x"}),
        );
        assert!(dup.is_err(), "should not overwrite without allow_overwrite");

        // With allow_overwrite, succeeds.
        let ow = tool_write_note(
            &ws,
            &json!({"path": "out/new.md", "content": "y", "allow_overwrite": true}),
        )
        .unwrap();
        assert_eq!(ow["ok"], true);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn workspace_escape_blocked() {
        let ws = make_workspace();
        let res = tool_read_note(&ws, &json!({"path": "../escape.md"}));
        assert!(res.is_err(), "should refuse traversal");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn list_tags_aggregates() {
        let ws = make_workspace();
        let res = tool_list_tags(&ws, &json!({})).unwrap();
        let tags = res["tags"].as_array().unwrap();
        let names: Vec<&str> = tags.iter().filter_map(|t| t["tag"].as_str()).collect();
        assert!(names.contains(&"intro"));
        assert!(names.contains(&"topic"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn get_outline_parses_headings() {
        let ws = make_workspace();
        let res = tool_get_outline(&ws, &json!({"path": "Welcome.md"})).unwrap();
        let outline = res["outline"].as_array().unwrap();
        assert!(!outline.is_empty());
        assert_eq!(outline[0]["text"], "Welcome");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn descriptors_cover_every_tool() {
        for t in all_tools() {
            assert!(tool_descriptor(t).is_some(), "missing descriptor for {t}");
        }
    }

    // -- Path-safety regression coverage (HIGH-sev fix in resolve_in_workspace) --

    #[test]
    fn resolve_in_workspace_rejects_dotdot_with_nonexistent_parent() {
        // The pre-fix exploit: parent (`../../tmp/pwn`) doesn't exist on
        // disk, so `parent.canonicalize()` failed and the code fell back
        // to the unresolved candidate. `starts_with(workspace)` then
        // trivially passed (the path *lexically* began with workspace),
        // and write_note happily mkdir-p'd /tmp/pwn and wrote there.
        // Post-fix: the `..` component is rejected upfront.
        let ws = make_workspace();
        let res = resolve_in_workspace(&ws, "../../tmp/pwn/x.md");
        assert!(res.is_err(), "must reject `..` even with nonexistent parent");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_in_workspace_rejects_absolute_path() {
        let ws = make_workspace();
        let res = resolve_in_workspace(&ws, "/etc/passwd");
        assert!(res.is_err(), "must reject absolute paths");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_in_workspace_allows_nested_nonexistent_create() {
        // Standard write-path use case: parent doesn't exist yet — the
        // resolver still has to produce a path under the workspace so
        // write_note can mkdir_p + create.
        let ws = make_workspace();
        let res = resolve_in_workspace(&ws, "subdir/new.md").unwrap();
        let ws_canon = ws.canonicalize().unwrap();
        assert!(
            res.starts_with(&ws_canon),
            "{} must live under workspace {}",
            res.display(),
            ws_canon.display()
        );
        assert!(res.ends_with("subdir/new.md"));
        let _ = fs::remove_dir_all(&ws);
    }

    // -- run_id validation (MEDIUM-sev fix in tool_read_agent_trace) --

    #[test]
    fn validate_run_id_rejects_traversal() {
        assert!(validate_run_id("../../etc").is_err());
        assert!(validate_run_id("../foo").is_err());
        assert!(validate_run_id("foo/bar").is_err());
        assert!(validate_run_id("20260502-130000-abc/../bad").is_err());
    }

    #[test]
    fn validate_run_id_accepts_canonical_shape() {
        assert!(validate_run_id("20260502-130000-abc123").is_ok());
        // Single-char hex suffix still ok.
        assert!(validate_run_id("20260101-000000-a").is_ok());
    }
}
