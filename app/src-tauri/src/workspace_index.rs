//! Workspace index — shared backbone for v2.0 features (F1 wikilinks/
//! backlinks, F3 tags panel, F6 Bases-style properties view).
//!
//! Scans the active workspace folder for `.md`/`.markdown` files, extracts
//! YAML front matter, wikilinks (`[[X]]`), `#tags`, and headings. Holds
//! everything in-memory; persists a JSON cache per workspace at
//! `<app_data_dir>/index/<sha256(folder)>.json` so warm starts are fast.
//!
//! A file watcher (notify) keeps the index live; on debounced changes the
//! affected file is re-scanned and an `solomd://index-updated` event is
//! emitted to the frontend.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, SystemTime};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use regex_lite::Regex;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Public types (match the TS interface in `app/src/lib/workspace-index.ts`).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexEntry {
    /// Absolute filesystem path.
    pub path: String,
    /// File name (without folder), e.g. `Welcome.md`.
    pub name: String,
    /// File name without extension — used as the canonical wikilink target.
    pub stem: String,
    /// Modification time (seconds since UNIX epoch).
    pub mtime: u64,
    /// File size in bytes.
    pub size: u64,
    /// Parsed YAML front matter (empty map if none).
    pub frontmatter: serde_json::Value,
    /// Outbound wikilinks (just the targets, not the alias / heading parts).
    pub wikilinks: Vec<WikilinkRef>,
    /// Tags found in body (`#tag`) and front matter (`tags: [...]`).
    pub tags: Vec<String>,
    /// Headings, e.g. `["Introduction", "Setup"]`.
    pub headings: Vec<String>,
    /// First non-empty body line (front matter stripped), trimmed to 200 chars.
    pub summary: String,
    /// First H1 heading text (used for resolution by-title).
    pub title: Option<String>,
    /// F3 (v4.6) typed relationships: map `frontmatter key → list of canonical
    /// `[[ref]]`s`. Any non-reserved front-matter key whose value contains a
    /// wikilink. Mirrors `app/src/lib/relationships.ts::extractRelationships`.
    /// Defaults to empty for entries deserialized from an older index cache
    /// that predates this field.
    #[serde(default)]
    pub relationships: HashMap<String, Vec<String>>,
}

