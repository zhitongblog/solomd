//! Global recursive search across a directory tree.
//!
//! Walks `root` (following the caller-controlled path) and returns every line
//! in every text-ish file that contains `query` (case-insensitive substring
//! match), capped at `max_results`. Hidden directories and a small deny-list
//! of heavy build/VCS directories are skipped.
//!
//! This module is intentionally self-contained: register the command from
//! `lib.rs` with `mod search;` and add `search::search_in_dir` to the
//! `invoke_handler!` list.

use serde::{Deserialize, Serialize};
use std::fs;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SearchHit {
    pub file: String,
    pub line: usize,
    pub snippet: String,
}

/// File extensions we are willing to open and scan. Anything else is skipped
/// without even opening the file, so binary assets won't slow the walker.
const ALLOWED_EXT: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];

/// Directory names that should never be descended into. We match by name
/// (not full path), which is enough for the usual suspects.
const SKIP_DIRS: &[&str] = &["node_modules", "target", ".git", "dist"];

#[tauri::command]
pub async fn search_in_dir(
    root: String,
    query: String,
    max_results: usize,
) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_in_dir_inner(root, query, max_results))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn search_in_dir_inner(
    root: String,
    query: String,
    max_results: usize,
) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let needle = query.to_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();

    let walker = WalkDir::new(&root).follow_links(false).into_iter();
    for entry in walker.filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        // Skip dotfiles/dotdirs and the explicit deny-list.
        !name.starts_with('.') && !SKIP_DIRS.iter().any(|d| name == *d)
    }) {
        if hits.len() >= max_results {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase());
        if !ext
            .map(|e| ALLOWED_EXT.contains(&e.as_str()))
            .unwrap_or(false)
        {
            continue;
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if hits.len() >= max_results {
                break;
            }
            if line.to_lowercase().contains(&needle) {
                // Cap snippet length so a single giant line can't blow up the IPC payload.
                let snippet: String = line.chars().take(200).collect();
                hits.push(SearchHit {
                    file: path.to_string_lossy().to_string(),
                    line: i + 1,
                    snippet,
                });
            }
        }
    }

    Ok(hits)
}
