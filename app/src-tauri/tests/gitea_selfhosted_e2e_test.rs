//! End-to-end test for **self-hosted** Git sync (Gitea / Forgejo) over real
//! HTTP, driving the same `github_push_inner` / `github_pull_inner` entry
//! points the app uses (issue #229, and the merge gate for PR #150).
//!
//! Why this exists alongside `github_sync_e2e_test.rs`: that test uses
//! `file://` remotes, so libgit2's local transport **ignores the credential
//! callback entirely**. Everything about authentication — the part that
//! decides whether a self-hosted user can sync at all — is untested there.
//!
//! The open question this answers: `make_callbacks()` authenticates as
//! `userpass_plaintext("x-access-token", token)`, and `x-access-token` is a
//! GitHub-specific username convention. Does a Gitea/Forgejo server accept it?
//! (It does — Gitea authenticates on the token in the password field and
//! ignores the username. Verified against Gitea 1.27.1; Forgejo is a Gitea
//! fork sharing this auth path.)
//!
//! Ignored by default because it needs a live server. To run it:
//!
//! ```sh
//! gitea web --config <conf>            # or any Gitea/Forgejo instance
//! export SOLOMD_GITEA_URL=http://localhost:3939
//! export SOLOMD_GITEA_USER=solouser
//! export SOLOMD_GITEA_TOKEN=<access token with write:repository>
//! cargo test --test gitea_selfhosted_e2e_test -- --ignored --nocapture
//! ```

use app_lib::github_sync::{github_pull_inner, github_push_inner};
use git2::{Repository, Signature};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

struct Server {
    base: String,
    user: String,
    token: String,
}

impl Server {
    /// Read the instance out of the environment, or skip the test.
    fn from_env() -> Option<Self> {
        Some(Self {
            base: std::env::var("SOLOMD_GITEA_URL").ok()?,
            user: std::env::var("SOLOMD_GITEA_USER").ok()?,
            token: std::env::var("SOLOMD_GITEA_TOKEN").ok()?,
        })
    }

    fn api(&self, method: &str, path: &str, body: Option<&str>) -> (u16, String) {
        let mut cmd = std::process::Command::new("curl");
        cmd.arg("-s")
            .arg("-o")
            .arg("-")
            .arg("-w")
            .arg("\n%{http_code}")
            .arg("-X")
            .arg(method)
            .arg(format!("{}/api/v1{}", self.base, path))
            .arg("-H")
            .arg(format!("Authorization: token {}", self.token));
        if let Some(b) = body {
            cmd.arg("-H")
                .arg("Content-Type: application/json")
                .arg("-d")
                .arg(b);
        }
        let out = cmd.output().expect("curl");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let (body, code) = text.rsplit_once('\n').unwrap_or((text.as_str(), "0"));
        (code.trim().parse().unwrap_or(0), body.to_string())
    }

    /// Delete + recreate the test repo so each test starts from empty.
    fn reset_repo(&self, name: &str) {
        self.api("DELETE", &format!("/repos/{}/{}", self.user, name), None);
        let (code, body) = self.api(
            "POST",
            "/user/repos",
            Some(&json!({ "name": name, "private": true, "auto_init": false }).to_string()),
        );
        assert!(
            (200..300).contains(&code),
            "could not create repo {name}: HTTP {code} {body}"
        );
    }

    /// Clone URL with **no** credentials in it — the credential callback under
    /// test is the only thing that can authenticate this.
    fn clone_url(&self, name: &str) -> String {
        format!("{}/{}/{}.git", self.base, self.user, name)
    }
}

fn fresh_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("solomd-gitea-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn commit_all(repo: &Repository, msg: &str) {
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
        .unwrap();
}

