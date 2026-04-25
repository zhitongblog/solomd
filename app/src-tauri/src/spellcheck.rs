//! Spell-check (F2 of v2.0) — pure-Rust Hunspell via the `spellbook` crate.
//!
//! Bundles the `en_US` Hunspell dictionary at
//! `app/src-tauri/resources/dicts/en_US.{aff,dic}` (sourced from
//! https://github.com/wooorm/dictionaries — MIT). At runtime we resolve the
//! files via Tauri's resource path API and load them into a single global
//! `Dictionary` guarded by a `RwLock`.
//!
//! Design choices:
//! * **Latin-only.** We deliberately skip CJK runs (single-char "words" are
//!   not spellable with Hunspell). Words are extracted via the regex
//!   `[A-Za-z][A-Za-z'-]*` so apostrophes (`don't`) and hyphens
//!   (`light-weight`) survive.
//! * **Byte offsets.** All `start`/`end` ranges in `Misspelling` are byte
//!   offsets into the input string — the same coordinate system CodeMirror
//!   uses for `Decoration.mark` ranges, so the frontend can hand them
//!   straight to the editor.
//! * **User dictionary.** Words added via `spellcheck_add_to_dict` are
//!   appended to a plain-text file under the app config dir
//!   (`~/Library/Application Support/<bundle-id>/user-dict-en.txt` on macOS,
//!   etc.). We additionally `Dictionary::add` the word to the in-memory
//!   dictionary so the next `check` call already accepts it.

use once_cell::sync::Lazy;
use regex_lite::Regex;
use serde::Serialize;
use spellbook::Dictionary;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::RwLock;

use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Misspelling {
    pub word: String,
    /// Byte offset of the first byte of the word in the input string.
    pub start: usize,
    /// Byte offset one past the last byte of the word.
    pub end: usize,
}

// ---------------------------------------------------------------------------
// Global state — one dictionary per process, lazily loaded by `_init`.
// ---------------------------------------------------------------------------

struct State {
    dict: Option<Dictionary>,
    /// Path to the user dictionary file we're currently appending to.
    user_dict_path: Option<PathBuf>,
}

static STATE: Lazy<RwLock<State>> = Lazy::new(|| {
    RwLock::new(State {
        dict: None,
        user_dict_path: None,
    })
});

