//! GitHub-backed sync (v2.6).
//!
//! Builds on the v2.2 AutoGit foundation. Where AutoGit gives every save a
//! local commit, this module wires that local repo to a GitHub remote so
//! the same vault can be pushed / pulled from any device the user logs in
//! on.
//!
//! Architecture:
//!   1. User pastes a GitHub Personal Access Token into Settings. We
//!      store it in the OS keychain via the `keyring` crate (same backend
//!      as v2.0 AI keys) under service `solomd-github`.
//!   2. User picks an existing repo or creates a fresh private one
//!      (`github_create_vault_repo`). The remote URL is written into
//!      `<workspace>/.solomd/sync.json` so we can pick up the binding on
//!      relaunch without depending on git's remote config alone.
//!   3. Each save still triggers AutoGit's local commit. After the local
//!      commit lands we optionally `git push` to the remote (the frontend
//!      decides via the `auto_push` setting).
//!   4. A periodic timer on the frontend calls `github_pull` to fetch +
//!      fast-forward. If the remote has diverged we surface a conflict
//!      list rather than auto-merging — the writer-class user is going
//!      to want a side-by-side diff for prose conflicts.
//!
//! Authentication uses HTTPS + PAT, not SSH. PAT is sent via the
//! libgit2 credential callback as basic-auth username `x-access-token`,
//! password = the token. Same shape that GitHub Codespaces uses.
//!
//! Tauri commands exported (registered in `lib.rs` AND `runner.rs` —
//! see the v2.5 lesson about the dual-registration trap):
//!   * `github_set_token` / `github_clear_token` / `github_has_token`
//!   * `github_user` — `/user` API
//!   * `github_list_repos` — `/user/repos` (owner+private)
//!   * `github_create_vault_repo` — `POST /user/repos`
//!   * `github_link_workspace` — write `.solomd/sync.json`, set remote
//!   * `github_unlink_workspace`
//!   * `github_sync_status` — fast read-only summary
//!   * `github_push`
//!   * `github_pull` — fetch + ff-merge, or list conflicts
//!   * `github_resolve_conflict` — for one path: keep local / remote / both

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{AutotagOption, FetchOptions, PushOptions, Repository, Signature};
use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "solomd-github";
const KEYRING_USER: &str = "personal-access-token";
const SYNC_CONFIG_FILE: &str = ".solomd/sync.json";
const GITHUB_API: &str = "https://api.github.com";
const USER_AGENT: &str = "SoloMD-sync/2.6";

// ---------------------------------------------------------------------------
// Token storage (OS keychain via `keyring`)
// ---------------------------------------------------------------------------

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// `~/.solomd/github-token-set` — a non-secret marker file written
/// alongside `github_set_token` and removed by `github_clear_token`.
/// Lets `github_has_token()` answer the "did the user log in?" question
/// WITHOUT touching the OS keychain. macOS's keyring fires a
/// password-prompt on every read — opening Settings was triggering it
/// just to render a green dot. The marker file moves that prompt off
/// the read path; the keychain only gets touched on push / pull (which
/// the user explicitly initiates and where the prompt is meaningful).
fn token_marker_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(std::path::PathBuf::from))
        .map(|h| h.join(".solomd").join("github-token-set"))
}

fn write_token_marker() {
    if let Some(p) = token_marker_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&p, b"1");
    }
}

fn remove_token_marker() {
    if let Some(p) = token_marker_path() {
        let _ = std::fs::remove_file(&p);
    }
}

fn read_token() -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        // `NoEntry` is the "not set yet" path, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn github_set_token(token: String) -> Result<(), String> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return Err("token is empty".into());
    }
    let entry = keyring_entry()?;
    entry.set_password(&trimmed).map_err(|e| e.to_string())?;
    write_token_marker();
    Ok(())
}

#[tauri::command]
pub fn github_clear_token() -> Result<(), String> {
    let entry = keyring_entry()?;
    let r = match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    };
    remove_token_marker();
    r
}

