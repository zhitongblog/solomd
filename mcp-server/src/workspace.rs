//! Workspace scanning + Markdown parsing.
//!
//! Ported from `app/src-tauri/src/workspace_index.rs`. The Tauri-specific bits
//! (AppHandle, notify watcher, on-disk JSON cache, `tauri::command`) are
//! removed — an MCP server is short-lived and stateless per invocation. We
//! walk the workspace lazily and only read file *content* in `read_note`.

use once_cell::sync::Lazy;
use regex_lite::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Lightweight metadata for `list_notes`.
#[derive(Debug, Clone, Serialize)]
pub struct NoteMeta {
    pub path: String,
    pub name: String,
    pub title: Option<String>,
    pub mtime: u64,
    pub size: u64,
    pub summary: String,
}

/// Full parsed view of a note (`read_note`).
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    pub path: String,
    pub content: String,
    pub frontmatter: serde_json::Value,
    pub headings: Vec<HeadingRef>,
    pub tags: Vec<String>,
    pub wikilinks: Vec<WikilinkRef>,
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WikilinkRef {
    pub target: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeadingRef {
    pub level: u32,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BacklinkRef {
    pub from_path: String,
    pub from_name: String,
    pub line: u32,
    pub context: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
    pub files: Vec<String>,
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/// Iterate every `.md` / `.markdown` / `.mdown` file under `root`.
/// Skips `.git`, `node_modules`, `.solomd` and other hidden dirs.
pub fn walk_markdown_files(root: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // Allow the root itself.
            if e.depth() == 0 {
                return true;
            }
            // Skip hidden + a few well-known noisy dirs.
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

// ---------------------------------------------------------------------------
// Per-file parsing
// ---------------------------------------------------------------------------

/// Cheap metadata-only scan: reads only enough of the file to extract a
/// summary + title (first ~8KB).
pub fn scan_meta(path: &Path) -> Result<NoteMeta, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Read up to 8KB for summary/title — avoids slurping huge files.
    let mut buf = vec![0u8; 8 * 1024];
    let n = read_prefix(path, &mut buf)?;
    let raw = String::from_utf8_lossy(&buf[..n]).to_string();

    let (frontmatter, body) = split_front_matter(&raw);
    let frontmatter_json: serde_json::Value = match frontmatter {
        Some(fm) => serde_yaml::from_str::<serde_json::Value>(&fm).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    };
    let headings = extract_headings(body);
    let title = extract_title(&frontmatter_json, &headings);
    let summary = extract_summary(body);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    Ok(NoteMeta {
        path: path.to_string_lossy().to_string(),
        name,
        title: title.map(|h| h.text),
        mtime,
        size: meta.len(),
        summary,
    })
}

fn read_prefix(path: &Path, buf: &mut [u8]) -> Result<usize, String> {
    use std::io::Read;
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

/// Full parse — reads the entire file.
pub fn read_full(path: &Path) -> Result<Note, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

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

    Ok(Note {
        path: path.to_string_lossy().to_string(),
        content: raw,
        frontmatter: frontmatter_json,
        headings,
        tags,
        wikilinks,
        mtime,
    })
}

// ---------------------------------------------------------------------------
// Markdown parsing primitives (mirror of workspace_index.rs)
// ---------------------------------------------------------------------------

pub fn split_front_matter(raw: &str) -> (Option<String>, &str) {
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

pub fn extract_wikilinks(body: &str) -> Vec<WikilinkRef> {
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

pub fn extract_body_tags(body: &str) -> Vec<String> {
    // Hand-rolled scanner — matches `#tag`, `#nested/tag` with Unicode letters
    // and digits. (regex-lite doesn't support \p{L}/\p{N}.) Preceding char
    // must be start-of-line or whitespace.
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

fn scan_tags_in_line(line: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // `#` must be at start or preceded by whitespace.
        let preceded_ok = i == 0 || chars[i - 1].is_whitespace();
        if c == '#' && preceded_ok {
            // First tag character must be alphanumeric (letter or digit).
            if i + 1 < chars.len() && is_tag_first(chars[i + 1]) {
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

fn is_tag_first(c: char) -> bool {
    c.is_alphanumeric()
}

fn is_tag_continue(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '/' || c == '-'
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

pub fn collect_yaml_tags(value: &serde_json::Value, out: &mut Vec<String>) {
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

pub fn extract_headings(body: &str) -> Vec<HeadingRef> {
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

pub fn extract_title(fm: &serde_json::Value, headings: &[HeadingRef]) -> Option<HeadingRef> {
    if let serde_json::Value::Object(map) = fm {
        if let Some(serde_json::Value::String(t)) = map.get("title") {
            let trimmed = t.trim().to_string();
            if !trimmed.is_empty() {
                return Some(HeadingRef {
                    level: 1,
                    text: trimmed,
                    line: 0,
                });
            }
        }
    }
    headings.first().cloned()
}

pub fn extract_summary(body: &str) -> String {
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

/// Read the line at `line_no` plus its neighbours (3-line window).
pub fn read_context(path: &Path, line_no: u32) -> Vec<String> {
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
