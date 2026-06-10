use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileReadResult {
    pub content: String,
    pub encoding: String,
    pub language: String,
    pub had_bom: bool,
}

/// Read a file from disk, auto-detecting its text encoding (UTF-8/16, GBK, etc.)
/// and returning UTF-8 content along with the original encoding label so we can
/// re-save in the same encoding later.
///
/// Async wrapper to keep file I/O off the IPC thread — see the audit note in
/// `feedback_tauri_sync_command_audit.md`. The inner is exposed for tests.
#[tauri::command]
pub async fn read_file(path: String) -> Result<FileReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_inner(path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn read_file_inner(path: String) -> Result<FileReadResult, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read failed: {e}"))?;

    // Try BOM first.
    let (encoding, had_bom, body) = if let Some((enc, bom_len)) = sniff_bom(&bytes) {
        (enc, true, &bytes[bom_len..])
    } else {
        // chardetng for everything else.
        let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
        detector.feed(&bytes, true);
        let enc = detector.guess(None, Utf8Detection::Allow);
        (enc, false, bytes.as_slice())
    };

    let (cow, _used_enc, had_errors) = encoding.decode_without_bom_handling_and_without_replacement(body)
        .map(|c| (c, encoding, false))
        .unwrap_or_else(|| {
            let (c, used, errs) = encoding.decode(body);
            (c, used, errs)
        });

    if had_errors {
        // Fall back to lossy UTF-8 so the user sees something rather than an error.
        let lossy = String::from_utf8_lossy(body).into_owned();
        return Ok(FileReadResult {
            content: lossy,
            encoding: encoding.name().to_string(),
            language: detect_language(&path),
            had_bom,
        });
    }

    Ok(FileReadResult {
        content: cow.into_owned(),
        encoding: encoding.name().to_string(),
        language: detect_language(&path),
        had_bom,
    })
}

/// Write a UTF-8 string back to disk in the requested encoding.
/// `encoding` should be a label like "UTF-8", "GBK", "UTF-16LE".
///
/// v4.0 Pillar 2 — also fires the `on-save` / `on-tag-add` recipe
/// triggers if the saved file lives inside the active workspace. The
/// dispatch is async + best-effort so a save never blocks on a recipe.
/// `workspace` is optional; when absent, no recipe dispatch happens
/// (this keeps callers that save scratch files outside any workspace
/// from accidentally triggering recipes against the wrong vault).
#[tauri::command]
pub async fn write_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
    encoding: String,
    workspace: Option<String>,
) -> Result<(), String> {
    let path_for_dispatch = path.clone();
    let content_for_dispatch = content.clone();
    tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        let content = content.clone();
        move || write_file_inner(path, content, encoding)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    // After a successful save, fire the on-save / on-tag-add triggers
    // for the active workspace. We re-extract tags from the *content*
    // we just wrote (rather than re-reading from disk) so the trigger
    // sees the same bytes the user just saved.
    #[cfg(not(target_os = "android"))]
    if let Some(ws) = workspace {
        let ws_path = std::path::PathBuf::from(&ws);
        let new_tags = extract_tags_for_dispatch(&content_for_dispatch);
        // Detached — we don't want the save IPC call to wait on a
        // recipe firing.
        tauri::async_runtime::spawn(async move {
            super::recipe_runner::dispatch_on_save(app, ws_path, path_for_dispatch, new_tags).await;
        });
    }
    #[cfg(target_os = "android")]
    {
        let _ = (workspace, content_for_dispatch, path_for_dispatch, app);
    }

    Ok(())
}

