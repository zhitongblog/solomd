//! AutoGit per-note version history (v2.2).
//!
//! Inspired by Tolaria — every save snapshots the workspace into a local
//! git repo so users get unlimited undo + per-file history without having
//! to learn git. We use `git2` (libgit2 bindings) so there's no `git`
//! binary requirement on the user's machine.
//!
//! All commands take an absolute `folder` path; we open / init the repo at
//! that folder. Errors bubble up as `String` so they can render directly
//! in the toast layer.
//!
//! Tauri commands exported (registered in `lib.rs`):
//!   * `git_workspace_status`   — fast read-only check
//!   * `git_init_workspace`     — create the repo + initial commit
//!   * `git_auto_commit`        — debounced save snapshot
//!   * `git_file_history`       — log filtered by a single file
//!   * `git_file_diff`          — unified diff for one commit / file
//!   * `git_file_at_version`    — file content at a given commit
//!   * `git_rollback_file`      — overwrite working copy with old version

use std::fs;
use std::path::{Path, PathBuf};

use git2::{
    BranchType, Commit, DiffFormat, DiffOptions, IndexAddOption, ObjectType, Oid, Repository,
    Signature, Sort, Status, StatusOptions, Time,
};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Public types (mirrored on the TS side in `stores/gitHistory.ts`).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct WorkspaceStatus {
    /// True iff the folder contains a `.git` and we could open it.
    pub initialized: bool,
    /// Full SHA of HEAD commit (if any).
    pub head_sha: Option<String>,
    /// First-line of HEAD commit message.
    pub head_message: Option<String>,
    /// True if any tracked file differs from HEAD or there are untracked
    /// `.md` / `.txt` files.
    pub dirty: bool,
    /// Current branch shorthand (e.g. `main`).
    pub branch: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CommitMeta {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub author: String,
    /// Seconds since UNIX epoch (UTC).
    pub time: i64,
}

#[derive(Debug, Serialize)]
pub struct DiffLine {
    /// One of `"context" | "add" | "remove"`.
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
pub struct DiffResult {
    pub from_sha: Option<String>,
    pub to_sha: String,
    pub hunks: Vec<DiffHunk>,
    /// Standard unified-diff text (handy for raw display / copy).
    pub unified: String,
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/// Open the repo at `folder`. We don't walk upwards — the workspace folder
/// is the repo root by construction.
fn open_repo(folder: &str) -> Result<Repository, String> {
    let path = Path::new(folder);
    Repository::open(path).map_err(|e| format!("git open failed: {}", e))
}

/// Build a `Signature` for commits. Reads `user.name` / `user.email` from
/// the user's global git config; falls back to `solomd@local`.
fn build_signature(repo: &Repository) -> Result<Signature<'static>, String> {
    let cfg = repo.config().map_err(|e| format!("git config: {}", e))?;
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
    Signature::now(&name, &email).map_err(|e| format!("signature: {}", e))
}

/// Convert an absolute working-copy path into a forward-slash repo-relative
/// path (libgit2's pathspec format). Returns `None` if the file is outside
/// the workdir.
fn rel_path(repo: &Repository, abs: &str) -> Option<String> {
    let workdir = repo.workdir()?;
    let p = Path::new(abs);
    let stripped = p.strip_prefix(workdir).ok()?;
    let s = stripped.to_string_lossy().replace('\\', "/");
    Some(s)
}

/// Default auto-commit message: `auto: 2026-04-24 09:30:01`.
fn default_auto_message() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Tiny, dep-free local-time formatter. We display in UTC to avoid pulling
    // chrono just for one timestamp; users see this only in commit messages.
    format!("auto: {}", format_unix_utc(secs))
}

/// Format `YYYY-MM-DD HH:MM:SS` in UTC from a unix timestamp.
fn format_unix_utc(secs: i64) -> String {
    // Days since epoch + seconds-of-day.
    let days = secs.div_euclid(86_400);
    let mut sod = secs.rem_euclid(86_400);
    let h = sod / 3600;
    sod %= 3600;
    let m = sod / 60;
    let s = sod % 60;
    // Civil-from-days (Howard Hinnant). Handles leap years correctly.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y, mo, d, h, m, s
    )
}

/// Whether the file under `path` is tracked by the repo.
fn _is_tracked(repo: &Repository, rel: &str) -> bool {
    repo.status_file(Path::new(rel))
        .map(|st| !st.contains(Status::WT_NEW) || !st.is_empty())
        .unwrap_or(false)
}