fn init_workspace(label: &str, remote_url: &str, provider: &str) -> PathBuf {
    let ws = fresh_dir(label);
    {
        let repo = Repository::init(&ws).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test").ok();
        cfg.set_str("user.email", "test@local").ok();
        let needs_switch = {
            let head = repo.find_reference("HEAD").unwrap();
            head.symbolic_target() == Some("refs/heads/master")
        };
        if needs_switch {
            repo.reference_symbolic("HEAD", "refs/heads/main", true, "switch to main")
                .unwrap();
        }
        repo.remote("origin", remote_url).unwrap();
    }
    let cfg_dir = ws.join(".solomd");
    fs::create_dir_all(&cfg_dir).unwrap();
    fs::write(
        cfg_dir.join("sync.json"),
        json!({
            "remote_url": remote_url,
            "auto_push": true,
            "auto_pull_minutes": 0,
            "last_push_at": null,
            "last_pull_at": null,
            "provider": provider,
        })
        .to_string(),
    )
    .unwrap();
    fs::write(ws.join(".gitignore"), ".solomd/\n").unwrap();
    ws
}

fn write(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
}

/// Push from device A, pull on device B, over HTTP against a real self-hosted
/// server — i.e. the whole path a ForgeJo/Gitea user actually exercises.
#[test]
#[ignore = "needs a live Gitea/Forgejo instance; see module docs"]
fn gitea_push_pull_roundtrip_over_http() {
    let Some(srv) = Server::from_env() else {
        eprintln!("SOLOMD_GITEA_* not set — skipping");
        return;
    };
    srv.reset_repo("vault");
    let url = srv.clone_url("vault");

    // --- device A: create a note and push it -----------------------------
    let a = init_workspace("device-a", &url, "gitea");
    write(&a.join("note.md"), "# from device A\n");
    {
        let repo = Repository::open(&a).unwrap();
        commit_all(&repo, "note from A");
    }
    github_push_inner(a.to_string_lossy().to_string(), srv.token.clone(), None)
        .expect("push to self-hosted Gitea over HTTP must succeed");

    // --- device B: pull A's note -----------------------------------------
    // B starts with its own init commit (mirrors first-launch AutoGit); a repo
    // with an unborn HEAD has no branch for the merge to stand on.
    let b = init_workspace("device-b", &url, "gitea");
    {
        let repo = Repository::open(&b).unwrap();
        commit_all(&repo, "init: device B");
    }
    github_pull_inner(b.to_string_lossy().to_string(), srv.token.clone())
        .expect("pull from self-hosted Gitea over HTTP must succeed");
    assert!(
        b.join("note.md").exists(),
        "device B should have received note.md"
    );
    assert_eq!(
        fs::read_to_string(b.join("note.md")).unwrap(),
        "# from device A\n"
    );

    // --- round two: B edits, pushes; A pulls it back ---------------------
    write(&b.join("note.md"), "# from device A\nedited on B\n");
    {
        let repo = Repository::open(&b).unwrap();
        commit_all(&repo, "edit from B");
    }
    github_push_inner(b.to_string_lossy().to_string(), srv.token.clone(), None)
        .expect("second push must succeed");
    github_pull_inner(a.to_string_lossy().to_string(), srv.token.clone())
        .expect("A must fast-forward");
    assert_eq!(
        fs::read_to_string(a.join("note.md")).unwrap(),
        "# from device A\nedited on B\n",
        "A should have fast-forwarded to B's edit"
    );
}

/// The credential callback must be the thing doing the work: an invalid token
/// has to fail. Without this, a server with anonymous push enabled would make
/// the roundtrip test above pass while proving nothing about authentication.
#[test]
#[ignore = "needs a live Gitea/Forgejo instance; see module docs"]
fn gitea_push_fails_with_bad_token() {
    let Some(srv) = Server::from_env() else {
        eprintln!("SOLOMD_GITEA_* not set — skipping");
        return;
    };
    srv.reset_repo("vault-auth");
    let url = srv.clone_url("vault-auth");

    let ws = init_workspace("device-bad", &url, "gitea");
    write(&ws.join("note.md"), "# nope\n");
    {
        let repo = Repository::open(&ws).unwrap();
        commit_all(&repo, "note");
    }
    let err = github_push_inner(
        ws.to_string_lossy().to_string(),
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string(),
        None,
    )
    .expect_err("push with an invalid token must NOT succeed");
    eprintln!("bad-token push rejected as expected: {err}");
}