/// Quick-and-dirty tag extraction used by the on-tag-add trigger. We
/// reuse the same scanner shape as `mcp-server/src/workspace.rs` —
/// duplicated here because P4 (Federation) hasn't merged yet and we
/// don't want to depend on the mcp-server crate from inside the Tauri
/// app. After P4 lands, swap this for the canonical helper.
///
/// Android disables the recipe-runner / on-save trigger surface (AutoGit
/// and the whole desktop-class workflow), so this helper is unused on
/// that target. cfg-gating the definition silences the dead_code
/// warning that started showing up after v4.0 Android port landed.
#[cfg(not(target_os = "android"))]
fn extract_tags_for_dispatch(body: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let preceded_ok = i == 0 || chars[i - 1].is_whitespace();
            if c == '#' && preceded_ok {
                if i + 1 < chars.len() && chars[i + 1].is_alphanumeric() {
                    let mut j = i + 1;
                    while j < chars.len()
                        && (chars[j].is_alphanumeric()
                            || chars[j] == '_'
                            || chars[j] == '/'
                            || chars[j] == '-')
                    {
                        j += 1;
                    }
                    tags.push(chars[i + 1..j].iter().collect());
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
    tags.sort();
    tags.dedup();
    tags
}

pub fn write_file_inner(path: String, content: String, encoding: String) -> Result<(), String> {
    let enc = Encoding::for_label(encoding.as_bytes()).unwrap_or(UTF_8);
    let (cow, _, had_errors) = enc.encode(&content);
    if had_errors {
        return Err(format!(
            "Some characters cannot be represented in {}",
            enc.name()
        ));
    }
    fs::write(&path, cow.as_ref()).map_err(|e| format!("write failed: {e}"))?;

    super::watcher::mark_self_write(&path);

    Ok(())
}

/// Read raw bytes from disk. v3.5: counterpart to `write_binary_file` —
/// the export pipeline (PDF / DOCX / PNG) needs to embed local images
/// into the output document, which means it has to read those image
/// bytes regardless of the webview's CSP. Returns a `Vec<u8>`; on the
/// JS side this lands as `number[]` so the caller can construct a Blob
/// or base64-encode for the renderer. Async + spawn_blocking like its
/// siblings so a slow disk doesn't queue parallel IPC calls.
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::read(&path).map_err(|e| format!("read failed: {e}"))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Write raw bytes to disk. Used for binary export targets like DOCX/PDF.
#[tauri::command]
pub async fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_binary_file_inner(path, data))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn write_binary_file_inner(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir failed: {e}"))?;
        }
    }
    fs::write(&path, &data).map_err(|e| format!("write failed: {e}"))
}

/// Trigger the OS native print dialog for the given webview window. The
/// frontend should first mount a print-friendly overlay so only the rendered
/// markdown (not the editor UI) is included in the print.
///
/// Why here instead of `window.print()` in JS? WKWebView on macOS silently
/// no-ops `window.print()`, so the native call is the only way.
///
/// iOS / Android: `WebviewWindow::print()` doesn't exist on mobile in Tauri 2
/// (no system print dialog), so we expose a no-op there to keep `tauri::generate_handler!`
/// happy. The JS side never invokes this on mobile anyway — Print is gated behind
/// the macOS / Windows / Linux toolbar entry.
#[cfg(desktop)]
#[tauri::command]
pub fn print_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| format!("print failed: {e}"))
}

#[cfg(mobile)]
#[tauri::command]
pub fn print_webview(_window: tauri::WebviewWindow) -> Result<(), String> {
    Err("print is not available on mobile".to_string())
}

/// Copy a file from `src` to `dst`, creating parent dirs as needed.
/// Used by image drag-drop to bring an OS file into the document's
/// `_assets/` folder without round-tripping bytes through JavaScript.
#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_file_inner(src, dst))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn copy_file_inner(src: String, dst: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&dst).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir failed: {e}"))?;
        }
    }
    fs::copy(&src, &dst).map_err(|e| format!("copy failed: {e}"))?;
    Ok(())
}

