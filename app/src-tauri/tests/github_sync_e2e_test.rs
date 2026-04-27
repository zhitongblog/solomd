//! End-to-end test for the v2.6 GitHub sync push/pull/conflict flow.
//!
//! Uses `file://` remotes so the test runs offline and never touches the
//! OS keychain or api.github.com. The PAT credentials callback is still
//! plumbed through, but libgit2's local transport ignores it.
//!
//! Drives `github_push_inner` + `github_pull_inner` against three local
//! workspaces:
//!   - `bare`       — a bare repo standing in for the GitHub remote
//!   - `device_a`   — first "device" with the workspace clone
//!   - `device_b`   — second "device" simulating a different machine
//!
//! Verifies:
//!   1. Initial push from device_a populates the bare repo.
//!   2. device_b pulls and sees the file.
//!   3. Concurrent edits → ff path on the slower side, conflict path
//!      when both sides have edits to the same file.

use app_lib::github_sync::{github_pull_inner, github_push_inner};
use git2::{Repository, Signature};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn fresh_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-ghs-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
}

fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
    let sig = Signature::now("Test", "test@local").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    idx.write().unwrap();
    let tree_oid = idx.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let parent = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
        .unwrap()
}

fn init_workspace_with_remote(label: &str, bare_url: &str) -> PathBuf {
    let ws = fresh_dir(label);
    {
        let repo = Repository::init(&ws).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test").ok();
        cfg.set_str("user.email", "test@local").ok();
        cfg.set_str("init.defaultBranch", "main").ok();
        // Force the unborn HEAD to point at refs/heads/main rather than
        // master, so commits land on `main` (matches modern git default).
        let needs_switch = {
            let head = repo.find_reference("HEAD").unwrap();
            head.symbolic_target() == Some("refs/heads/master")
        };
        if needs_switch {
            repo.reference_symbolic("HEAD", "refs/heads/main", true, "switch to main")
                .unwrap();
        }
        repo.remote("origin", bare_url).unwrap();
    }

    // Write the .solomd/sync.json the inner helpers expect.
    let cfg_dir = ws.join(".solomd");
    fs::create_dir_all(&cfg_dir).unwrap();
    let sync_json = format!(
        r#"{{"remote_url":"{}","auto_push":true,"auto_pull_minutes":0,"last_push_at":null,"last_pull_at":null}}"#,
        bare_url
    );
    fs::write(cfg_dir.join("sync.json"), sync_json).unwrap();
    // Mirror what github_link_workspace does in production: keep .solomd/
    // out of the tracked tree so per-device sync.json never conflicts.
    fs::write(ws.join(".gitignore"), ".solomd/\n").unwrap();
    ws
}

#[test]
fn github_sync_push_pull_roundtrip() {
    // Bare repo standing in for github.com/owner/notes.git
    let bare_dir = fresh_dir("bare");
    Repository::init_bare(&bare_dir).unwrap();
    let bare_url = format!("file://{}", bare_dir.display());

    // Device A creates a note and pushes.
    let dev_a = init_workspace_with_remote("devA", &bare_url);
    write(&dev_a.join("note.md"), "hello from device A\n");
    {
        let repo_a = Repository::open(&dev_a).unwrap();
        commit_all(&repo_a, "initial: device A");
    }

    let folder_a = dev_a.to_string_lossy().to_string();
    github_push_inner(folder_a.clone(), "ignored-by-file-transport".into())
        .expect("device A should be able to push to a bare local remote");

    // Device B starts with the .gitignore committed as its initial state
    // (mirrors first-launch AutoGit), then pulls device A's changes.
    let dev_b = init_workspace_with_remote("devB", &bare_url);
    {
        let repo_b = Repository::open(&dev_b).unwrap();
        commit_all(&repo_b, "init: device B");
    }

    let folder_b = dev_b.to_string_lossy().to_string();
    let r = github_pull_inner(folder_b.clone(), "ignored".into())
        .expect("device B should be able to pull");
    // Diverged histories — A and B both have an init commit but they're
    // different (B is empty). Expect a merge.
    assert!(
        r.kind == "merged" || r.kind == "fast_forward",
        "expected merged/fast_forward, got {} (conflicts: {:?})",
        r.kind,
        r.conflicts
    );
    assert!(
        dev_b.join("note.md").exists(),
        "device B should now see device A's note.md after pull"
    );
    let body = fs::read_to_string(dev_b.join("note.md")).unwrap();
    assert!(body.contains("hello from device A"));

    // Round trip: B edits + pushes, A pulls and sees it.
    write(&dev_b.join("note.md"), "hello from A\nedited on B\n");
    {
        let repo_b = Repository::open(&dev_b).unwrap();
        commit_all(&repo_b, "device B edit");
    }
    github_push_inner(folder_b, "ignored".into()).expect("device B push");

    let r2 = github_pull_inner(folder_a, "ignored".into()).expect("device A pull");
    assert!(
        r2.kind == "fast_forward" || r2.kind == "merged",
        "device A pull should fast-forward / merge, got {}",
        r2.kind
    );
    let a_body = fs::read_to_string(dev_a.join("note.md")).unwrap();
    assert!(
        a_body.contains("edited on B"),
        "device A should now see B's edit, got: {}",
        a_body
    );
}

