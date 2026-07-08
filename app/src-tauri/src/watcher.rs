use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use std::collections::HashMap;
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

/// v4.2 — switched from per-file watching to per-directory watching to
/// survive atomic-save patterns (write-temp + rename-into-place, used by
/// VSCode / TextEdit / Vim / git checkout). When `notify` watches a file
/// directly, the watch handle binds to the inode; an atomic rename swaps
/// the inode out from under it and the handle goes deaf forever.
///
/// `watched_files` is the filter applied inside the event callback —
/// only events whose canonical path is in this set get emitted.
/// `watched_dirs` ref-counts how many tracked files live in each dir,
/// so we can unwatch the dir cleanly when the last file is closed.
struct WatcherInner {
    /// canonical path → original path string passed to `watch_file`.
    ///
    /// We emit the **original** path back to JS, not the canonical one.
    /// macOS resolves `/tmp/x` → `/private/tmp/x`; if we emitted the
    /// canonical form, the JS-side `tab.filePath` (the user-supplied
    /// path) would never match the event payload and the reload would
    /// silently no-op. Same kind of mismatch happens with symlinked
    /// workspace dirs (e.g. `~/Documents` → `~/Library/Mobile Documents/...`).
    watched_files: HashMap<PathBuf, String>,
    /// canonical parent dir → refcount of watched files under it
    watched_dirs: HashMap<PathBuf, usize>,
}

pub struct WatcherState {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    inner: Arc<Mutex<WatcherInner>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            debouncer: Mutex::new(None),
            inner: Arc::new(Mutex::new(WatcherInner {
                watched_files: HashMap::new(),
                watched_dirs: HashMap::new(),
            })),
        }
    }
}