/// v3.0 file-tree edit ops — backing the New File / New Folder / Rename /
/// Delete buttons in the left sidebar. Refuse to clobber existing files
/// so the UI can show "already exists" without us silently overwriting.
#[tauri::command]
pub fn fs_create_file(path: String, content: Option<String>) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("already exists: {path}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
        }
    }
    fs::write(p, content.unwrap_or_default().as_bytes())
        .map_err(|e| format!("create failed: {e}"))
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("already exists: {path}"));
    }
    fs::create_dir_all(p).map_err(|e| format!("mkdir failed: {e}"))
}

#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(()); // idempotent — already gone is fine
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("delete dir failed: {e}"))
    } else {
        fs::remove_file(p).map_err(|e| format!("delete file failed: {e}"))
    }
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    let from_p = Path::new(&from);
    let to_p = Path::new(&to);
    if !from_p.exists() {
        return Err(format!("source missing: {from}"));
    }
    if to_p.exists() {
        return Err(format!("target already exists: {to}"));
    }

    // v4.3.5 — per-file `.assets/` follow-along. If a sibling directory
    // named `<from-stem>.assets/` exists next to the file we're renaming,
    // move it alongside so the per-file attachment layout survives the
    // rename. `_assets/` (the shared mode) is deliberately untouched —
    // it's shared across every md in that directory.
    //
    // We compute the assets-rename target up front, attempt the primary
    // rename first, then the assets rename, then the link rewrite.
    // Any step beyond the primary that fails is logged but non-fatal:
    // the user's file rename succeeded; we don't want to revert it just
    // because the assets folder rename hit a permission edge case.
    let from_assets = sibling_assets_dir(from_p);
    let to_assets = sibling_assets_dir(to_p);
    let stems_differ = from_assets
        .as_ref()
        .zip(to_assets.as_ref())
        .map(|(a, b)| {
            a.file_name() != b.file_name()
        })
        .unwrap_or(false);

    fs::rename(from_p, to_p).map_err(|e| format!("rename failed: {e}"))?;

    if let (Some(fa), Some(ta)) = (from_assets, to_assets) {
        if fa.is_dir() && !ta.exists() {
            if let Err(e) = fs::rename(&fa, &ta) {
                eprintln!("[fs_rename] assets folder rename failed: {e}");
            } else if stems_differ && is_markdown_path(to_p) {
                // Stem changed → relative refs inside the body now point at
                // a folder that no longer exists. Rewrite them in place.
                if let Err(e) = rewrite_assets_refs(to_p, &fa, &ta) {
                    eprintln!("[fs_rename] body rewrite failed: {e}");
                }
            }
        }
    }
    Ok(())
}

/// Given a path like `/a/b/foo.md`, return `/a/b/foo.assets`. Returns None
/// if the path has no stem (e.g. `/`, an empty string).
fn sibling_assets_dir(p: &Path) -> Option<std::path::PathBuf> {
    let stem = p.file_stem()?.to_string_lossy().to_string();
    if stem.is_empty() {
        return None;
    }
    let parent = p.parent()?;
    Some(parent.join(format!("{stem}.assets")))
}

fn is_markdown_path(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("md") | Some("markdown") | Some("mdown") | Some("mkd")
    )
}

/// Rewrite `<old_stem>.assets/` references inside the file body to
/// `<new_stem>.assets/`. Reads as UTF-8 (which markdown effectively is for
/// our purposes — link paths are always ASCII-safe), does a literal
/// substring replace, and writes back. Best-effort: if the file isn't
/// readable as UTF-8 or has no matches, the original bytes are preserved.
fn rewrite_assets_refs(file: &Path, old_assets: &Path, new_assets: &Path) -> Result<(), String> {
    let old_name = old_assets
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "old assets name missing".to_string())?;
    let new_name = new_assets
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "new assets name missing".to_string())?;
    let bytes = fs::read(file).map_err(|e| format!("read for rewrite: {e}"))?;
    let body = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(_) => return Ok(()), // non-UTF-8 body, skip rewrite
    };
    // Match the assets folder followed by `/` so we don't accidentally
    // rewrite occurrences inside prose (`foo.assets` mentioned in text).
    let old_pat = format!("{old_name}/");
    let new_pat = format!("{new_name}/");
    if !body.contains(&old_pat) {
        return Ok(());
    }
    let rewritten = body.replace(&old_pat, &new_pat);
    fs::write(file, rewritten).map_err(|e| format!("write back: {e}"))
}