/// F3 — one inverse (referenced-by) edge resolved over the in-memory index.
#[derive(Debug, Clone, Serialize)]
pub struct ReferencedByRef {
    pub from_path: String,
    pub from_name: String,
    /// The forward-relationship front-matter key on the source note.
    pub via_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikilinkRef {
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    /// 1-based line number where the link appears.
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BacklinkRef {
    pub from_path: String,
    pub from_name: String,
    pub line: u32,
    /// Three-line snippet: prev / matching / next line for context.
    pub context: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
    /// Files (paths) that contain this tag.
    pub files: Vec<String>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct State {
    /// Workspace root currently watched (None until init).
    root: Option<PathBuf>,
    /// path -> entry
    entries: HashMap<PathBuf, IndexEntry>,
    /// notify watcher kept alive while index is active.
    _watcher: Option<RecommendedWatcher>,
}

static STATE: Lazy<RwLock<State>> = Lazy::new(|| {
    RwLock::new(State {
        root: None,
        entries: HashMap::new(),
        _watcher: None,
    })
});

/// Channel used to debounce raw notify events before re-scanning a file.
/// Keep one global for the whole app; a single workspace at a time is fine.
static PENDING: Lazy<Mutex<HashMap<PathBuf, SystemTime>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn workspace_index_init(app: AppHandle, folder: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_index_init_inner(app, folder))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn workspace_index_init_inner(app: AppHandle, folder: String) -> Result<usize, String> {
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err(format!("not a directory: {folder}"));
    }

    // Reset state.
    {
        let mut s = STATE.write().map_err(|e| e.to_string())?;
        s.entries.clear();
        s.root = Some(root.clone());
        s._watcher = None;
    }

    // Try cache first (fast warm start). If cache is missing or stale per-file
    // mtimes are checked anyway during the rescan loop below, so no separate
    // freshness logic needed here.
    if let Some(cached) = load_cache(&app, &root) {
        let mut s = STATE.write().map_err(|e| e.to_string())?;
        for entry in cached {
            s.entries.insert(PathBuf::from(&entry.path), entry);
        }
    }

    // Full scan (this also corrects any drift from cache).
    scan_into(&root)?;

    // Set up watcher.
    let app_for_watch = app.clone();
    let watcher = make_watcher(app_for_watch, root.clone())?;
    {
        let mut s = STATE.write().map_err(|e| e.to_string())?;
        s._watcher = Some(watcher);
    }

    let count = STATE.read().map_err(|e| e.to_string())?.entries.len();
    save_cache(&app, &root)?;
    let _ = app.emit("solomd://index-updated", &"init");
    Ok(count)
}

#[tauri::command]
pub fn workspace_index_files() -> Result<Vec<IndexEntry>, String> {
    let s = STATE.read().map_err(|e| e.to_string())?;
    let mut v: Vec<IndexEntry> = s.entries.values().cloned().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(v)
}

#[tauri::command]
pub fn workspace_index_backlinks(target: String) -> Result<Vec<BacklinkRef>, String> {
    let s = STATE.read().map_err(|e| e.to_string())?;
    let target_lc = target.to_lowercase();
    let mut out: Vec<BacklinkRef> = Vec::new();
    for entry in s.entries.values() {
        for link in &entry.wikilinks {
            if link.target.to_lowercase() == target_lc {
                let context = read_context(&PathBuf::from(&entry.path), link.line);
                out.push(BacklinkRef {
                    from_path: entry.path.clone(),
                    from_name: entry.name.clone(),
                    line: link.line,
                    context,
                });
            }
        }
    }
    out.sort_by(|a, b| a.from_name.cmp(&b.from_name));
    Ok(out)
}

/// F3 — inverse relationships: notes whose front matter has a typed
/// relationship key pointing at `target`. Resolution mirrors
/// `workspace_index_resolve`'s precedence (stem → title → alias →
/// path-suffix), case-insensitive; the source note is self-excluded.
#[tauri::command]
pub fn workspace_index_referenced_by(target: String) -> Result<Vec<ReferencedByRef>, String> {
    let s = STATE.read().map_err(|e| e.to_string())?;
    let needle = target.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    // Resolve which entry `target` names (so refs by title/alias/stem all
    // collapse to one path). First-match wins, mirroring resolve precedence.
    let resolved_path: Option<String> = {
        let by_stem = s
            .entries
            .values()
            .find(|e| e.stem.to_lowercase() == needle);
        let by_title = || {
            s.entries.values().find(|e| {
                e.title
                    .as_ref()
                    .map(|t| t.to_lowercase() == needle)
                    .unwrap_or(false)
            })
        };
        let by_alias = || {
            s.entries.values().find(|e| {
                if let serde_json::Value::Object(map) = &e.frontmatter {
                    if let Some(a) = map.get("aliases").or_else(|| map.get("alias")) {
                        let mut names = Vec::new();
                        collect_alias_names(a, &mut names);
                        return names.iter().any(|n| n.to_lowercase() == needle);
                    }
                }
                false
            })
        };
        by_stem
            .or_else(by_title)
            .or_else(by_alias)
            .map(|e| e.path.clone())
    };

    let mut out: Vec<ReferencedByRef> = Vec::new();
    for entry in s.entries.values() {
        for (via_key, refs) in &entry.relationships {
            for reference in refs {
                let ref_target = parse_ref_target(reference).to_lowercase();
                // A ref matches if it names this target directly (stem/title/
                // alias) — compare to both the literal needle AND the resolved
                // entry's stem so e.g. `[[The Title]]` resolves to the file.
                let matches_needle = ref_target == needle;
                let matches_resolved = match &resolved_path {
                    Some(p) => s
                        .entries
                        .get(&PathBuf::from(p))
                        .map(|te| te.stem.to_lowercase() == ref_target)
                        .unwrap_or(false),
                    None => false,
                };
                if !(matches_needle || matches_resolved) {
                    continue;
                }
                // Self-exclusion: a note referencing itself isn't an inverse.
                if let Some(p) = &resolved_path {
                    if &entry.path == p {
                        continue;
                    }
                }
                out.push(ReferencedByRef {
                    from_path: entry.path.clone(),
                    from_name: entry.name.clone(),
                    via_key: via_key.clone(),
                });
            }
        }
    }
    out.sort_by(|a, b| {
        a.via_key
            .cmp(&b.via_key)
            .then_with(|| a.from_name.cmp(&b.from_name))
    });
    out.dedup_by(|a, b| a.from_path == b.from_path && a.via_key == b.via_key);
    Ok(out)
}

/// Collect alias names from a front-matter `aliases` value (string or array).
fn collect_alias_names(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.push(s.trim().to_string()),
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_alias_names(v, out);
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub fn workspace_index_tags() -> Result<Vec<TagCount>, String> {
    let s = STATE.read().map_err(|e| e.to_string())?;
    let mut by_tag: HashMap<String, (u32, Vec<String>)> = HashMap::new();
    for entry in s.entries.values() {
        let mut seen_in_file: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for tag in &entry.tags {
            if seen_in_file.insert(tag) {
                let e = by_tag.entry(tag.clone()).or_insert_with(|| (0, vec![]));
                e.0 += 1;
                e.1.push(entry.path.clone());
            }
        }
    }
    let mut out: Vec<TagCount> = by_tag
        .into_iter()
        .map(|(tag, (count, files))| TagCount { tag, count, files })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
    Ok(out)
}

#[tauri::command]
pub fn workspace_index_resolve(name: String) -> Result<Option<String>, String> {
    let s = STATE.read().map_err(|e| e.to_string())?;
    let needle = name.trim();
    if needle.is_empty() {
        return Ok(None);
    }
    let needle_lc = needle.to_lowercase();
    // 1. Exact stem match (case-insensitive)
    for entry in s.entries.values() {
        if entry.stem.to_lowercase() == needle_lc {
            return Ok(Some(entry.path.clone()));
        }
    }
    // 2. Title (H1) match
    for entry in s.entries.values() {
        if entry
            .title
            .as_ref()
            .map(|t| t.to_lowercase() == needle_lc)
            .unwrap_or(false)
        {
            return Ok(Some(entry.path.clone()));
        }
    }
    // 3. Substring match in stem
    for entry in s.entries.values() {
        if entry.stem.to_lowercase().contains(&needle_lc) {
            return Ok(Some(entry.path.clone()));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn workspace_index_rescan(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_index_rescan_inner(app))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn workspace_index_rescan_inner(app: AppHandle) -> Result<usize, String> {
    let root = {
        let s = STATE.read().map_err(|e| e.to_string())?;
        match &s.root {
            Some(r) => r.clone(),
            None => return Err("workspace not initialized".into()),
        }
    };
    {
        let mut s = STATE.write().map_err(|e| e.to_string())?;
        s.entries.clear();
    }
    scan_into(&root)?;
    save_cache(&app, &root)?;
    let _ = app.emit("solomd://index-updated", &"rescan");
    let count = STATE.read().map_err(|e| e.to_string())?.entries.len();
    Ok(count)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn scan_into(root: &Path) -> Result<(), String> {
    let mut new_entries: HashMap<PathBuf, IndexEntry> = HashMap::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let lower = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if lower != "md" && lower != "markdown" && lower != "mdown" {
            continue;
        }
        if let Ok(idx) = scan_file(path) {
            new_entries.insert(path.to_path_buf(), idx);
        }
    }
    let mut s = STATE.write().map_err(|e| e.to_string())?;
    s.entries = new_entries;
    Ok(())
}

fn scan_file(path: &Path) -> Result<IndexEntry, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    let (frontmatter, body) = split_front_matter(&raw);
    let frontmatter_json: serde_json::Value = match frontmatter {
        Some(fm) => serde_yaml::from_str::<serde_json::Value>(&fm).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    };

    let wikilinks = extract_wikilinks(body);
    let mut tags = extract_body_tags(body);
    if let serde_json::Value::Object(map) = &frontmatter_json {
        if let Some(t) = map.get("tags") {
            collect_yaml_tags(t, &mut tags);
        }
    }
    tags.sort();
    tags.dedup();

    let headings = extract_headings(body);
    let title = extract_title(&frontmatter_json, &headings);
    let summary = extract_summary(body);
    let relationships = extract_relationships(&frontmatter_json);

    Ok(IndexEntry {
        path: path.to_string_lossy().to_string(),
        name,
        stem,
        mtime,
        size: meta.len(),
        frontmatter: frontmatter_json,
        wikilinks,
        tags,
        headings,
        summary,
        title,
        relationships,
    })
}

// ---------------------------------------------------------------------------
// F3 — typed relationships extraction (mirrors lib/relationships.ts).
// ---------------------------------------------------------------------------

/// Front-matter keys that are structural and never count as a typed
/// relationship even if they contain a wikilink. Must stay byte-for-byte in
/// sync with `RESERVED_RELATIONSHIP_KEYS` in `app/src/lib/relationships.ts`.
/// `_`-prefixed keys are also reserved (handled in `is_reserved_key`).
const RESERVED_RELATIONSHIP_KEYS: &[&str] = &[
    "title",
    "aliases",
    "alias",
    "tags",
    "tag",
    "status",
    "date",
    "created",
    "modified",
    "updated",
    "icon",
    "color",
    "colour",
    "cssclass",
    "cssclasses",
    "publish",
    "permalink",
    "inbox",
];

fn is_reserved_key(key: &str) -> bool {
    let k = key.trim();
    if k.is_empty() || k.starts_with('_') {
        return true;
    }
    let lc = k.to_lowercase();
    RESERVED_RELATIONSHIP_KEYS.iter().any(|r| *r == lc)
}

/// Collect every wikilink in `text`, returning each in canonical `[[target]]`
/// form (alias / heading stripped). Mirrors the regex used by
/// `extract_wikilinks`.
fn refs_in_str(text: &str, out: &mut Vec<String>) {
    static RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"\[\[([^\[\]\n]+?)\]\]").expect("wikilink regex"));
    for cap in RE.captures_iter(text) {
        let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let target_raw = match inner.split_once('|') {
            Some((t, _)) => t.trim().to_string(),
            None => inner.trim().to_string(),
        };
        let target = match target_raw.split_once('#') {
            Some((t, _)) => t.trim().to_string(),
            None => target_raw,
        };
        if !target.is_empty() {
            out.push(format!("[[{target}]]"));
        }
    }
}

/// Recurse into a front-matter value collecting wikilink refs (string scalars
/// and arrays of strings, at any depth).
fn collect_refs(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => refs_in_str(s, out),
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_refs(v, out);
            }
        }
        _ => {}
    }
}

