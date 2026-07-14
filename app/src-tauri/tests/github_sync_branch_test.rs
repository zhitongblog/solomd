//! #147 — push/pull branch-name asymmetry.
//!
//! Push has always normalized a local `master` to `main` before pushing, so
//! the remote ends up with `main`. Pull, however, fetched the raw local HEAD
//! name — a second device whose local repo was still on libgit2's default
//! `master` fetched the nonexistent `origin/master` forever and never saw
//! the first device's pushes.
//!
//! Scenario 1: local repo stuck on `master`, remote has `main` → pull must
//!             normalize (rename to main) and fast-forward from origin/main.
//! Scenario 2: legacy remote that only has `master`, local already on `main`
//!             → pull must fall back to fetching `master` and still merge.

use app_lib::github_sync::github_pull_inner;
use git2::{Repository, Signature};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn fresh(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let p = std::env::temp_dir().join(format!("solomd-branch-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
}

fn file_url(path: &Path) -> String {
    let mut p = path
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    if let Some(stripped) = p.strip_prefix("//?/") {
        p = stripped.to_string();
    }
    if p.as_bytes().get(1) == Some(&b':') {
        p = format!("/{p}");
    }
    format!("file://{p}")
}

fn write_sync_json(folder: &Path, remote_url: &str) {
    let cfg_dir = folder.join(".solomd");
    fs::create_dir_all(&cfg_dir).unwrap();
    let body = json!({
        "remote_url": remote_url,
        "auto_push": true,
        "auto_pull_minutes": 0,
        "last_push_at": null,
        "last_pull_at": null,
        "encrypted": false,
        "provider": "github",
    })
    .to_string();
    fs::write(cfg_dir.join("sync.json"), body).unwrap();
    fs::write(folder.join(".gitignore"), ".solomd/\n").unwrap();
}

fn commit_file(repo: &Repository, workdir: &Path, name: &str, body: &str, msg: &str) -> git2::Oid {
    fs::write(workdir.join(name), body).unwrap();
    let sig = Signature::now("Test", "test@local").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    idx.write().unwrap();
    let tree_oid = idx.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
        .unwrap()
}

/// Seed a bare remote with two commits (X → Y) on `remote_branch`.
/// Returns the oid of X (the older commit).
fn seed_remote(bare_url: &str, remote_branch: &str) -> git2::Oid {
    let seeder = fresh("seeder");
    let repo = Repository::init(&seeder).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Test").ok();
    cfg.set_str("user.email", "test@local").ok();
    let x = commit_file(&repo, &seeder, "note.md", "version X\n", "X");
    commit_file(&repo, &seeder, "note.md", "version Y\n", "Y");
    repo.remote("origin", bare_url).unwrap();
    let mut origin = repo.find_remote("origin").unwrap();
    let head = repo.head().unwrap();
    let src = head.shorthand().unwrap().to_string();
    origin
        .push(
            &[format!("refs/heads/{src}:refs/heads/{remote_branch}").as_str()],
            None,
        )
        .unwrap();
    x
}

/// Create a device workspace whose local repo sits on `local_branch` at
/// commit X (one commit behind the remote), the way a second linked device
/// looks after the first device pushed an update.
fn device_behind(bare_url: &str, local_branch: &str, x: git2::Oid) -> PathBuf {
    let dev = fresh("dev");
    let repo = Repository::init(&dev).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Test").ok();
    cfg.set_str("user.email", "test@local").ok();
    repo.remote("origin", bare_url).unwrap();
    // Fetch everything so commit X exists locally, then plant the local
    // branch at X and point HEAD at it.
    let mut origin = repo.find_remote("origin").unwrap();
    origin
        .fetch(&["+refs/heads/*:refs/remotes/origin/*"], None, None)
        .unwrap();
    let x_commit = repo.find_commit(x).unwrap();
    repo.branch(local_branch, &x_commit, true).unwrap();
    repo.set_head(&format!("refs/heads/{local_branch}")).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
    // Drop the remote-tracking refs the setup fetch created, so the pull
    // under test has to do its own fetch (that's the code path #147 broke).
    for name in ["main", "master"] {
        if let Ok(mut r) = repo.find_reference(&format!("refs/remotes/origin/{name}")) {
            let _ = r.delete();
        }
    }
    write_sync_json(&dev, bare_url);
    dev
}

#[test]
fn pull_normalizes_local_master_when_remote_has_main() {
    // Remote: main @ Y. Device: master @ X (libgit2 default branch name).
    let bare = fresh("bare-main");
    Repository::init_bare(&bare).unwrap();
    let bare_url = file_url(&bare);
    let x = seed_remote(&bare_url, "main");
    let dev = device_behind(&bare_url, "master", x);

    let r = github_pull_inner(dev.to_string_lossy().into_owned(), "ignored".into())
        .expect("pull from a master-stuck device must succeed against a main remote");
    assert_eq!(r.kind, "fast_forward");
    assert_eq!(fs::read_to_string(dev.join("note.md")).unwrap(), "version Y\n");

    // The local branch converged on `main`, same as push would have done.
    let repo = Repository::open(&dev).unwrap();
    assert_eq!(repo.head().unwrap().shorthand(), Some("main"));
}

#[test]
fn pull_falls_back_to_remote_master_for_legacy_repos() {
    // Remote: only master @ Y (pre-normalization repo). Device: main @ X.
    let bare = fresh("bare-master");
    Repository::init_bare(&bare).unwrap();
    let bare_url = file_url(&bare);
    let x = seed_remote(&bare_url, "master");
    let dev = device_behind(&bare_url, "main", x);

    let r = github_pull_inner(dev.to_string_lossy().into_owned(), "ignored".into())
        .expect("pull must fall back to origin/master when the remote has no main");
    assert_eq!(r.kind, "fast_forward");
    assert_eq!(fs::read_to_string(dev.join("note.md")).unwrap(), "version Y\n");

    let repo = Repository::open(&dev).unwrap();
    assert_eq!(repo.head().unwrap().shorthand(), Some("main"));
}