fn sniff_bom(bytes: &[u8]) -> Option<(&'static Encoding, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some((encoding_rs::UTF_8, 3))
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some((encoding_rs::UTF_16LE, 2))
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some((encoding_rs::UTF_16BE, 2))
    } else {
        None
    }
}

fn detect_language(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => "markdown".to_string(),
        _ => "plaintext".to_string(),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List immediate children of a directory. Hidden entries (starting with `.`)
/// are filtered out. Sorted: dirs first, then files, both alphabetical.
///
/// Whether each child is a directory comes from `e.file_type()`, NOT
/// `e.metadata()`. On Windows the difference is enormous: `file_type()`
/// uses the cached info from the directory scan (one bulk
/// `FindFirstFile`/`FindNextFile` traversal), while `metadata()` triggers
/// a separate `GetFileInformationByHandle` syscall **per entry**. On a
/// folder with a few thousand notes that's the difference between
/// "instant" and "10 seconds with the antivirus also doing on-access
/// scanning". Reported by user 2026-04-26 as "Win 下打开一个文件比较多
/// 的目录还是有些卡顿".
pub fn list_dir_inner(path: String) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("read_dir failed: {e}"))?;
    const HARD_CAP: usize = 10_000;
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;
    for e in read.flatten() {
        if entries.len() >= HARD_CAP {
            truncated = true;
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // file_type() uses the dir-scan's cached entry type — no extra
        // syscall. metadata() on Windows would re-stat each entry. Falls
        // back gracefully for symlinks/reparse points whose type can't
        // be determined cheaply: skip them rather than block.
        let is_dir = match e.file_type() {
            Ok(t) => t.is_dir(),
            Err(_) => continue,
        };
        entries.push(DirEntry {
            name,
            path: e.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    if truncated {
        // Surface truncation as a sentinel last entry so the UI can show
        // a "+N more, refine your folder layout" hint without needing a
        // second IPC call. The frontend filters this entry by its
        // distinctive name + is_dir=false signature.
        entries.push(DirEntry {
            name: "__solomd_truncated__".into(),
            path: String::new(),
            is_dir: false,
        });
    }
    Ok(entries)
}

/// Async wrapper. `fs::read_dir` + per-entry `metadata()` can take seconds on
/// Windows (network drives, OneDrive placeholders, antivirus scanning) and
/// the previous *synchronous* `#[tauri::command]` blocked the main thread —
/// long enough for Win11 to flag the app as unresponsive and kill it
/// (reproduced as "toggle file tree → app crashes" on Win11). Same fix as
/// git_history: hand off to the blocking pool.
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_inner(path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

// ---------------------------------------------------------------------------
// Frontmatter property editing (v4.6 F1 — Properties inspector).
//
// The YAML frontmatter block at the top of a note is the ONLY source of truth
// for the Properties inspector. These two commands perform a *surgical* edit:
// they parse the `---`…`---` block into an order-preserving `serde_yaml`
// `Mapping`, mutate exactly one key (preserving the order of all other keys
// and the existing key's position on update), then re-emit only the
// frontmatter block. The note BODY (everything after the closing `---`) is
// preserved byte-for-byte by slicing it out before the edit and re-appending
// it verbatim — never re-serialized — so `---` rules, code fences, trailing
// whitespace etc. are untouched and git diffs stay minimal.
//
// `serde_yaml::Mapping` is backed by an insertion-ordered map, so iterating /
// re-emitting keeps the author's key order. New keys are appended at the end.
// ---------------------------------------------------------------------------

/// Detected frontmatter layout of a file. `body` is the verbatim slice that
/// must be preserved unchanged; `map` is the parsed mapping (empty if there
/// was no frontmatter block).
struct SplitFm {
    /// Parsed mapping (insertion-ordered). Empty mapping if no FM block.
    map: serde_yaml::Mapping,
    /// `true` when the source actually had a `---`…`---` block.
    had_block: bool,
    /// Everything after the frontmatter block, byte-for-byte (includes the
    /// blank line(s) that followed the closing `---`). When there was no FM
    /// block this is the entire original file.
    body: String,
}

/// Split a raw file into (parsed frontmatter mapping, verbatim body).
///
/// Recognizes a frontmatter block only when the file *starts* with a line that
/// is exactly `---` and a later line that is exactly `---` or `...` closes it.
/// Anything else is treated as a file with no frontmatter (the whole content
/// is the body).
fn split_frontmatter(raw: &str) -> Result<SplitFm, String> {
    let starts = raw.starts_with("---\n") || raw.starts_with("---\r\n");
    if !starts {
        return Ok(SplitFm {
            map: serde_yaml::Mapping::new(),
            had_block: false,
            body: raw.to_string(),
        });
    }
    let after_open_idx = if raw.starts_with("---\r\n") { 5 } else { 4 };
    let rest = &raw[after_open_idx..];
    // Locate a line that is exactly `---` or `...`.
    let mut offset = 0usize; // byte offset into `rest`
    let mut close_start: Option<usize> = None;
    let mut close_len = 0usize;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" || trimmed == "..." {
            close_start = Some(offset);
            close_len = line.len();
            break;
        }
        offset += line.len();
    }
    let close_start = match close_start {
        Some(c) => c,
        // Unterminated frontmatter → treat the whole file as body (don't
        // destroy content we can't safely parse).
        None => {
            return Ok(SplitFm {
                map: serde_yaml::Mapping::new(),
                had_block: false,
                body: raw.to_string(),
            })
        }
    };
    let yaml_src = &rest[..close_start];
    let body = &rest[close_start + close_len..];

    let map: serde_yaml::Mapping = if yaml_src.trim().is_empty() {
        serde_yaml::Mapping::new()
    } else {
        match serde_yaml::from_str::<serde_yaml::Value>(yaml_src) {
            Ok(serde_yaml::Value::Mapping(m)) => m,
            // Non-mapping or null frontmatter: keep an empty mapping but still
            // treat the block as present so we rewrite cleanly.
            Ok(_) => serde_yaml::Mapping::new(),
            Err(e) => return Err(format!("invalid frontmatter YAML: {e}")),
        }
    };

    Ok(SplitFm {
        map,
        had_block: true,
        body: body.to_string(),
    })
}

/// Re-emit a file from a (possibly mutated) frontmatter mapping + verbatim body.
///
/// - If `map` is empty we drop the frontmatter block entirely (deleting the
///   last key leaves just the body).
/// - When the map is non-empty we serialize it with `serde_yaml` (which emits
///   in insertion order) and wrap it in `---`…`---`.
/// - A note with NO prior frontmatter that gains its first key gets a block
///   synthesized at the very top, ahead of any leading `# H1`, with a single
///   blank line separating it from the body.
fn rebuild_file(split: &SplitFm) -> Result<String, String> {
    if split.map.is_empty() {
        // Deleting the last key (or an empty block): drop the frontmatter
        // entirely, leaving just the verbatim body.
        return Ok(split.body.clone());
    }

    let yaml = serde_yaml::to_string(&serde_yaml::Value::Mapping(split.map.clone()))
        .map_err(|e| format!("serialize frontmatter: {e}"))?;
    // `serde_yaml::to_string` ends with a single trailing newline already.
    let yaml = yaml.trim_end_matches('\n');

    let mut out = String::with_capacity(yaml.len() + split.body.len() + 16);
    out.push_str("---\n");
    out.push_str(yaml);
    out.push_str("\n---\n");

    if split.had_block {
        // Preserve the original body bytes exactly.
        out.push_str(&split.body);
    } else {
        // Synthesizing a brand-new block at the top of a note that had none.
        // The closing `---\n` already terminates the block's line, so the body
        // follows directly — no extra blank line is inserted (that would push a
        // spurious empty line ahead of a leading `# H1`). Any leading newlines
        // the original body carried are trimmed so we don't double them.
        if !split.body.is_empty() {
            out.push_str(split.body.trim_start_matches('\n'));
        }
    }
    Ok(out)
}

/// Convert an incoming JSON value (from the JS side, where typing survives) to
/// a YAML value so quoting/typing is decided by serde_yaml's emitter:
/// numbers stay bare, booleans stay bare, strings get quoted only if needed,
/// arrays become sequences per serde_yaml defaults.
fn json_to_yaml(v: &serde_json::Value) -> serde_yaml::Value {
    match v {
        serde_json::Value::Null => serde_yaml::Value::Null,
        serde_json::Value::Bool(b) => serde_yaml::Value::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_yaml::Value::Number(i.into())
            } else if let Some(u) = n.as_u64() {
                serde_yaml::Value::Number(u.into())
            } else if let Some(f) = n.as_f64() {
                serde_yaml::Value::Number(f.into())
            } else {
                serde_yaml::Value::String(n.to_string())
            }
        }
        serde_json::Value::String(s) => serde_yaml::Value::String(s.clone()),
        serde_json::Value::Array(a) => {
            serde_yaml::Value::Sequence(a.iter().map(json_to_yaml).collect())
        }
        serde_json::Value::Object(o) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, val) in o {
                m.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(val));
            }
            serde_yaml::Value::Mapping(m)
        }
    }
}

