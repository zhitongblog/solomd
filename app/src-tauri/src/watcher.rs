use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE_MS: u64 = 300;
const SELF_WRITE_SUPPRESSION_MS: u64 = 500;
/// v2.6 — `crypto_decrypt_after_pull` rewrites every encrypted file in
/// the workspace in one batch. Per-file `mark_self_write` would race
/// the notify debouncer (the writes finish before the marks land), so
/// expose a coarser "this whole subtree is about to change" window.
const SYNC_REWRITE_WINDOW_MS: u64 = 30_000;

/// Global self-write timestamps, shared between write_file and the watcher callback.
static SELF_WRITES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

/// `(workspace_root_canonical → expires_at)` — while wall-clock is below
/// `expires_at`, any change under that root is treated as a self-write.
static SYNC_REWRITE_WINDOWS: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

fn self_writes() -> &'static Mutex<HashMap<String, Instant>> {
    SELF_WRITES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sync_windows() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    SYNC_REWRITE_WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Called by write_file after a successful save to suppress the watcher event.
///
/// Opportunistically purges entries older than `SELF_WRITE_SUPPRESSION_MS`
/// so the map can't grow without bound on a long-running session — after
/// the suppression window expires the entry is dead weight either way.
pub fn mark_self_write(path: &str) {
    let mut map = self_writes().lock().unwrap();
    let cutoff = Duration::from_millis(SELF_WRITE_SUPPRESSION_MS);
    map.retain(|_, t| t.elapsed() < cutoff);
    map.insert(path.to_string(), Instant::now());
}

/// v2.6 — call before a batch operation that legitimately rewrites many
/// files in `workspace` (a successful GitHub pull, a `crypto_decrypt_after_pull`
/// run). Suppresses the file-watcher's "external change" dialog for
/// `SYNC_REWRITE_WINDOW_MS`. Same opportunistic cleanup as
/// `mark_self_write` — removes any expired windows before inserting.
pub fn mark_workspace_rewrite_window(workspace: &std::path::Path) {
    let canonical = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    let mut map = sync_windows().lock().unwrap();
    let now = Instant::now();
    map.retain(|_, expires| *expires >= now);
    map.insert(canonical, now + Duration::from_millis(SYNC_REWRITE_WINDOW_MS));
}

fn within_sync_rewrite_window(canonical_path: &std::path::Path) -> bool {
    let map = sync_windows().lock().unwrap();
    let now = Instant::now();
    map.iter().any(|(root, expires)| {
        *expires >= now && canonical_path.starts_with(root)
    })
}

type WatchedSet = Arc<Mutex<HashSet<PathBuf>>>;

pub struct WatcherState {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    watched: WatchedSet,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            debouncer: Mutex::new(None),
            watched: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

fn ensure_watcher(app: &AppHandle, state: &WatcherState) {
    let mut guard = state.debouncer.lock().unwrap();
    if guard.is_some() {
        return;
    }

    let app_handle = app.clone();
    let watched = state.watched.clone();

    let debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |result: notify_debouncer_mini::DebounceEventResult| {
        let Ok(events) = result else { return };
        for event in events {
            let canonical: PathBuf = match std::fs::canonicalize(&event.path) {
                Ok(p) => p,
                Err(_) => continue,
            };

            if !watched.lock().unwrap().contains(&canonical) {
                continue;
            }

            let path_str = canonical.to_string_lossy().to_string();
            let suppressed = self_writes()
                .lock()
                .unwrap()
                .get(&path_str)
                .map_or(false, |t| {
                    t.elapsed().as_millis() < SELF_WRITE_SUPPRESSION_MS as u128
                });

            if suppressed {
                continue;
            }

            if within_sync_rewrite_window(&canonical) {
                continue;
            }

            let _ = app_handle.emit("solomd://file-changed", path_str);
        }
    });

    if let Ok(d) = debouncer {
        *guard = Some(d);
    }
}

#[tauri::command]
pub fn watch_file(
    app: AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;

    {
        let mut watched = state.watched.lock().unwrap();
        if watched.contains(&canonical) {
            return Ok(());
        }
        watched.insert(canonical.clone());
    }

    ensure_watcher(&app, &state);

    let mut guard = state.debouncer.lock().unwrap();
    if let Some(ref mut debouncer) = *guard {
        debouncer
            .watcher()
            .watch(&canonical, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch failed: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn unwatch_file(
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;

    {
        let mut watched = state.watched.lock().unwrap();
        watched.remove(&canonical);
    }

    let mut guard = state.debouncer.lock().unwrap();
    if let Some(ref mut debouncer) = *guard {
        let _ = debouncer.watcher().unwatch(&canonical);
    }

    Ok(())
}