/// Extract typed relationships from parsed front matter: every non-reserved
/// key whose value contains at least one wikilink, mapped to its canonical
/// `[[ref]]` list. Mirrors `extractRelationships` in `lib/relationships.ts`.
fn extract_relationships(fm: &serde_json::Value) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    if let serde_json::Value::Object(map) = fm {
        for (key, value) in map {
            if is_reserved_key(key) {
                continue;
            }
            let mut refs = Vec::new();
            collect_refs(value, &mut refs);
            if !refs.is_empty() {
                out.insert(key.clone(), refs);
            }
        }
    }
    out
}

/// Strip `[[ ]]` (and any `#heading` / `|alias`) from a ref, returning the
/// bare target stem.
fn parse_ref_target(reference: &str) -> String {
    let mut v = Vec::new();
    refs_in_str(reference, &mut v);
    if let Some(first) = v.first() {
        // first is `[[target]]`
        return first
            .trim_start_matches("[[")
            .trim_end_matches("]]")
            .to_string();
    }
    reference.trim().to_string()
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
        let rest_offset_in_after = end + "\n---".len();
        // skip past the closing line break
        let rest = &after_first[rest_offset_in_after..];
        let rest = rest.strip_prefix('\n').unwrap_or(rest);
        return (Some(yaml.to_string()), rest);
    }
    (None, raw)
}