/// Set (insert or update) a single frontmatter key, preserving key order and
/// the verbatim body. Returns the full rewritten file content. Pure function
/// over strings so it's unit-testable without Tauri/IO — see
/// `tests/frontmatter_edit_test.rs`.
pub fn set_frontmatter_property_str(
    raw: &str,
    key: &str,
    value: &serde_json::Value,
) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("frontmatter key must not be empty".into());
    }
    let mut split = split_frontmatter(raw)?;
    let yk = serde_yaml::Value::String(key.to_string());
    let yv = json_to_yaml(value);
    // `Mapping::insert` updates in place when the key exists (keeping its
    // position) and appends at the end otherwise — exactly the semantics we
    // want for stable diffs.
    split.map.insert(yk, yv);
    rebuild_file(&split)
}

/// Delete a single frontmatter key, preserving the order of the rest and the
/// verbatim body. A missing key just leaves the map untouched. Returns the
/// full rewritten file content.
pub fn delete_frontmatter_property_str(raw: &str, key: &str) -> Result<String, String> {
    let mut split = split_frontmatter(raw)?;
    let yk = serde_yaml::Value::String(key.to_string());
    split.map.remove(&yk);
    rebuild_file(&split)
}

/// Tauri command: surgically set a frontmatter property on `path` and persist
/// it to disk, returning the rewritten file content so the caller can reflow
/// the open editor without a re-read. Body bytes + key order are preserved.
#[tauri::command]
pub async fn update_frontmatter_property(
    path: String,
    key: String,
    value: serde_json::Value,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let next = set_frontmatter_property_str(&raw, &key, &value)?;
        fs::write(&path, &next).map_err(|e| e.to_string())?;
        Ok(next)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Tauri command: surgically delete a frontmatter property on `path` and
/// persist it, returning the rewritten file content. Body bytes + key order
/// of the remaining keys are preserved.
#[tauri::command]
pub async fn delete_frontmatter_property(
    path: String,
    key: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let next = delete_frontmatter_property_str(&raw, &key)?;
        fs::write(&path, &next).map_err(|e| e.to_string())?;
        Ok(next)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
