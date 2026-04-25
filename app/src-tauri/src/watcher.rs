use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE_MS: u64 = 300;
const SELF_WRITE_SUPPRESSION_MS: u64 = 500;

/// Global self-write timestamps, shared between write_file and the watcher callback.
static SELF_WRITES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn self_writes() -> &'static Mutex<HashMap<String, Instant>> {
    SELF_WRITES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Called by write_file after a successful save to suppress the watcher event.
pub fn mark_self_write(path: &str) {
    self_writes()
        .lock()
        .unwrap()
        .insert(path.to_string(), Instant::now());
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