#[tauri::command]
pub fn github_has_token() -> Result<bool, String> {
    // Marker-file check — no keychain access, no macOS password prompt.
    Ok(token_marker_path().map(|p| p.exists()).unwrap_or(false))
}

// ---------------------------------------------------------------------------
// REST API: /user, /user/repos, POST /user/repos
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug)]
pub struct GitHubUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GitHubRepo {
    pub name: String,
    pub full_name: String,
    pub clone_url: String,
    pub private: bool,
    pub default_branch: String,
    pub html_url: String,
    pub updated_at: String,
}

async fn api_get<T: for<'de> Deserialize<'de>>(path: &str, token: &str) -> Result<T, String> {
    let url = format!("{}{}", GITHUB_API, path);
    let res = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub API {}: {}", status, body));
    }
    res.json::<T>().await.map_err(|e| e.to_string())
}

async fn api_post<B: Serialize, T: for<'de> Deserialize<'de>>(
    path: &str,
    token: &str,
    body: &B,
) -> Result<T, String> {
    let url = format!("{}{}", GITHUB_API, path);
    let res = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", USER_AGENT)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub API {}: {}", status, body));
    }
    res.json::<T>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn github_user() -> Result<GitHubUser, String> {
    let token = read_token()?.ok_or("no GitHub token set")?;
    api_get("/user", &token).await
}

#[tauri::command]
pub async fn github_list_repos() -> Result<Vec<GitHubRepo>, String> {
    let token = read_token()?.ok_or("no GitHub token set")?;
    // 100 most-recently-updated owned repos. Plenty for picker UX.
    api_get("/user/repos?per_page=100&sort=updated&affiliation=owner", &token).await
}

#[derive(Serialize)]
struct CreateRepoRequest<'a> {
    name: &'a str,
    private: bool,
    auto_init: bool,
    description: &'a str,
}

#[tauri::command]
pub async fn github_create_vault_repo(name: String, private: bool) -> Result<GitHubRepo, String> {
    let token = read_token()?.ok_or("no GitHub token set")?;
    let req = CreateRepoRequest {
        name: &name,
        private,
        // auto_init=true gives us an initial commit + main branch on the
        // remote, which simplifies the first push. Without it a brand-new
        // vault would have to push --set-upstream into nothing.
        auto_init: true,
        description: "Notes vault — synced by SoloMD",
    };
    api_post("/user/repos", &token, &req).await
}

// ---------------------------------------------------------------------------
// Workspace ↔ remote linking
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SyncConfig {
    pub remote_url: String,
    /// If true, every successful local commit triggers a `git push` to the
    /// remote. Default false so users opt in.
    pub auto_push: bool,
    /// Minutes between background `github_pull` calls. 0 = manual only.
    pub auto_pull_minutes: u32,
    /// Unix epoch seconds.
    pub last_push_at: Option<i64>,
    pub last_pull_at: Option<i64>,
    /// v2.6.3 — when true, push/pull operate on `<workspace>/.solomd-encrypted/`
    /// instead of the workspace itself, and we run encrypt-before-push +
    /// decrypt-after-pull around every sync. Old configs without this
    /// field deserialize to `false`, preserving v2.6.0/v2.6.1 behavior.
    #[serde(default)]
    pub encrypted: bool,
    /// v2.6.3 — provider hint stored for the UI ("github" / "gitlab" /
    /// "gitea" / "custom"). Doesn't change push/pull behaviour;
    /// libgit2 + PAT credentials work uniformly across providers.
    #[serde(default = "default_provider")]
    pub provider: String,
}

fn default_provider() -> String {
    "github".into()
}

const ENCRYPTED_SHADOW: &str = ".solomd-encrypted";

/// Resolve the directory the git repo actually lives in. With E2EE on
/// that's the encrypted shadow; otherwise it's the workspace itself.
fn git_dir(workspace: &Path) -> PathBuf {
    let cfg = load_config(workspace).ok().flatten().unwrap_or_default();
    if cfg.encrypted {
        workspace.join(ENCRYPTED_SHADOW)
    } else {
        workspace.to_path_buf()
    }
}