/// Workspace `dirty` flag — true if any markdown/text file is modified or
/// new since HEAD. We restrict the scan to `.md` / `.txt` to avoid being
/// dragged down by bulky `_assets/` directories.
fn workspace_is_dirty(repo: &Repository) -> bool {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    for entry in statuses.iter() {
        let p = entry.path().unwrap_or("");
        let lower = p.to_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")) {
            continue;
        }
        let st = entry.status();
        // Anything other than CURRENT means there's something to commit.
        if !st.is_empty() {
            return true;
        }
    }
    false
}

fn write_default_gitignore(folder: &Path, exclude_assets: bool) -> std::io::Result<()> {
    let gi = folder.join(".gitignore");
    if gi.exists() {
        return Ok(());
    }
    let mut body = String::from(
        "# SoloMD AutoGit defaults\n\
         .DS_Store\n\
         Thumbs.db\n\
         desktop.ini\n\
         node_modules/\n\
         .obsidian/workspace*\n\
         .obsidian/cache\n\
         .vscode/\n\
         *.tmp\n\
         *~\n",
    );
    if exclude_assets {
        body.push_str("_assets/\n");
    }
    fs::write(gi, body)
}

/// Stage files under a pathspec. If `pathspec` is `None`, stages every
/// modification + every new untracked path. Otherwise, stages only that
/// single path (relative).
fn stage(repo: &Repository, pathspec: Option<&str>) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| format!("index: {}", e))?;
    if let Some(rel) = pathspec {
        // For deletions, `add_path` won't pick them up — fall back to
        // `update_all` first, then `add_path` for the live file.
        index
            .update_all([rel].iter(), None)
            .map_err(|e| format!("index update: {}", e))?;
        let abs = repo
            .workdir()
            .map(|w| w.join(rel))
            .unwrap_or_else(|| PathBuf::from(rel));
        if abs.exists() {
            index
                .add_path(Path::new(rel))
                .map_err(|e| format!("index add: {}", e))?;
        }
    } else {
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("index add_all: {}", e))?;
    }
    index.write().map_err(|e| format!("index write: {}", e))?;
    Ok(())
}

/// Shared "create commit from staged tree" helper. Returns `None` if the
/// tree didn't change since HEAD.
fn commit_staged(
    repo: &Repository,
    sig: &Signature<'_>,
    message: &str,
) -> Result<Option<String>, String> {
    let mut index = repo.index().map_err(|e| format!("index: {}", e))?;
    let tree_oid = index.write_tree().map_err(|e| format!("write_tree: {}", e))?;
    let tree = repo.find_tree(tree_oid).map_err(|e| format!("find_tree: {}", e))?;

    // Collect parents (we always have 0 or 1 — no merges in autogit).
    let parents: Vec<Commit<'_>> = match repo.head() {
        Ok(head) => {
            let oid = head.target().ok_or_else(|| "head has no target".to_string())?;
            // Skip the commit if the staged tree matches HEAD's tree exactly.
            let parent = repo.find_commit(oid).map_err(|e| format!("find HEAD: {}", e))?;
            if parent.tree_id() == tree_oid {
                return Ok(None);
            }
            vec![parent]
        }
        Err(_) => vec![], // unborn HEAD — first commit
    };
    let parent_refs: Vec<&Commit<'_>> = parents.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), sig, sig, message, &tree, &parent_refs)
        .map_err(|e| format!("commit: {}", e))?;
    Ok(Some(oid.to_string()))
}

// ---------------------------------------------------------------------------
// Tauri commands.
// ---------------------------------------------------------------------------

/// Sync impl. Public command below dispatches to spawn_blocking — never
/// call this directly from a Tauri command thread, only through the async
/// wrapper, so a slow git2 call can't freeze the UI.
fn git_workspace_status_inner(folder: String) -> Result<WorkspaceStatus, String> {
    if folder.is_empty() {
        return Ok(WorkspaceStatus {
            initialized: false,
            head_sha: None,
            head_message: None,
            dirty: false,
            branch: None,
        });
    }
    let repo = match Repository::open(Path::new(&folder)) {
        Ok(r) => r,
        Err(_) => {
            return Ok(WorkspaceStatus {
                initialized: false,
                head_sha: None,
                head_message: None,
                dirty: false,
                branch: None,
            });
        }
    };
    let (head_sha, head_message) = match repo.head() {
        Ok(h) => match h.peel_to_commit() {
            Ok(c) => {
                let msg = c
                    .summary()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                (Some(c.id().to_string()), Some(msg))
            }
            Err(_) => (None, None),
        },
        Err(_) => (None, None),
    };
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));
    Ok(WorkspaceStatus {
        initialized: true,
        head_sha,
        head_message,
        dirty: workspace_is_dirty(&repo),
        branch,
    })
}