fn extract_wikilinks(body: &str) -> Vec<WikilinkRef> {
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"\[\[([^\[\]\n]+?)\]\]").expect("wikilink regex")
    });
    let mut out = Vec::new();
    for (line_idx, line) in body.lines().enumerate() {
        for cap in RE.captures_iter(line) {
            let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            // Form: target[#heading][|alias]
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
    // Hand-rolled scanner — `regex-lite` does NOT support Unicode classes
    // (`\p{L}` / `\p{N}`), and trying to compile such a pattern panics at
    // runtime. We use `char::is_alphanumeric` which IS Unicode-aware.
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
        // Strip inline code spans (cheap pass) before scanning.
        let stripped = strip_inline_code(line);
        scan_tags_in_line(&stripped, &mut out);
    }
    out
}

fn scan_tags_in_line(line: &str, out: &mut Vec<String>) {
    let bytes = line.as_bytes();
    let mut chars = line.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c != '#' {
            continue;
        }
        // `#` must be at start of line OR preceded by whitespace.
        if i > 0 {
            let prev = bytes[i - 1];
            if !(prev as char).is_whitespace() {
                continue;
            }
        }
        // First char of tag must be alphanumeric (Unicode-aware).
        let mut tag = String::new();
        // Peek next char.
        let first = match chars.peek() {
            Some(&(_, ch)) if ch.is_alphanumeric() => ch,
            _ => continue,
        };
        chars.next();
        tag.push(first);
        // Subsequent chars: alphanumeric or `_` `/` `-`.
        while let Some(&(_, ch)) = chars.peek() {
            if ch.is_alphanumeric() || ch == '_' || ch == '/' || ch == '-' {
                tag.push(ch);
                chars.next();
            } else {
                break;
            }
        }
        if !tag.is_empty() {
            // a) Tag must be followed by whitespace or end-of-line — otherwise
            //    it is likely a CSS property value (e.g. `#488878;`).
            if let Some(&(_, ch)) = chars.peek() {
                if !ch.is_whitespace() {
                    continue;
                }
            }
            // b) 6-char pure hex string → almost certainly a colour code.
            if tag.len() == 6 && tag.chars().all(|c| c.is_ascii_hexdigit()) {
                continue;
            }
            // c) In table rows, skip purely numeric "tags" — they are rankings
            //    (#1, #2, #3) or issue/row numbers (#12, #26), not real tags.
            if tag.chars().all(|c| c.is_ascii_digit()) && line.trim_start().starts_with('|') {
                continue;
            }
            out.push(tag);
        }
    }
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