/// Latin word regex shared by `check` and the CM6 plugin (kept in sync with
/// the spec — `[A-Za-z][A-Za-z'-]*`).
static WORD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[A-Za-z][A-Za-z'\-]*").expect("word regex"));

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Loads the bundled `<lang>` dictionary into the global state. v2.0 ships
/// only `en_US`; the `lang` arg is reserved for future expansion (fr, de…).
/// Returns the number of words/stems loaded so the frontend can show a
/// status message (e.g. "Loaded 49,568 words").
#[tauri::command]
pub fn spellcheck_init(app: AppHandle, lang: String) -> Result<usize, String> {
    let lang_norm = normalize_lang(&lang);
    let (aff_path, dic_path) = resolve_dict_paths(&app, &lang_norm)?;

    let aff = fs::read_to_string(&aff_path)
        .map_err(|e| format!("read aff ({}): {}", aff_path.display(), e))?;
    let dic = fs::read_to_string(&dic_path)
        .map_err(|e| format!("read dic ({}): {}", dic_path.display(), e))?;

    let mut dict = Dictionary::new(&aff, &dic).map_err(|e| format!("parse dict: {e}"))?;

    // Determine where the user dict lives and merge it in (best-effort —
    // missing file is not an error).
    let user_path = user_dict_path(&app, &lang_norm)?;
    if user_path.exists() {
        if let Ok(text) = fs::read_to_string(&user_path) {
            for raw in text.lines() {
                let w = raw.trim();
                if w.is_empty() || w.starts_with('#') {
                    continue;
                }
                let _ = dict.add(w);
            }
        }
    }

    // Approximate "word count" from the .dic file's first line (Hunspell
    // convention). This is cheap and "good enough" for a status string.
    let count = dic
        .lines()
        .next()
        .and_then(|l| l.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let mut s = STATE.write().map_err(|e| e.to_string())?;
    s.dict = Some(dict);
    s.user_dict_path = Some(user_path);
    Ok(count)
}

/// Returns every Latin run in `text` that the dictionary rejects. Skips
/// CJK / non-Latin characters by construction (the regex only matches
/// `[A-Za-z]…`).
#[tauri::command]
pub fn spellcheck_check(text: String) -> Result<Vec<Misspelling>, String> {
    let s = STATE.read().map_err(|e| e.to_string())?;
    let dict = match s.dict.as_ref() {
        Some(d) => d,
        // Not initialised yet — return empty rather than erroring so the
        // frontend's debounced loop doesn't spam toasts before init lands.
        None => return Ok(Vec::new()),
    };

    let mut out: Vec<Misspelling> = Vec::new();
    for m in WORD_RE.find_iter(&text) {
        let word = m.as_str();
        // Strip leading / trailing punctuation that the regex allows in the
        // middle (`'-`) but which Hunspell shouldn't see at the edges.
        let trimmed = word.trim_matches(|c: char| c == '\'' || c == '-');
        if trimmed.is_empty() {
            continue;
        }
        // Skip ALL_CAPS acronyms (e.g. "API", "HTTP") and single letters.
        if trimmed.len() <= 1 {
            continue;
        }
        if trimmed.chars().all(|c| c.is_ascii_uppercase()) {
            continue;
        }
        if !dict.check(trimmed) {
            // Use the original (untrimmed) span boundaries so the CM6
            // decoration highlights the whole token the user sees.
            out.push(Misspelling {
                word: word.to_string(),
                start: m.start(),
                end: m.end(),
            });
        }
    }
    Ok(out)
}

/// Returns up to 5 spelling suggestions for `word`, ordered by spellbook's
/// internal ranking.
#[tauri::command]
pub fn spellcheck_suggest(word: String) -> Result<Vec<String>, String> {
    let s = STATE.read().map_err(|e| e.to_string())?;
    let dict = match s.dict.as_ref() {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };
    let mut sugg: Vec<String> = Vec::new();
    dict.suggest(&word, &mut sugg);
    sugg.truncate(5);
    Ok(sugg)
}

/// Appends `word` to the on-disk user dictionary and adds it live to the
/// in-memory `Dictionary` so subsequent `check` calls stop flagging it.
#[tauri::command]
pub fn spellcheck_add_to_dict(word: String) -> Result<(), String> {
    let trimmed = word.trim();
    if trimmed.is_empty() {
        return Err("empty word".into());
    }

    // Live-add (best-effort — if the dict isn't loaded, only the file write
    // will take effect on the next init).
    {
        let mut s = STATE.write().map_err(|e| e.to_string())?;
        if let Some(dict) = s.dict.as_mut() {
            let _ = dict.add(trimmed);
        }
    }

    let path = {
        let s = STATE.read().map_err(|e| e.to_string())?;
        match &s.user_dict_path {
            Some(p) => p.clone(),
            None => return Err("user dict path not set — call spellcheck_init first".into()),
        }
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open user dict: {e}"))?;
    writeln!(f, "{trimmed}").map_err(|e| format!("write user dict: {e}"))?;
    Ok(())
}

/// Returns the current contents of the user dictionary as a `Vec<String>`
/// (one word per entry, comments and blank lines stripped). Useful for the
/// frontend to show "Manage personal dictionary…" UIs later.
#[tauri::command]
pub fn spellcheck_load_user_dict() -> Result<Vec<String>, String> {
    let path = {
        let s = STATE.read().map_err(|e| e.to_string())?;
        match &s.user_dict_path {
            Some(p) => p.clone(),
            None => return Ok(Vec::new()),
        }
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read user dict: {e}"))?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let w = line.trim();
        if w.is_empty() || w.starts_with('#') {
            continue;
        }
        out.push(w.to_string());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn normalize_lang(lang: &str) -> String {
    // Map a few common aliases to our bundled file basenames.
    let l = lang.trim();
    if l.is_empty() {
        return "en_US".to_string();
    }
    match l.to_ascii_lowercase().as_str() {
        "en" | "en-us" | "en_us" | "english" => "en_US".to_string(),
        other => other.to_string(),
    }
}

fn resolve_dict_paths(app: &AppHandle, lang: &str) -> Result<(PathBuf, PathBuf), String> {
    // Tauri's resource resolver looks up files declared under
    // `bundle.resources` in tauri.conf.json. The parent will add
    // `resources/dicts/*` based on SUMMARY.md.
    let aff_rel = format!("resources/dicts/{lang}.aff");
    let dic_rel = format!("resources/dicts/{lang}.dic");

    let aff = app
        .path()
        .resolve(&aff_rel, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve {aff_rel}: {e}"))?;
    let dic = app
        .path()
        .resolve(&dic_rel, tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("resolve {dic_rel}: {e}"))?;

    // In dev (cargo run, no bundling) the resource resolver may point at a
    // path that doesn't exist yet. Fall back to the source-tree location so
    // developers can iterate without bundling first.
    if !aff.exists() || !dic.exists() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let aff_dev = manifest_dir.join(format!("resources/dicts/{lang}.aff"));
        let dic_dev = manifest_dir.join(format!("resources/dicts/{lang}.dic"));
        if aff_dev.exists() && dic_dev.exists() {
            return Ok((aff_dev, dic_dev));
        }
    }

    Ok((aff, dic))
}

fn user_dict_path(app: &AppHandle, lang: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    Ok(dir.join(format!("user-dict-{lang}.txt")))
}