#[tauri::command]
pub async fn git_workspace_status(folder: String) -> Result<WorkspaceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_workspace_status_inner(folder))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn git_init_workspace_inner(
    folder: String,
    initial_message: Option<String>,
    exclude_assets: Option<bool>,
) -> Result<(), String> {
    let path = Path::new(&folder);
    if !path.exists() {
        return Err(format!("folder does not exist: {}", folder));
    }
    let repo = match Repository::open(path) {
        Ok(r) => r,
        Err(_) => Repository::init(path).map_err(|e| format!("git init: {}", e))?,
    };

    write_default_gitignore(path, exclude_assets.unwrap_or(false))
        .map_err(|e| format!("gitignore: {}", e))?;

    stage(&repo, None)?;
    let sig = build_signature(&repo)?;
    let msg = initial_message.unwrap_or_else(|| "init: SoloMD workspace".to_string());

    let _ = commit_staged(&repo, &sig, &msg)?;
    Ok(())
}

#[tauri::command]
pub async fn git_init_workspace(
    folder: String,
    initial_message: Option<String>,
    exclude_assets: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_init_workspace_inner(folder, initial_message, exclude_assets)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

fn git_auto_commit_inner(
    folder: String,
    file_path: Option<String>,
    message: Option<String>,
) -> Result<Option<String>, String> {
    let repo = open_repo(&folder)?;
    let pathspec = match file_path.as_ref() {
        Some(abs) => match rel_path(&repo, abs) {
            Some(r) => Some(r),
            None => return Err(format!("file is outside workspace: {}", abs)),
        },
        None => None,
    };
    stage(&repo, pathspec.as_deref())?;

    let sig = build_signature(&repo)?;
    let msg = message.unwrap_or_else(default_auto_message);
    commit_staged(&repo, &sig, &msg)
}

#[tauri::command]
pub async fn git_auto_commit(
    folder: String,
    file_path: Option<String>,
    message: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_auto_commit_inner(folder, file_path, message)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

fn git_file_history_inner(
    folder: String,
    file_path: String,
    limit: u32,
) -> Result<Vec<CommitMeta>, String> {
    let repo = open_repo(&folder)?;
    let rel = rel_path(&repo, &file_path)
        .ok_or_else(|| format!("file is outside workspace: {}", file_path))?;

    // No HEAD yet → empty history (the file's never been committed).
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(vec![]),
    };
    let head_oid = match head.target() {
        Some(o) => o,
        None => return Ok(vec![]),
    };

    let mut walk = repo.revwalk().map_err(|e| format!("revwalk: {}", e))?;
    walk.set_sorting(Sort::TIME).ok();
    walk.push(head_oid).map_err(|e| format!("revwalk push: {}", e))?;

    let mut out = Vec::with_capacity(limit as usize);
    let cap = if limit == 0 { 50 } else { limit } as usize;

    for oid in walk {
        let oid = match oid {
            Ok(o) => o,
            Err(_) => continue,
        };
        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !commit_touches_path(&repo, &commit, &rel) {
            continue;
        }
        out.push(commit_to_meta(&commit));
        if out.len() >= cap {
            break;
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_file_history(
    folder: String,
    file_path: String,
    limit: u32,
) -> Result<Vec<CommitMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_file_history_inner(folder, file_path, limit)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

fn commit_to_meta(commit: &Commit<'_>) -> CommitMeta {
    let sha = commit.id().to_string();
    let short = if sha.len() >= 7 { sha[..7].to_string() } else { sha.clone() };
    let author = commit.author();
    let name = author.name().unwrap_or("?").to_string();
    let when: Time = author.when();
    CommitMeta {
        sha,
        short_sha: short,
        message: commit
            .summary()
            .map(|s| s.to_string())
            .unwrap_or_default(),
        author: name,
        time: when.seconds(),
    }
}

/// Did this commit's diff vs its first parent touch `rel`? For the root
/// commit (no parents) we treat every file in its tree as "touched".
fn commit_touches_path(repo: &Repository, commit: &Commit<'_>, rel: &str) -> bool {
    let tree = match commit.tree() {
        Ok(t) => t,
        Err(_) => return false,
    };
    if commit.parent_count() == 0 {
        return tree.get_path(Path::new(rel)).is_ok();
    }
    let parent = match commit.parent(0) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let parent_tree = match parent.tree() {
        Ok(t) => t,
        Err(_) => return false,
    };
    let mut opts = DiffOptions::new();
    opts.pathspec(rel);
    let diff = match repo.diff_tree_to_tree(Some(&parent_tree), Some(&tree), Some(&mut opts)) {
        Ok(d) => d,
        Err(_) => return false,
    };
    diff.deltas().len() > 0
}

fn git_file_diff_inner(
    folder: String,
    file_path: String,
    sha: String,
) -> Result<DiffResult, String> {
    let repo = open_repo(&folder)?;
    let rel = rel_path(&repo, &file_path)
        .ok_or_else(|| format!("file is outside workspace: {}", file_path))?;

    let oid = Oid::from_str(&sha).map_err(|e| format!("bad sha: {}", e))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("find_commit: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("tree: {}", e))?;
    let parent_tree = match commit.parent(0).ok().map(|p| p.tree()) {
        Some(Ok(t)) => Some(t),
        _ => None,
    };
    let from_sha = commit.parent(0).ok().map(|p| p.id().to_string());

    let mut opts = DiffOptions::new();
    opts.pathspec(&rel).context_lines(3);
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| format!("diff: {}", e))?;

    // Build structured hunks AND a textual unified diff in one pass.
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut unified = String::new();
    diff.print(DiffFormat::Patch, |_delta, hunk, line| {
        // Append the raw textual form.
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            unified.push(origin);
        }
        if let Ok(s) = std::str::from_utf8(line.content()) {
            unified.push_str(s);
        }

        // Keep our hunks vector in sync.
        if let Some(h) = hunk {
            // Open a new hunk if this is the first line, or the hunk header
            // doesn't match the last open hunk.
            let need_new = match hunks.last() {
                Some(last) => {
                    last.old_start != h.old_start()
                        || last.new_start != h.new_start()
                        || last.old_lines != h.old_lines()
                        || last.new_lines != h.new_lines()
                }
                None => true,
            };
            if need_new {
                hunks.push(DiffHunk {
                    old_start: h.old_start(),
                    old_lines: h.old_lines(),
                    new_start: h.new_start(),
                    new_lines: h.new_lines(),
                    lines: Vec::new(),
                });
            }
        }
        // Don't add file/hunk headers to structured output — only +/-/space.
        if matches!(origin, '+' | '-' | ' ') {
            if let Some(cur) = hunks.last_mut() {
                let kind = match origin {
                    '+' => "add",
                    '-' => "remove",
                    _ => "context",
                };
                let text = std::str::from_utf8(line.content())
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string();
                cur.lines.push(DiffLine {
                    kind: kind.to_string(),
                    text,
                });
            }
        }
        true
    })
    .map_err(|e| format!("diff print: {}", e))?;

    Ok(DiffResult {
        from_sha,
        to_sha: sha,
        hunks,
        unified,
    })
}

#[tauri::command]
pub async fn git_file_diff(
    folder: String,
    file_path: String,
    sha: String,
) -> Result<DiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_file_diff_inner(folder, file_path, sha)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

fn git_file_at_version_inner(
    folder: String,
    file_path: String,
    sha: String,
) -> Result<String, String> {
    let repo = open_repo(&folder)?;
    let rel = rel_path(&repo, &file_path)
        .ok_or_else(|| format!("file is outside workspace: {}", file_path))?;

    let oid = Oid::from_str(&sha).map_err(|e| format!("bad sha: {}", e))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("find_commit: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("tree: {}", e))?;
    let entry = tree
        .get_path(Path::new(&rel))
        .map_err(|e| format!("file not in commit: {}", e))?;
    let object = entry
        .to_object(&repo)
        .map_err(|e| format!("to_object: {}", e))?;
    let blob = object
        .as_blob()
        .ok_or_else(|| format!("not a blob: {}", rel))?;
    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

#[tauri::command]
pub async fn git_file_at_version(
    folder: String,
    file_path: String,
    sha: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_file_at_version_inner(folder, file_path, sha)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

fn git_rollback_file_inner(
    folder: String,
    file_path: String,
    sha: String,
) -> Result<(), String> {
    let content = git_file_at_version_inner(folder.clone(), file_path.clone(), sha)?;
    fs::write(Path::new(&file_path), content).map_err(|e| format!("write: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn git_rollback_file(
    folder: String,
    file_path: String,
    sha: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_rollback_file_inner(folder, file_path, sha)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ---------------------------------------------------------------------------
// Suppress unused warnings for currently-unused helpers (kept for future
// use by callers that want to gate on tracked/untracked status).
// ---------------------------------------------------------------------------
#[allow(dead_code)]
fn _force_use(_: BranchType, _: ObjectType) {}