fn config_path(workspace: &Path) -> PathBuf {
    workspace.join(SYNC_CONFIG_FILE)
}

fn load_config(workspace: &Path) -> Result<Option<SyncConfig>, String> {
    let path = config_path(workspace);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string())
}

fn save_config(workspace: &Path, cfg: &SyncConfig) -> Result<(), String> {
    let path = config_path(workspace);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, body).map_err(|e| e.to_string())
}

/// Ensure `.solomd/` is in the workspace's git ignore list. Each device
/// has its own sync.json (different timestamps, possibly different remote
/// URL across forks), so committing it would produce a conflict on
/// every pull. Idempotent — safe to call before every push.
fn ensure_gitignore_excludes_solomd(workspace: &Path) -> Result<(), String> {
    let gitignore = workspace.join(".gitignore");
    let existing = fs::read_to_string(&gitignore).unwrap_or_default();
    if existing
        .lines()
        .any(|l| l.trim() == ".solomd/" || l.trim() == ".solomd")
    {
        return Ok(());
    }
    let mut new = existing;
    if !new.is_empty() && !new.ends_with('\n') {
        new.push('\n');
    }
    new.push_str("# SoloMD workspace metadata — per-device, do not sync.\n");
    new.push_str(".solomd/\n");
    fs::write(&gitignore, new).map_err(|e| e.to_string())
}

fn open_or_init_repo(workspace: &Path) -> Result<Repository, String> {
    if let Ok(repo) = Repository::open(workspace) {
        return Ok(repo);
    }
    // First link — initialize the repo so the user doesn't have to do it
    // manually. AutoGit usually beats us to this, but defending against
    // the case where AutoGit was off when sync was set up.
    Repository::init(workspace).map_err(|e| format!("git init failed: {}", e))
}

