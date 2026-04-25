//! End-to-end test for the v2.2 AutoGit version-history flow.
//!
//! Drives every public sync impl exposed by `git_history` against a real
//! temp directory + real libgit2. No Tauri runtime needed. If anything in
//! the init / commit / log / diff / rollback chain breaks, this catches
//! it before it reaches the UI.

use app_lib::git_history::{
    git_auto_commit_inner, git_file_at_version_inner, git_file_diff_inner,
    git_file_history_inner, git_init_workspace_inner, git_rollback_file_inner,
    git_workspace_status_inner,
};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn fresh_workspace(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-autogit-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &PathBuf, content: &str) {
    fs::write(path, content).unwrap();
}

#[test]
fn autogit_full_flow_init_commit_history_diff_rollback() {
    let ws = fresh_workspace("full");
    let note = ws.join("note.md");
    let folder = ws.to_string_lossy().to_string();
    let note_abs = note.to_string_lossy().to_string();

    // Seed an initial file and init the repo.
    write(&note, "# Hello\n\nv1 content\n");
    git_init_workspace_inner(folder.clone(), Some("init: ws".into()), Some(false))
        .expect("init_workspace should succeed");

    // Status should now report initialized + clean.
    let status = git_workspace_status_inner(folder.clone()).unwrap();
    assert!(status.initialized, "repo should be initialized");
    assert!(!status.dirty, "expected clean tree right after init");
    assert!(status.head_sha.is_some(), "init should produce HEAD commit");
    let init_sha = status.head_sha.clone().unwrap();

    // libgit2 commit times have second-level granularity. Sleep between
    // commits so the revwalk Sort::TIME ordering is deterministic — in
    // production the AutoGit debounce is 30s by default so this is never
    // an issue, but tests fire commits in rapid succession.
    thread::sleep(Duration::from_millis(1100));

    // Modify the note and auto-commit.
    write(&note, "# Hello\n\nv2 content with one more line\n");
    let v2_sha = git_auto_commit_inner(folder.clone(), Some(note_abs.clone()), None)
        .expect("auto_commit should succeed")
        .expect("auto_commit should return a new sha");
    assert_ne!(v2_sha, init_sha, "auto_commit should create a new commit");

    // Tree must NOT be dirty after commit.
    let status_after = git_workspace_status_inner(folder.clone()).unwrap();
    assert!(!status_after.dirty, "tree should be clean after auto_commit");

    thread::sleep(Duration::from_millis(1100));

    // Modify again — second commit.
    write(&note, "# Hello\n\nv3 content with two more lines\nand even more\n");
    let v3_sha = git_auto_commit_inner(folder.clone(), Some(note_abs.clone()), None)
        .unwrap()
        .expect("third commit");
    assert_ne!(v3_sha, v2_sha);

    // History for the file: should have 3 entries (init + v2 + v3), newest first.
    let hist = git_file_history_inner(folder.clone(), note_abs.clone(), 50)
        .expect("file_history should succeed");
    assert_eq!(hist.len(), 3, "expected 3 history entries, got {}", hist.len());
    assert_eq!(hist[0].sha, v3_sha, "newest commit should be first");
    assert_eq!(hist[1].sha, v2_sha);
    assert_eq!(hist[2].sha, init_sha);

    // Diff for v3: should mention "two more lines" / "and even more" as additions.
    let diff = git_file_diff_inner(folder.clone(), note_abs.clone(), v3_sha.clone())
        .expect("file_diff should succeed");
    assert!(
        diff.unified.contains("two more lines"),
        "diff missing v3 add: {}",
        diff.unified
    );
    assert!(
        diff.hunks.iter().any(|h| h.lines.iter().any(|l| l.kind == "add")),
        "expected at least one structured 'add' line"
    );

    // file_at_version: read v2's content.
    let v2_content =
        git_file_at_version_inner(folder.clone(), note_abs.clone(), v2_sha.clone())
            .expect("file_at_version should succeed");
    assert_eq!(v2_content, "# Hello\n\nv2 content with one more line\n");

    // Rollback the working copy to v2.
    git_rollback_file_inner(folder.clone(), note_abs.clone(), v2_sha.clone())
        .expect("rollback should succeed");
    let on_disk = fs::read_to_string(&note).unwrap();
    assert_eq!(
        on_disk, "# Hello\n\nv2 content with one more line\n",
        "rollback should overwrite the working copy with v2 content"
    );

    // Rollback dirties the tree (working copy != HEAD).
    let dirty_after_rollback = git_workspace_status_inner(folder.clone()).unwrap().dirty;
    assert!(
        dirty_after_rollback,
        "tree should be dirty immediately after rollback (HEAD was v3, working copy is v2)"
    );

    // Cleanup.
    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn autogit_no_op_commit_returns_none() {
    let ws = fresh_workspace("noop");
    let note = ws.join("a.md");
    let folder = ws.to_string_lossy().to_string();
    let note_abs = note.to_string_lossy().to_string();

    write(&note, "stable\n");
    git_init_workspace_inner(folder.clone(), None, None).unwrap();

    // Nothing has changed since init — auto_commit should be a no-op (Ok(None)).
    let result =
        git_auto_commit_inner(folder.clone(), Some(note_abs), None).expect("commit call ok");
    assert!(result.is_none(), "expected no commit when tree unchanged");

    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn autogit_status_on_uninitialized_folder_is_safe() {
    let ws = fresh_workspace("uninit");
    let folder = ws.to_string_lossy().to_string();

    // Status before init: must NOT panic, and must report initialized=false.
    let status = git_workspace_status_inner(folder).unwrap();
    assert!(!status.initialized);
    assert!(status.head_sha.is_none());
    assert!(status.head_message.is_none());

    let _ = fs::remove_dir_all(&ws);
}

#[test]
fn autogit_history_for_file_outside_workspace_errors_cleanly() {
    let ws = fresh_workspace("outside");
    let folder = ws.to_string_lossy().to_string();
    git_init_workspace_inner(folder.clone(), None, None).unwrap();

    // Path completely outside workspace.
    let outsider = "/tmp/definitely-not-in-this-workspace.md".to_string();
    let result = git_file_history_inner(folder, outsider, 10);
    assert!(result.is_err(), "expected error for path outside workspace");

    let _ = fs::remove_dir_all(&ws);
}