fn ensure_watcher(app: &AppHandle, state: &WatcherState) {
    let mut guard = state.debouncer.lock().unwrap();
    if guard.is_some() {
        return;
    }

    let app_handle = app.clone();
    let inner = state.inner.clone();

    let debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |result: notify_debouncer_mini::DebounceEventResult| {
        let Ok(events) = result else { return };
        for event in events {
            // Try to canonicalize the event path. After atomic save the
            // path still exists but the inode has changed; canonicalize
            // should still resolve. If the file was deleted entirely,
            // canonicalize fails — fall back to the raw event path so
            // we can still notify the JS side (which will surface a
            // "file deleted externally" dialog via the failed re-read).
            let canonical: PathBuf = std::fs::canonicalize(&event.path)
                .unwrap_or_else(|_| event.path.clone());

            // Watching the parent dir means we see events for siblings
            // too — filter to just the files the UI cares about. Look
            // up the original user-supplied path while we hold the lock
            // so the emit downstream uses the form the JS side stored.
            let original_path = {
                let g = inner.lock().unwrap();
                match g.watched_files.get(&canonical) {
                    Some(p) => p.clone(),
                    None => continue,
                }
            };

            let canonical_str = canonical.to_string_lossy().to_string();
            let suppressed = self_writes()
                .lock()
                .unwrap()
                .get(&canonical_str)
                .map_or(false, |t| {
                    t.elapsed().as_millis() < SELF_WRITE_SUPPRESSION_MS as u128
                })
                || self_writes()
                    .lock()
                    .unwrap()
                    .get(&original_path)
                    .map_or(false, |t| {
                        t.elapsed().as_millis() < SELF_WRITE_SUPPRESSION_MS as u128
                    });

            if suppressed {
                continue;
            }

            if within_sync_rewrite_window(&canonical) {
                continue;
            }

            let _ = app_handle.emit("solomd://file-changed", original_path);
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
    let parent = canonical
        .parent()
        .ok_or_else(|| format!("no parent for {}", canonical.display()))?
        .to_path_buf();

    // Decide whether the parent dir is new (so we know whether to
    // register the OS-level watch) under the lock, then drop the lock
    // before touching the debouncer to avoid holding two locks at once.
    let parent_is_new = {
        let mut inner = state.inner.lock().unwrap();
        if inner.watched_files.contains_key(&canonical) {
            // Already watching this exact file — refresh the original
            // path in case the caller passed a different alias for the
            // same canonical target (e.g. opened first via `/tmp/x`,
            // later via `/private/tmp/x`).
            inner.watched_files.insert(canonical.clone(), path.clone());
            return Ok(());
        }
        inner.watched_files.insert(canonical.clone(), path.clone());
        let count = inner.watched_dirs.entry(parent.clone()).or_insert(0);
        *count += 1;
        *count == 1
    };

    ensure_watcher(&app, &state);

    if parent_is_new {
        let mut guard = state.debouncer.lock().unwrap();
        if let Some(ref mut debouncer) = *guard {
            if let Err(e) = debouncer
                .watcher()
                .watch(&parent, RecursiveMode::NonRecursive)
            {
                // Roll back the bookkeeping if the OS watch failed —
                // otherwise we'd report success but never fire events.
                let mut inner = state.inner.lock().unwrap();
                inner.watched_files.remove(&canonical);
                if let Some(count) = inner.watched_dirs.get_mut(&parent) {
                    *count -= 1;
                    if *count == 0 {
                        inner.watched_dirs.remove(&parent);
                    }
                }
                return Err(format!("watch failed: {e}"));
            }
        }
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
    let parent = match canonical.parent() {
        Some(p) => p.to_path_buf(),
        None => return Ok(()),
    };

    let parent_now_empty = {
        let mut inner = state.inner.lock().unwrap();
        if inner.watched_files.remove(&canonical).is_none() {
            return Ok(()); // wasn't watching it
        }
        if let Some(count) = inner.watched_dirs.get_mut(&parent) {
            *count -= 1;
            if *count == 0 {
                inner.watched_dirs.remove(&parent);
                true
            } else {
                false
            }
        } else {
            false
        }
    };

    if parent_now_empty {
        let mut guard = state.debouncer.lock().unwrap();
        if let Some(ref mut debouncer) = *guard {
            let _ = debouncer.watcher().unwatch(&parent);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Arc<Mutex<WatcherInner>> {
        Arc::new(Mutex::new(WatcherInner {
            watched_files: HashMap::new(),
            watched_dirs: HashMap::new(),
        }))
    }

    /// Bookkeeping helper that mirrors `watch_file` minus the OS watch
    /// call — lets us assert the refcount logic without spinning up a
    /// real notify watcher. Treats the input string as both the
    /// "canonical" and "original" path for test purposes.
    fn track(inner: &Arc<Mutex<WatcherInner>>, file: &str) -> bool {
        let path = PathBuf::from(file);
        let parent = path.parent().unwrap().to_path_buf();
        let mut g = inner.lock().unwrap();
        if g.watched_files.contains_key(&path) {
            return false; // already watching
        }
        g.watched_files.insert(path, file.to_string());
        let count = g.watched_dirs.entry(parent).or_insert(0);
        *count += 1;
        *count == 1
    }

    fn untrack(inner: &Arc<Mutex<WatcherInner>>, file: &str) -> bool {
        let path = PathBuf::from(file);
        let parent = path.parent().unwrap().to_path_buf();
        let mut g = inner.lock().unwrap();
        if g.watched_files.remove(&path).is_none() {
            return false;
        }
        if let Some(c) = g.watched_dirs.get_mut(&parent) {
            *c -= 1;
            if *c == 0 {
                g.watched_dirs.remove(&parent);
                return true;
            }
        }
        false
    }

    #[test]
    fn first_file_in_dir_registers_dir_watch() {
        let inner = fresh();
        // First file under /tmp/notes → caller must register OS watch on /tmp/notes
        assert!(track(&inner, "/tmp/notes/a.md"));
        let g = inner.lock().unwrap();
        assert_eq!(g.watched_files.len(), 1);
        assert_eq!(g.watched_dirs.get(&PathBuf::from("/tmp/notes")), Some(&1));
        // The original-path map keeps the caller's exact string so we
        // can emit it back unchanged in the event payload.
        assert_eq!(
            g.watched_files.get(&PathBuf::from("/tmp/notes/a.md")),
            Some(&"/tmp/notes/a.md".to_string())
        );
    }

    #[test]
    fn additional_files_in_same_dir_do_not_re_register() {
        let inner = fresh();
        track(&inner, "/tmp/notes/a.md");
        // Second + third files in the same dir → no new OS watch
        assert!(!track(&inner, "/tmp/notes/b.md"));
        assert!(!track(&inner, "/tmp/notes/c.md"));
        assert_eq!(
            inner.lock().unwrap().watched_dirs.get(&PathBuf::from("/tmp/notes")),
            Some(&3)
        );
    }

    #[test]
    fn duplicate_track_is_idempotent() {
        let inner = fresh();
        track(&inner, "/tmp/notes/a.md");
        // Same file re-watched → not a new dir registration, and no
        // double-count of the dir refcount.
        assert!(!track(&inner, "/tmp/notes/a.md"));
        assert_eq!(
            inner.lock().unwrap().watched_dirs.get(&PathBuf::from("/tmp/notes")),
            Some(&1)
        );
    }

    #[test]
    fn unwatch_last_file_releases_dir() {
        let inner = fresh();
        track(&inner, "/tmp/notes/a.md");
        track(&inner, "/tmp/notes/b.md");
        // Removing one file in a multi-file dir → keep the OS watch
        assert!(!untrack(&inner, "/tmp/notes/a.md"));
        assert_eq!(
            inner.lock().unwrap().watched_dirs.get(&PathBuf::from("/tmp/notes")),
            Some(&1)
        );
        // Removing the last → release the OS watch
        assert!(untrack(&inner, "/tmp/notes/b.md"));
        assert!(inner.lock().unwrap().watched_dirs.is_empty());
    }

    #[test]
    fn unwatch_unknown_file_is_no_op() {
        let inner = fresh();
        assert!(!untrack(&inner, "/tmp/notes/ghost.md"));
        assert!(inner.lock().unwrap().watched_dirs.is_empty());
    }

    #[test]
    fn files_in_different_dirs_get_separate_dir_watches() {
        let inner = fresh();
        assert!(track(&inner, "/tmp/notes/a.md"));
        assert!(track(&inner, "/tmp/journal/b.md"));
        let g = inner.lock().unwrap();
        assert_eq!(g.watched_dirs.len(), 2);
        assert_eq!(g.watched_dirs.get(&PathBuf::from("/tmp/notes")), Some(&1));
        assert_eq!(g.watched_dirs.get(&PathBuf::from("/tmp/journal")), Some(&1));
    }

    /// Real notify integration: write to temp file directly, then via
    /// atomic-save (write to .tmp + rename). The pre-v4.2 watcher (which
    /// watched files directly with NonRecursive) would miss the atomic
    /// case. This test confirms watching the parent dir catches both.
    #[test]
    fn dir_watch_catches_atomic_save() {
        use std::sync::mpsc;
        use std::fs;

        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("note.md");
        fs::write(&target, b"initial\n").unwrap();
        let canonical_target = fs::canonicalize(&target).unwrap();

        let (tx, rx) = mpsc::channel();
        let mut deb = new_debouncer(Duration::from_millis(100), move |res: notify_debouncer_mini::DebounceEventResult| {
            if let Ok(events) = res {
                for ev in events {
                    if let Ok(p) = fs::canonicalize(&ev.path) {
                        let _ = tx.send(p);
                    }
                }
            }
        }).unwrap();
        deb.watcher().watch(tmp.path(), RecursiveMode::NonRecursive).unwrap();
        // notify needs a moment to register on macOS FSEvents
        std::thread::sleep(Duration::from_millis(200));

        // Case 1: direct overwrite — both watcher strategies catch this.
        fs::write(&target, b"direct edit\n").unwrap();

        // Case 2: atomic save — write tmp, rename into place. The old
        // watcher missed this because the original inode disappeared.
        let tmp_file = tmp.path().join("note.md.tmp");
        fs::write(&tmp_file, b"atomic edit\n").unwrap();
        fs::rename(&tmp_file, &target).unwrap();

        // Collect events within a generous window. We expect at least
        // one event for the canonical target path.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut saw_target = false;
        while Instant::now() < deadline {
            if let Ok(p) = rx.recv_timeout(Duration::from_millis(300)) {
                if p == canonical_target {
                    saw_target = true;
                }
            }
        }
        assert!(saw_target, "watcher missed events for {}", canonical_target.display());
    }
}