#[tauri::command]
pub async fn github_link_workspace(
    folder: String,
    remote_url: String,
    encrypted: Option<bool>,
    provider: Option<String>,
) -> Result<SyncConfig, String> {
    if folder.is_empty() || remote_url.is_empty() {
        return Err("folder and remote_url are required".into());
    }
    let encrypted = encrypted.unwrap_or(false);
    let provider = provider.unwrap_or_else(default_provider);
    tauri::async_runtime::spawn_blocking(move || -> Result<SyncConfig, String> {
        let path = PathBuf::from(&folder);
        // The git repo lives in the shadow when E2EE is on, otherwise in
        // the workspace itself. The init also creates the shadow dir on
        // demand so the first push has somewhere to mirror into.
        let repo_dir = if encrypted {
            let s = path.join(ENCRYPTED_SHADOW);
            fs::create_dir_all(&s).map_err(|e| e.to_string())?;
            s
        } else {
            path.clone()
        };
        let repo = open_or_init_repo(&repo_dir)?;
        if repo.find_remote("origin").is_ok() {
            repo.remote_delete("origin").map_err(|e| e.to_string())?;
        }
        repo.remote("origin", &remote_url).map_err(|e| e.to_string())?;

        let cfg = SyncConfig {
            remote_url: remote_url.clone(),
            auto_push: true,
            auto_pull_minutes: 5,
            last_push_at: None,
            last_pull_at: None,
            encrypted,
            provider,
        };
        save_config(&path, &cfg)?;
        // .solomd/ holds per-device state — never committed.
        // .solomd-encrypted/ is the shadow git repo when E2EE is on —
        // never committed into the workspace's own (optional AutoGit)
        // history, otherwise a local AutoGit pass would scoop up the
        // ciphertext mirror as duplicate noise.
        ensure_gitignore_excludes_solomd(&path)?;
        Ok(cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Update `auto_push` and `auto_pull_minutes` without re-linking. Used by
/// the Settings UI when the user flips the toggles. Preserves
/// `last_push_at` / `last_pull_at` so the "last synced N min ago" label
/// doesn't reset.
#[tauri::command]
pub async fn github_set_config(
    folder: String,
    auto_push: bool,
    auto_pull_minutes: u32,
) -> Result<SyncConfig, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SyncConfig, String> {
        let path = PathBuf::from(&folder);
        let mut cfg = load_config(&path)?
            .ok_or("workspace not linked")?;
        cfg.auto_push = auto_push;
        cfg.auto_pull_minutes = auto_pull_minutes;
        save_config(&path, &cfg)?;
        Ok(cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_unlink_workspace(folder: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = PathBuf::from(&folder);
        let repo_dir = git_dir(&path);
        if let Ok(repo) = Repository::open(&repo_dir) {
            let _ = repo.remote_delete("origin");
        }
        let cfg_path = config_path(&path);
        if cfg_path.exists() {
            fs::remove_file(cfg_path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Status, push, pull
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct SyncStatus {
    pub linked: bool,
    pub remote_url: String,
    pub auto_push: bool,
    pub auto_pull_minutes: u32,
    pub encrypted: bool,
    pub provider: String,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: bool,
    pub has_conflicts: bool,
    pub conflicts: Vec<String>,
    pub last_push_at: Option<i64>,
    pub last_pull_at: Option<i64>,
}

#[tauri::command]
pub async fn github_sync_status(folder: String) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SyncStatus, String> {
        let path = PathBuf::from(&folder);
        let cfg = load_config(&path)?.unwrap_or_default();
        let mut status = SyncStatus {
            linked: !cfg.remote_url.is_empty(),
            remote_url: cfg.remote_url.clone(),
            auto_push: cfg.auto_push,
            auto_pull_minutes: cfg.auto_pull_minutes,
            encrypted: cfg.encrypted,
            provider: cfg.provider.clone(),
            last_push_at: cfg.last_push_at,
            last_pull_at: cfg.last_pull_at,
            ..Default::default()
        };
        if !status.linked {
            return Ok(status);
        }
        let repo_dir = git_dir(&path);
        let repo = match Repository::open(&repo_dir) {
            Ok(r) => r,
            // Repo was deleted but config remained — degrade gracefully
            // rather than 500-ing the entire UI.
            Err(_) => return Ok(status),
        };

        // Dirty = uncommitted working-tree changes.
        if let Ok(statuses) = repo.statuses(None) {
            status.dirty = statuses
                .iter()
                .any(|e| !e.status().is_ignored() && !e.status().is_empty());
        }

        // Ahead / behind counts vs origin/<head>. Quietly skip if origin
        // hasn't been fetched yet.
        if let (Ok(local), Ok(upstream)) = (
            repo.head().and_then(|h| h.peel_to_commit()),
            repo.find_branch("origin/main", git2::BranchType::Remote)
                .or_else(|_| repo.find_branch("origin/master", git2::BranchType::Remote))
                .and_then(|b| b.get().peel_to_commit()),
        ) {
            if let Ok((a, b)) = repo.graph_ahead_behind(local.id(), upstream.id()) {
                status.ahead = a;
                status.behind = b;
            }
        }

        // Surface any unresolved conflicts (paths with merge markers).
        if let Ok(index) = repo.index() {
            if index.has_conflicts() {
                status.has_conflicts = true;
                status.conflicts = index
                    .conflicts()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c.ok())
                    .filter_map(|c| {
                        c.our
                            .as_ref()
                            .or(c.their.as_ref())
                            .or(c.ancestor.as_ref())
                            .map(|e| String::from_utf8_lossy(&e.path).to_string())
                    })
                    .collect();
            }
        }

        Ok(status)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Build credential + push/fetch options that authenticate over HTTPS using
/// our PAT. Same shape used by `gh-cli` / GitHub Codespaces.
fn make_callbacks(token: String) -> git2::RemoteCallbacks<'static> {
    let mut cb = git2::RemoteCallbacks::new();
    cb.credentials(move |_url, _username, _allowed| {
        // GitHub accepts the PAT as the password with literal username
        // "x-access-token" — works regardless of the user's GH login.
        git2::Cred::userpass_plaintext("x-access-token", &token)
    });
    cb
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// In a repo, stage every change in the working tree and commit. No-op
/// if there's nothing to commit. Used by E2EE push/pull to keep the
/// shadow's git history advancing as the user edits the workspace.
fn commit_shadow_if_dirty(repo_dir: &Path, message: &str) -> Result<(), String> {
    let repo = Repository::open(repo_dir).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(ref p) = parent_commit {
        if p.tree_id() == tree_oid {
            return Ok(()); // nothing to do
        }
    }
    let sig = signature(&repo)?;
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sync core for push — exposed so integration tests can drive it
/// against a `file://` remote without touching the OS keychain.
///
/// When E2EE is enabled, this runs `crypto_encrypt_for_push` first so
/// the shadow dir holds fresh ciphertext, then commits and pushes from
/// the shadow's git repo. Plaintext never reaches the remote.
pub fn github_push_inner(folder: String, token: String) -> Result<(), String> {
    let path = PathBuf::from(&folder);
    let cfg = load_config(&path).ok().flatten().unwrap_or_default();
    let repo_dir = git_dir(&path);
    if cfg.encrypted {
        super::crypto::crypto_encrypt_for_push(folder.clone())?;
        commit_shadow_if_dirty(&repo_dir, "encrypted: workspace state at push")?;
    }
    let repo = Repository::open(&repo_dir).map_err(|e| e.to_string())?;
    let mut origin = repo.find_remote("origin").map_err(|e| e.to_string())?;

    // Push the current HEAD branch's local ref to the same ref name on
    // the remote. We don't bother with refspec parsing — most users
    // are on `main` and only ever push `main`.
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .ok_or_else(|| "HEAD is detached; cannot push".to_string())?;
    let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch_name);

    let mut opts = PushOptions::new();
    opts.remote_callbacks(make_callbacks(token));
    origin
        .push(&[refspec.as_str()], Some(&mut opts))
        .map_err(|e| format!("push failed: {}", e))?;

    // Stamp the config with the last successful push.
    if let Ok(Some(mut cfg)) = load_config(&path) {
        cfg.last_push_at = Some(now_secs());
        let _ = save_config(&path, &cfg);
    }
    Ok(())
}

#[tauri::command]
pub async fn github_push(folder: String) -> Result<(), String> {
    let token = read_token()?.ok_or("no GitHub token set")?;
    tauri::async_runtime::spawn_blocking(move || github_push_inner(folder, token))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct PullResult {
    /// "fast_forward" | "up_to_date" | "conflicts"
    pub kind: String,
    pub conflicts: Vec<String>,
}

/// Sync core for pull — exposed for integration tests.
///
/// When E2EE is enabled, this fetches/merges into the shadow dir as
/// usual and then runs `crypto_decrypt_after_pull` so the user's
/// plaintext working tree picks up remote edits.
pub fn github_pull_inner(folder: String, token: String) -> Result<PullResult, String> {
    let workspace = PathBuf::from(&folder);
    let cfg = load_config(&workspace).ok().flatten().unwrap_or_default();
    let path = git_dir(&workspace);
    // PR #24 file-watcher integration: a successful pull legitimately
    // rewrites many files. Open a 30s rewrite window so the watcher
    // doesn't pop the "external change" dialog for every file.
    super::watcher::mark_workspace_rewrite_window(&workspace);
    if cfg.encrypted {
        // First-pull bootstrap: when the user has linked an encrypted
        // remote but not yet entered the passphrase on this device,
        // skip the encrypt-then-commit step. The fetch+merge can still
        // happen — that's how the device learns the salt + ciphertext.
        // Decrypt is also skipped (see finalize_decrypt); the user
        // sets the passphrase, then we decrypt explicitly.
        if super::crypto::crypto_encrypt_for_push(folder.clone()).is_ok() {
            commit_shadow_if_dirty(&path, "encrypted: workspace state at pull")?;
        }
    }
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        let head = repo.head().map_err(|e| e.to_string())?;
        let branch_name = head
            .shorthand()
            .ok_or_else(|| "HEAD is detached; cannot pull".to_string())?
            .to_string();

        // 1) Fetch.
        let mut origin = repo.find_remote("origin").map_err(|e| e.to_string())?;
        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(make_callbacks(token));
        fetch_opts.download_tags(AutotagOption::All);
        origin
            .fetch(&[&branch_name], Some(&mut fetch_opts), None)
            .map_err(|e| format!("fetch failed: {}", e))?;

        // 2) Look up the upstream ref we just fetched.
        let upstream_ref = repo
            .find_reference(&format!("refs/remotes/origin/{}", branch_name))
            .map_err(|e| e.to_string())?;
        let upstream_commit = repo
            .reference_to_annotated_commit(&upstream_ref)
            .map_err(|e| e.to_string())?;

        // 3) Decide what to do.
        let analysis = repo
            .merge_analysis(&[&upstream_commit])
            .map_err(|e| e.to_string())?;

        if analysis.0.is_up_to_date() {
            stamp_pull(&workspace);
            // No remote changes to decrypt back, but if E2EE is on and the
            // workspace had local edits we just committed in the shadow,
            // they're already in the shadow — no action needed.
            return Ok(PullResult {
                kind: "up_to_date".into(),
                conflicts: vec![],
            });
        }

        if analysis.0.is_fast_forward() {
            // FF: move HEAD to the upstream commit and check out the tree.
            let mut head_ref = repo
                .find_reference(&format!("refs/heads/{}", branch_name))
                .map_err(|e| e.to_string())?;
            let upstream_oid = upstream_commit.id();
            head_ref
                .set_target(upstream_oid, "fast-forward via SoloMD GitHub sync")
                .map_err(|e| e.to_string())?;
            repo.set_head(&format!("refs/heads/{}", branch_name))
                .map_err(|e| e.to_string())?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .map_err(|e| e.to_string())?;
            stamp_pull(&workspace);
            finalize_decrypt(&cfg, &workspace)?;
            return Ok(PullResult {
                kind: "fast_forward".into(),
                conflicts: vec![],
            });
        }

        // Diverged: try a normal merge. If it produces conflicts we
        // surface the list and stop — the writer-class user wants a UI,
        // not a bare merge marker file.
        let local_commit = repo
            .reference_to_annotated_commit(&head)
            .map_err(|e| e.to_string())?;
        repo.merge(&[&upstream_commit], None, None)
            .map_err(|e| format!("merge failed: {}", e))?;

        let mut index = repo.index().map_err(|e| e.to_string())?;
        if index.has_conflicts() {
            let conflicts: Vec<String> = index
                .conflicts()
                .into_iter()
                .flatten()
                .filter_map(|c| c.ok())
                .filter_map(|c| {
                    c.our
                        .as_ref()
                        .or(c.their.as_ref())
                        .or(c.ancestor.as_ref())
                        .map(|e| String::from_utf8_lossy(&e.path).to_string())
                })
                .collect();
            return Ok(PullResult {
                kind: "conflicts".into(),
                conflicts,
            });
        }

        // No conflicts — write the merge commit ourselves.
        let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
        let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
        let local = repo
            .find_commit(local_commit.id())
            .map_err(|e| e.to_string())?;
        let upstream_real = repo
            .find_commit(upstream_commit.id())
            .map_err(|e| e.to_string())?;
        let sig = signature(&repo)?;
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("Merge branch 'origin/{}' into {}", branch_name, branch_name),
            &tree,
            &[&local, &upstream_real],
        )
        .map_err(|e| e.to_string())?;
    repo.cleanup_state().map_err(|e| e.to_string())?;
    stamp_pull(&workspace);
    finalize_decrypt(&cfg, &workspace)?;
    Ok(PullResult {
        kind: "merged".into(),
        conflicts: vec![],
    })
}

/// On every clean (non-conflicting) pull, mirror the freshly-fetched
/// shadow back to plaintext if E2EE is on. No-op for non-encrypted
/// vaults. Conflict path skips this — the user resolves on the shadow
/// side first.
fn finalize_decrypt(cfg: &SyncConfig, workspace: &Path) -> Result<(), String> {
    if !cfg.encrypted {
        return Ok(());
    }
    // Bootstrap-tolerant: if the key isn't in the keyring yet (a
    // brand-new device that just pulled), don't fail the pull —
    // surface a soft-OK and let the frontend prompt for passphrase
    // post-pull, then call crypto_decrypt_after_pull explicitly.
    match super::crypto::crypto_decrypt_after_pull(workspace.to_string_lossy().into_owned()) {
        Ok(()) => Ok(()),
        Err(e) if e.contains("key missing") || e.contains("not enabled") => Ok(()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn github_pull(folder: String) -> Result<PullResult, String> {
    let token = read_token()?.ok_or("no GitHub token set")?;
    tauri::async_runtime::spawn_blocking(move || github_pull_inner(folder, token))
        .await
        .map_err(|e| e.to_string())?
}

fn stamp_pull(workspace: &Path) {
    if let Ok(Some(mut cfg)) = load_config(workspace) {
        cfg.last_pull_at = Some(now_secs());
        let _ = save_config(workspace, &cfg);
    }
}

fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig.to_owned());
    }
    Signature::now("SoloMD", "solomd@local").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn github_resolve_conflict(
    folder: String,
    file: String,
    choice: String, // "local" | "remote" | "both"
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = PathBuf::from(&folder);
        let repo = Repository::open(&path).map_err(|e| e.to_string())?;
        let mut index = repo.index().map_err(|e| e.to_string())?;
        if !index.has_conflicts() {
            return Ok(());
        }
        let abs = path.join(&file);

        // Find the conflict entry for this path.
        let conflicts = index.conflicts().map_err(|e| e.to_string())?;
        let mut found_ours: Option<git2::IndexEntry> = None;
        let mut found_theirs: Option<git2::IndexEntry> = None;
        for c in conflicts {
            let c = c.map_err(|e| e.to_string())?;
            let p = c
                .our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .map(|e| String::from_utf8_lossy(&e.path).to_string())
                .unwrap_or_default();
            if p == file {
                found_ours = c.our;
                found_theirs = c.their;
                break;
            }
        }

        match choice.as_str() {
            "local" => {
                if let Some(ours) = found_ours {
                    let blob = repo.find_blob(ours.id).map_err(|e| e.to_string())?;
                    fs::write(&abs, blob.content()).map_err(|e| e.to_string())?;
                }
            }
            "remote" => {
                if let Some(theirs) = found_theirs {
                    let blob = repo.find_blob(theirs.id).map_err(|e| e.to_string())?;
                    fs::write(&abs, blob.content()).map_err(|e| e.to_string())?;
                }
            }
            "both" => {
                // Keep local AS-IS, write remote alongside as `<name>.remote-<date>.md`.
                if let Some(theirs) = found_theirs {
                    let blob = repo.find_blob(theirs.id).map_err(|e| e.to_string())?;
                    let stem = abs.file_stem().and_then(|s| s.to_str()).unwrap_or("note");
                    let ext = abs
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| format!(".{}", s))
                        .unwrap_or_default();
                    let now = chrono_like_date();
                    let neighbor = abs.with_file_name(format!("{}.remote-{}{}", stem, now, ext));
                    fs::write(&neighbor, blob.content()).map_err(|e| e.to_string())?;
                }
            }
            _ => return Err(format!("unknown choice: {}", choice)),
        }

        // Mark resolved + stage the chosen content.
        index.remove_path(Path::new(&file)).ok();
        index
            .add_path(Path::new(&file))
            .map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tiny date stamp without pulling a chrono dep — `2026-04-27`.
fn chrono_like_date() -> String {
    let secs = now_secs();
    // 1970-01-01 + secs / 86400 days. Crude but good enough for filenames.
    let days = secs / 86_400;
    let (y, m, d) = epoch_days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Civil-from-days, Howard Hinnant's algorithm. Public domain.
fn epoch_days_to_ymd(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}