#[test]
fn github_sync_surfaces_conflicts_on_concurrent_edit() {
    let bare_dir = fresh_dir("bare-conflict");
    Repository::init_bare(&bare_dir).unwrap();
    let bare_url = format!("file://{}", bare_dir.display());

    // Both devices start from the same baseline.
    let dev_a = init_workspace_with_remote("conflictA", &bare_url);
    write(&dev_a.join("note.md"), "line one\nline two\nline three\n");
    {
        let repo_a = Repository::open(&dev_a).unwrap();
        commit_all(&repo_a, "baseline");
    }
    github_push_inner(
        dev_a.to_string_lossy().into_owned(),
        "ignored".into(),
    )
    .expect("baseline push");

    // Device B clones the baseline via pull.
    let dev_b = init_workspace_with_remote("conflictB", &bare_url);
    {
        let repo_b = Repository::open(&dev_b).unwrap();
        commit_all(&repo_b, "init: B");
    }
    github_pull_inner(
        dev_b.to_string_lossy().into_owned(),
        "ignored".into(),
    )
    .expect("B pulls baseline");

    // Both devices edit the SAME line.
    write(
        &dev_a.join("note.md"),
        "line one\nA's version of two\nline three\n",
    );
    {
        let repo_a = Repository::open(&dev_a).unwrap();
        commit_all(&repo_a, "A edit");
    }
    github_push_inner(
        dev_a.to_string_lossy().into_owned(),
        "ignored".into(),
    )
    .expect("A push");

    write(
        &dev_b.join("note.md"),
        "line one\nB's version of two\nline three\n",
    );
    {
        let repo_b = Repository::open(&dev_b).unwrap();
        commit_all(&repo_b, "B edit");
    }

    // B pulls — should surface the conflict, not silently merge.
    let r = github_pull_inner(
        dev_b.to_string_lossy().into_owned(),
        "ignored".into(),
    )
    .expect("B pull (with conflict)");
    assert_eq!(r.kind, "conflicts", "expected conflicts, got {}", r.kind);
    assert_eq!(r.conflicts.len(), 1);
    assert!(r.conflicts[0].ends_with("note.md"));
}

/// Regression test for the v3.0.x audit fix: sync.json that fails to
/// parse must NOT degrade silently to a default Config (which would
/// have encrypted=false and could push plaintext from a workspace
/// whose user had E2EE enabled). github_push_inner / github_pull_inner
/// must instead surface the parse error.
#[test]
fn github_sync_corrupted_config_fails_closed() {
    let bare_dir = fresh_dir("bare-fc");
    Repository::init_bare(&bare_dir).unwrap();
    let bare_url = format!("file://{}", bare_dir.display());

    let dev = init_workspace_with_remote("devFC", &bare_url);
    write(&dev.join("note.md"), "hello\n");
    {
        let repo = Repository::open(&dev).unwrap();
        commit_all(&repo, "init");
    }

    // Corrupt sync.json — typical real-world scenario is a truncated
    // write after a crash, but malformed JSON exercises the same path.
    fs::write(dev.join(".solomd/sync.json"), b"{not valid json").unwrap();

    let folder = dev.to_string_lossy().into_owned();
    let push_err = github_push_inner(folder.clone(), "ignored".into()).err();
    assert!(
        push_err.is_some(),
        "push must refuse when sync.json is corrupted (got Ok)"
    );

    let pull_err = github_pull_inner(folder, "ignored".into()).err();
    assert!(
        pull_err.is_some(),
        "pull must refuse when sync.json is corrupted (got Ok)"
    );
}
