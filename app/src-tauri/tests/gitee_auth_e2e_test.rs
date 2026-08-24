//! #249 — Gitee rejects the `x-access-token` Basic-auth username that GitHub
//! and Gitea accept ("remote: The token username invalid", HTTP 403), so every
//! Gitee remote failed regardless of how valid the token was. This drives the
//! real `github_push_inner` against a real Gitee repository to prove the
//! credential callback now authenticates there.
//!
//! `#[ignore]`d — needs network + a Gitee account. Run with:
//!   SOLOMD_GITEE_URL=https://gitee.com/<user>/<repo>.git \
//!   SOLOMD_GITEE_TOKEN=<token> \
//!   cargo test --test gitee_auth_e2e_test -- --ignored --nocapture

use std::fs;
use std::process::Command;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

#[test]
#[ignore]
fn push_to_gitee_authenticates() {
    let (url, token) = match (env("SOLOMD_GITEE_URL"), env("SOLOMD_GITEE_TOKEN")) {
        (Some(u), Some(t)) => (u, t),
        _ => {
            eprintln!("skipped: set SOLOMD_GITEE_URL and SOLOMD_GITEE_TOKEN");
            return;
        }
    };

    let ws = std::env::temp_dir().join(format!("solomd-gitee-e2e-{}", std::process::id()));
    let _ = fs::remove_dir_all(&ws);
    fs::create_dir_all(&ws).unwrap();
    fs::write(ws.join("note.md"), "# from the gitee auth e2e test\n").unwrap();

    let git = |args: &[&str]| {
        let out = Command::new("git").args(args).current_dir(&ws).output().unwrap();
        assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    git(&["config", "user.email", "e2e@example.com"]);
    git(&["config", "user.name", "e2e"]);
    git(&["add", "-A"]);
    git(&["commit", "-qm", "e2e"]);
    // The setup fetch below runs through the SYSTEM git, whose credential
    // helper must not be involved (it may have a stale username cached).
    // Embed the account + token in a throwaway URL for setup only; `origin`
    // is then pointed at the bare URL so the assertion exercises OUR
    // credential callback, not git's helper.
    let owner = url.split('/').nth(3).unwrap_or_default().to_string();
    let auth_url = url.replacen("https://", &format!("https://{}:{}@", owner, token), 1);
    git(&["remote", "add", "origin", &auth_url]);
    // Match whatever the remote already uses so the push is a fast-forward-able
    // ref rather than a new branch on an unrelated history.
    git(&["fetch", "-q", "origin"]);
    git(&["branch", "-M", "master"]);
    git(&["reset", "--soft", "origin/master"]);
    git(&["add", "-A"]);
    git(&["commit", "-qm", "e2e push probe"]);
    git(&["remote", "set-url", "origin", &url]);

    let res = app_lib::github_sync::github_push_inner(
        ws.to_string_lossy().to_string(),
        token,
        Some("e2e: gitee auth probe".to_string()),
    );

    let _ = fs::remove_dir_all(&ws);
    assert!(
        res.is_ok(),
        "push to Gitee must authenticate — got: {:?}",
        res.err()
    );
}