fn collect_yaml_tags(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => {
            for piece in s.split(|c: char| c == ',' || c.is_whitespace()) {
                let t = piece.trim().trim_start_matches('#');
                if !t.is_empty() {
                    out.push(t.to_string());
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                collect_yaml_tags(v, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_inline_code_basic() {
        let stripped = strip_inline_code("purple bg `#1A1033` + text `#9B7EE0`");
        assert!(!stripped.contains('#'), "inline code should be stripped: {:?}", stripped);
    }

    #[test]
    fn test_body_tags_skip_inline_code() {
        let body = "- Active item: purple bg `#1A1033` + text `#9B7EE0` + fontWeight 600\n- Inactive: no fill + text `#94A3B8`\n- Sub-item: padding `[8,12,8,40]`, fontSize 13\n\n#real-tag";
        let tags = extract_body_tags(body);
        assert!(tags.contains(&"real-tag".to_string()), "should find #real-tag");
        assert!(!tags.iter().any(|t| t.contains("9B7EE0")), "should NOT pick up hex color from inline code");
        assert!(!tags.iter().any(|t| t.contains("1A1033")), "should NOT pick up hex color from inline code");
        assert!(!tags.iter().any(|t| t.contains("94A3B8")), "should NOT pick up hex color from inline code");
    }

    #[test]
    fn test_table_backtick_hex_colors() {
        // Exact user-reported lines with backtick-enclosed hex colors in table cells
        let lines = [
            "| `#ffffff` | `#111B27` | Card bg |",
            "| `#f1f5f9` | `#1E293B` | Gray bg / status |",
            "| `#e2e8f0` | `#1E293B` | Dividers |",
        ];
        for line in &lines {
            let stripped = strip_inline_code(line);
            // After stripping inline code, no `#` should remain
            assert!(
                !stripped.contains('#'),
                "strip_inline_code should remove # from backtick content in: {:?} → {:?}",
                line, stripped
            );
        }
        // Full extraction should find zero tags
        let body = lines.join("\n");
        let tags = extract_body_tags(&body);
        assert!(
            tags.is_empty(),
            "backtick-enclosed hex colors should NOT be tags, found: {:?}",
            tags
        );
    }

    #[test]
    fn test_table_no_backtick_hex_colors() {
        // Same content WITHOUT backticks — hex filter should catch them
        let lines = [
            "| #ffffff | #111B27 | Card bg |",
            "| #f1f5f9 | #1E293B | Gray bg / status |",
            "| #e2e8f0 | #1E293B | Dividers |",
        ];
        let body = lines.join("\n");
        let tags = extract_body_tags(&body);
        assert!(
            tags.is_empty(),
            "hex colors without backticks should be filtered by hex check, found: {:?}",
            tags
        );
    }

    #[test]
    fn test_link_anchor_not_tag() {
        // Markdown link: (#12-tab-可见性规则) — # is preceded by '(' not whitespace
        let line = "12. [Tab 可见性规则](#12-tab-可见性规则)";
        let mut tags = vec![];
        scan_tags_in_line(line, &mut tags);
        assert!(
            tags.is_empty(),
            "link anchor #12 should NOT be a tag, found: {:?}",
            tags
        );
    }

    #[test]
    fn hex_colors_not_tags() {
        let mut tags = vec![];
        // CSS-like contexts — semicolons / non-space after hex → filtered by boundary
        scan_tags_in_line("color: #488878;", &mut tags);
        scan_tags_in_line("bg: #9B7EE0 solid", &mut tags);
        // Valid tags (non-table lines — numeric tags OK)
        scan_tags_in_line("see #TaskOn here", &mut tags);
        scan_tags_in_line("ref #1 and #12 ok", &mut tags);
        assert_eq!(tags, vec!["TaskOn", "1", "12"]);
    }

    #[test]
    fn table_numeric_not_tags() {
        // Rankings and issue numbers in table rows should be excluded
        let mut tags = vec![];
        scan_tags_in_line("| P67 | #1 DeFi_Whale 12,800pts, #2 CryptoKing |", &mut tags);
        scan_tags_in_line("| #1 (center) | highest | amber |", &mut tags);
        scan_tags_in_line("| #26 Community Wizard preview |", &mut tags);
        // Non-table numeric tags still valid
        scan_tags_in_line("see #12 here", &mut tags);
        assert_eq!(tags, vec!["12"]);
    }

    #[test]
    fn hex_colors_in_table_not_tags() {
        // Exact user-reported line: hex colors in markdown table cells, no backticks
        let line = "| Theme | Dark (#0A0F1A bg, #111B27 cards) |";
        let mut tags = vec![];
        scan_tags_in_line(line, &mut tags);
        assert!(
            tags.is_empty(),
            "hex colors in table should NOT be tags, but found: {:?}",
            tags
        );
    }

    #[test]
    fn test_body_tags_skip_table_inline_code() {
        let body = "\
| 属性 | 值 |
|------|-----|
| 页面背景 | `#0A0F1A` (深色) |
| Header 背景 | `#0F172A` |
| 卡片背景 | `#111B27` |
| 边框 | `#1E293B` |
| Primary 强调色 | `#F59E0B` (amber) |
| 主文本 | `#F1F5F9` |
| 次级文本 | `#94A3B8` |
| 按钮主色 | `#F59E0B` fill, `#000000` text |
| 状态绿 | `#48BB78` (completed/claimed) |
| 状态灰 | `#64748B` (locked/disabled) |
";
        let tags = extract_body_tags(body);
        let hex_tags: Vec<&String> = tags.iter().filter(|t| t.chars().all(|c| c.is_ascii_hexdigit())).collect();
        assert!(
            hex_tags.is_empty(),
            "hex color codes inside backticks should NOT be tags, but found: {:?}",
            hex_tags
        );
    }

    // -----------------------------------------------------------------------
    // F3 — typed relationships extraction (mirrors lib/relationships.ts).
    // -----------------------------------------------------------------------

    fn fm(yaml: &str) -> serde_json::Value {
        serde_yaml::from_str::<serde_json::Value>(yaml).unwrap_or(serde_json::Value::Null)
    }

    #[test]
    fn relationships_scalar_and_array() {
        let v = fm("belongs_to: \"[[b]]\"\ncites:\n  - \"[[a]]\"\n  - \"[[c]]\"");
        let rel = extract_relationships(&v);
        assert_eq!(rel.get("belongs_to").unwrap(), &vec!["[[b]]".to_string()]);
        assert_eq!(
            rel.get("cites").unwrap(),
            &vec!["[[a]]".to_string(), "[[c]]".to_string()]
        );
    }

    #[test]
    fn relationships_arbitrary_custom_key() {
        let v = fm("author: \"[[jane]]\"");
        let rel = extract_relationships(&v);
        assert_eq!(rel.get("author").unwrap(), &vec!["[[jane]]".to_string()]);
    }

    #[test]
    fn relationships_reserved_keys_excluded() {
        let v = fm("title: \"[[x]]\"\ntags:\n  - \"[[y]]\"\nrelated_to: \"[[z]]\"");
        let rel = extract_relationships(&v);
        assert!(!rel.contains_key("title"));
        assert!(!rel.contains_key("tags"));
        assert_eq!(rel.get("related_to").unwrap(), &vec!["[[z]]".to_string()]);
    }

    #[test]
    fn relationships_underscore_prefixed_excluded() {
        let v = fm("_internal: \"[[a]]\"\ncites: \"[[b]]\"");
        let rel = extract_relationships(&v);
        assert!(!rel.contains_key("_internal"));
        assert!(rel.contains_key("cites"));
    }

    #[test]
    fn relationships_non_wikilink_ignored() {
        let v = fm("status: draft\ncount: 3\nbelongs_to: \"[[b]]\"");
        let rel = extract_relationships(&v);
        assert_eq!(rel.len(), 1);
        assert!(rel.contains_key("belongs_to"));
    }

    #[test]
    fn relationships_alias_heading_collapse() {
        let v = fm("ref: \"[[Paper A|the paper]]\"\nsee: \"[[Doc#Heading]]\"");
        let rel = extract_relationships(&v);
        assert_eq!(rel.get("ref").unwrap(), &vec!["[[Paper A]]".to_string()]);
        assert_eq!(rel.get("see").unwrap(), &vec!["[[Doc]]".to_string()]);
    }

    #[test]
    fn is_reserved_key_matches_ts_set() {
        assert!(is_reserved_key("_foo"));
        assert!(is_reserved_key("Title"));
        assert!(is_reserved_key("CSSClass"));
        assert!(!is_reserved_key("belongs_to"));
        assert!(!is_reserved_key("cites"));
    }

    #[test]
    fn parse_ref_target_strips_brackets() {
        assert_eq!(parse_ref_target("[[b]]"), "b");
        assert_eq!(parse_ref_target("[[a|alias]]"), "a");
        assert_eq!(parse_ref_target("[[a#h]]"), "a");
        assert_eq!(parse_ref_target("plain"), "plain");
    }

    /// Build a synthetic index in STATE and assert referenced_by resolves the
    /// inverse edges (stem + self-exclusion). Uses the real STATE lock so the
    /// command path is exercised end-to-end.
    #[test]
    fn referenced_by_resolves_inverse_with_self_exclusion() {
        fn entry(stem: &str, fm_yaml: &str) -> IndexEntry {
            let fmv = fm(fm_yaml);
            IndexEntry {
                path: format!("/{stem}.md"),
                name: format!("{stem}.md"),
                stem: stem.to_string(),
                mtime: 0,
                size: 0,
                relationships: extract_relationships(&fmv),
                frontmatter: fmv,
                wikilinks: vec![],
                tags: vec![],
                headings: vec![],
                summary: String::new(),
                title: None,
            }
        }
        {
            let mut s = STATE.write().unwrap();
            s.entries.clear();
            for e in [
                entry("a", "belongs_to: \"[[b]]\"\ncites: \"[[c]]\"\nself: \"[[a]]\""),
                entry("b", ""),
                entry("c", ""),
            ] {
                s.entries.insert(PathBuf::from(&e.path), e);
            }
        }

        let b_inv = workspace_index_referenced_by("b".into()).unwrap();
        assert_eq!(b_inv.len(), 1);
        assert_eq!(b_inv[0].from_path, "/a.md");
        assert_eq!(b_inv[0].via_key, "belongs_to");

        let c_inv = workspace_index_referenced_by("c".into()).unwrap();
        assert_eq!(c_inv.len(), 1);
        assert_eq!(c_inv[0].via_key, "cites");

        // a.md's self-reference must NOT show up as an inverse on a.md.
        let a_inv = workspace_index_referenced_by("a".into()).unwrap();
        assert!(a_inv.is_empty(), "self-reference must be excluded: {a_inv:?}");

        // --- Second scenario (same test fn so the two never race over the
        // shared STATE lock, which cargo would otherwise run in parallel) ---
        fn entry_titled(stem: &str, title: Option<&str>, fm_yaml: &str) -> IndexEntry {
            let fmv = fm(fm_yaml);
            IndexEntry {
                path: format!("/{stem}.md"),
                name: format!("{stem}.md"),
                stem: stem.to_string(),
                mtime: 0,
                size: 0,
                relationships: extract_relationships(&fmv),
                frontmatter: fmv,
                wikilinks: vec![],
                tags: vec![],
                headings: vec![],
                summary: String::new(),
                title: title.map(|s| s.to_string()),
            }
        }
        {
            let mut s = STATE.write().unwrap();
            s.entries.clear();
            for e in [
                entry_titled("a", None, "related_to: \"[[The Topic]]\""),
                entry_titled("t", Some("The Topic"), ""),
            ] {
                s.entries.insert(PathBuf::from(&e.path), e);
            }
        }
        let t_inv = workspace_index_referenced_by("The Topic".into()).unwrap();
        assert_eq!(t_inv.len(), 1, "title resolution: {t_inv:?}");
        assert_eq!(t_inv[0].from_path, "/a.md");
        assert_eq!(t_inv[0].via_key, "related_to");

        // Cleanup so we don't leak state into other tests.
        STATE.write().unwrap().entries.clear();
    }
}

fn extract_headings(body: &str) -> Vec<String> {
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*$").expect("heading regex"));
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
        if let Some(cap) = RE.captures(line) {
            if let Some(m) = cap.get(2) {
                out.push(m.as_str().trim().to_string());
            }
        }
    }
    out
}

fn extract_title(fm: &serde_json::Value, headings: &[String]) -> Option<String> {
    if let serde_json::Value::Object(map) = fm {
        if let Some(serde_json::Value::String(t)) = map.get("title") {
            let trimmed = t.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    headings.first().cloned()
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
        let cleaned: String = trimmed
            .chars()
            .take(200)
            .collect();
        return cleaned;
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

fn make_watcher(app: AppHandle, root: PathBuf) -> Result<RecommendedWatcher, String> {
    let app_for_handler = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            handle_event(&app_for_handler, ev);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(watcher)
}

fn handle_event(app: &AppHandle, event: Event) {
    let interesting = matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    );
    if !interesting {
        return;
    }
    let now = SystemTime::now();
    let mut to_rescan: Vec<PathBuf> = Vec::new();
    {
        let mut pending = match PENDING.lock() {
            Ok(p) => p,
            Err(_) => return,
        };
        for path in event.paths {
            let lower = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            if lower != "md" && lower != "markdown" && lower != "mdown" {
                continue;
            }
            pending.insert(path.clone(), now);
            to_rescan.push(path);
        }
    }
    if to_rescan.is_empty() {
        return;
    }
    // Debounce: run rescan in a separate thread after 200ms of quiet.
    let app_for_thread = app.clone();
    let paths = to_rescan.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let now2 = SystemTime::now();
        let still_pending: Vec<PathBuf> = {
            let pending = match PENDING.lock() {
                Ok(p) => p,
                Err(_) => return,
            };
            paths
                .into_iter()
                .filter(|p| {
                    pending
                        .get(p)
                        .map(|t| now2.duration_since(*t).map(|d| d.as_millis() >= 180).unwrap_or(true))
                        .unwrap_or(false)
                })
                .collect()
        };
        if still_pending.is_empty() {
            return;
        }
        let mut changed = false;
        for path in &still_pending {
            if path.is_file() {
                if let Ok(idx) = scan_file(path) {
                    if let Ok(mut s) = STATE.write() {
                        s.entries.insert(path.clone(), idx);
                        changed = true;
                    }
                }
            } else {
                // Removed
                if let Ok(mut s) = STATE.write() {
                    if s.entries.remove(path).is_some() {
                        changed = true;
                    }
                }
            }
        }
        if let Ok(mut pending) = PENDING.lock() {
            for p in &still_pending {
                pending.remove(p);
            }
        }
        if changed {
            // Persist + notify. IMPORTANT: don't hold STATE.read() across
            // save_cache(), which itself acquires STATE.read() — recursive
            // reads on std::sync::RwLock can deadlock on macOS when a
            // writer is queued in between. Clone `root` out, drop the
            // guard, then call save_cache.
            let root = STATE.read().ok().and_then(|s| s.root.clone());
            if let Some(root) = root {
                let _ = save_cache(&app_for_thread, &root);
            }
            let _ = app_for_thread.emit("solomd://index-updated", &"watch");
        }
    });
}

// ---------------------------------------------------------------------------
// Cache (JSON on disk per workspace)
// ---------------------------------------------------------------------------

fn cache_path(app: &AppHandle, root: &Path) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let dir = app_data.join("index");
    let _ = fs::create_dir_all(&dir);
    Some(dir.join(format!("{}.json", &hash[..16])))
}

fn save_cache(app: &AppHandle, root: &Path) -> Result<(), String> {
    let path = match cache_path(app, root) {
        Some(p) => p,
        None => return Ok(()),
    };
    let s = STATE.read().map_err(|e| e.to_string())?;
    let entries: Vec<&IndexEntry> = s.entries.values().collect();
    let json = serde_json::to_vec_pretty(&entries).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_cache(app: &AppHandle, root: &Path) -> Option<Vec<IndexEntry>> {
    let path = cache_path(app, root)?;
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

// Helper for backlink context.
fn read_context(path: &Path, line_no: u32) -> Vec<String> {
    let raw = match fs::read_to_string(path) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let lines: Vec<&str> = raw.lines().collect();
    let i = (line_no as usize).saturating_sub(1);
    let prev = if i > 0 { lines.get(i - 1) } else { None };
    let cur = lines.get(i);
    let next = lines.get(i + 1);
    [prev, cur, next]
        .iter()
        .filter_map(|x| x.map(|s| s.to_string()))
        .collect()
}
