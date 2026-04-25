//! Tool definitions for solomd-dev-mcp.
//!
//! Tools roughly mirror the user-facing GUI flow:
//!
//!   * `solomd_get_settings` / `solomd_set_setting` — read/write
//!     localStorage settings (autoGitEnabled, aiEnabled, etc.).
//!   * `solomd_get_workspace` / `solomd_set_workspace` — read/write the
//!     currentFolder. Must be called while SoloMD is closed (WebKit
//!     holds the SQLite open).
//!   * `solomd_get_tabs` / `solomd_set_tabs` — read/write the open-tabs
//!     state.
//!   * `solomd_git_status|init|commit|log|rollback|file_at` —
//!     functional equivalents of the seven `git_history` Tauri commands
//!     in app/src-tauri. Drives the same backend logic the GUI uses.
//!   * `solomd_read_file` / `solomd_write_file` — convenience for
//!     verifying disk state.
//!   * `solomd_screenshot` — full-screen `screencapture -x` to a temp
//!     file. Path returned for the caller to read.
//!   * `solomd_app_status` — list running SoloMD processes (dev vs
//!     installed) so the caller knows which build it's testing against.
//!
//! All git operations are implemented inline in this crate (small,
//! self-contained re-implementations of `app/src-tauri/src/git_history.rs`)
//! rather than path-deping the Tauri crate, which pulls in a massive
//! transitive graph (tauri runtime, plugins, etc.) we don't need here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use git2::{
    Commit, DiffOptions, IndexAddOption, Oid, Repository, Signature, Sort, StatusOptions,
};
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, Implementation, ServerCapabilities, ServerInfo},
    schemars::{self, JsonSchema},
    tool, tool_handler, tool_router,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::process::Command as AsyncCommand;

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct DevServer {
    _inner: Arc<()>,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl DevServer {
    pub fn new() -> Self {
        Self {
            _inner: Arc::new(()),
            tool_router: Self::tool_router(),
        }
    }
}

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

/// WebKit stores LocalStorage values as UTF-16 LE inside a SQLite blob.
fn ls_path(bundle: &str) -> Result<PathBuf> {
    let home = std::env::var("HOME").context("HOME not set")?;
    let (folder, hash) = match bundle {
        "dev" => (
            "solomd",
            "y_a-QbuPa1QmlFcuFGdl2gs24bBFFTCBTT8ilCLEsu0",
        ),
        "prod" => (
            "app.solomd",
            "bvB3gbOLx5VDrjmfAOI5KBKeMsCcGefh6CxQA9MFkBM",
        ),
        other => return Err(anyhow!("unknown bundle: {other} (use dev or prod)")),
    };
    let p = PathBuf::from(home)
        .join("Library/WebKit")
        .join(folder)
        .join("WebsiteData/Default")
        .join(hash)
        .join(hash)
        .join("LocalStorage/localstorage.sqlite3");
    if !p.exists() {
        return Err(anyhow!("no LocalStorage at {}", p.display()));
    }
    Ok(p)
}

fn ls_get(bundle: &str, key: &str) -> Result<JsonValue> {
    let path = ls_path(bundle)?;
    let conn = Connection::open(&path)?;
    let raw: Option<Vec<u8>> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?",
            [key],
            |r| r.get(0),
        )
        .ok();
    match raw {
        None => Ok(JsonValue::Null),
        Some(bytes) => {
            let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes);
            Ok(serde_json::from_str(&text)?)
        }
    }
}

fn ls_put(bundle: &str, key: &str, value: &JsonValue) -> Result<()> {
    let path = ls_path(bundle)?;
    let json = serde_json::to_string(value)?;
    let (utf16, _, _) = encoding_rs::UTF_16LE.encode(&json);
    let conn = Connection::open(&path)?;
    let updated = conn.execute(
        "UPDATE ItemTable SET value = ? WHERE key = ?",
        rusqlite::params![&utf16[..], key],
    )?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO ItemTable(key, value) VALUES(?, ?)",
            rusqlite::params![key, &utf16[..]],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// git2 helpers — mirror app/src-tauri/src/git_history.rs
// ---------------------------------------------------------------------------

fn open_repo(folder: &str) -> Result<Repository> {
    Repository::open(Path::new(folder)).map_err(|e| anyhow!("git open failed: {e}"))
}

fn build_signature(repo: &Repository) -> Result<Signature<'static>> {
    let cfg = repo.config()?;
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
    Signature::now(&name, &email).map_err(Into::into)
}

fn rel_path(repo: &Repository, abs: &str) -> Option<String> {
    let workdir = repo.workdir()?;
    let abs_path = Path::new(abs);
    if let Ok(stripped) = abs_path.strip_prefix(workdir) {
        return Some(stripped.to_string_lossy().replace('\\', "/"));
    }
    let abs_canon = match abs_path.parent().and_then(|p| p.canonicalize().ok()) {
        Some(parent) => parent.join(abs_path.file_name()?),
        None => abs_path.canonicalize().ok()?,
    };
    let workdir_canon = workdir.canonicalize().ok()?;
    let stripped = abs_canon.strip_prefix(&workdir_canon).ok()?;
    Some(stripped.to_string_lossy().replace('\\', "/"))
}

fn stage(repo: &Repository, pathspec: Option<&str>) -> Result<()> {
    let mut index = repo.index()?;
    if let Some(rel) = pathspec {
        index.update_all([rel].iter(), None).ok();
        if let Some(workdir) = repo.workdir() {
            if workdir.join(rel).exists() {
                index.add_path(Path::new(rel))?;
            }
        }
    } else {
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    }
    index.write()?;
    Ok(())
}

fn commit_staged(
    repo: &Repository,
    sig: &Signature<'_>,
    message: &str,
) -> Result<Option<String>> {
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let parents: Vec<Commit<'_>> = match repo.head() {
        Ok(head) => {
            let oid = head.target().ok_or_else(|| anyhow!("head has no target"))?;
            let parent = repo.find_commit(oid)?;
            if parent.tree_id() == tree_oid {
                return Ok(None);
            }
            vec![parent]
        }
        Err(_) => vec![],
    };
    let parent_refs: Vec<&Commit<'_>> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), sig, sig, message, &tree, &parent_refs)?;
    Ok(Some(oid.to_string()))
}

#[derive(Serialize)]
struct CommitInfo {
    sha: String,
    short_sha: String,
    message: String,
    author: String,
    time: i64,
}

fn commit_info(c: &Commit<'_>) -> CommitInfo {
    let sha = c.id().to_string();
    CommitInfo {
        short_sha: sha[..7.min(sha.len())].to_string(),
        sha,
        message: c.summary().unwrap_or("").to_string(),
        author: c.author().name().unwrap_or("?").to_string(),
        time: c.author().when().seconds(),
    }
}

// ---------------------------------------------------------------------------
// Tool argument structs
// ---------------------------------------------------------------------------

fn default_bundle() -> String { "dev".into() }

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct BundleArgs {
    /// `dev` (default) for `pnpm tauri dev`, `prod` for the installed dmg.
    #[serde(default = "default_bundle")]
    pub bundle: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetSettingArgs {
    #[serde(default = "default_bundle")]
    pub bundle: String,
    /// settings.v1 key, e.g. `autoGitEnabled`, `aiProvider`.
    pub key: String,
    /// JSON-typed value. true | false | "string" | 42, etc.
    pub value: JsonValue,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetWorkspaceArgs {
    #[serde(default = "default_bundle")]
    pub bundle: String,
    /// Absolute path to set as currentFolder.
    pub folder: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetTabsArgs {
    #[serde(default = "default_bundle")]
    pub bundle: String,
    /// Single open tab. (For now we only support a single-tab setup; extend if needed.)
    pub file_path: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitFolderArgs {
    /// Absolute workspace folder path.
    pub folder: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitCommitArgs {
    pub folder: String,
    /// Optional absolute file path; if set, only stage that file.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Optional commit message; if absent, uses an auto timestamp message.
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitFileArgs {
    pub folder: String,
    pub file_path: String,
    /// Limit. 0 = default 50.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GitFileShaArgs {
    pub folder: String,
    pub file_path: String,
    pub sha: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct PathArgs { pub path: String }

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct WriteFileArgs { pub path: String, pub content: String }

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct EmptyArgs {}

// ---------------------------------------------------------------------------
// Tool router
// ---------------------------------------------------------------------------

#[tool_router]
impl DevServer {
    #[tool(description = "Read SoloMD's persisted settings (settings.v1) from WebKit LocalStorage. Args: { bundle?: 'dev'|'prod' = 'dev' }.")]
    pub async fn solomd_get_settings(
        &self,
        Parameters(args): Parameters<BundleArgs>,
    ) -> Result<CallToolResult, McpError> {
        let v = ls_get(&args.bundle, "solomd.settings.v1")
            .map_err(|e| err(format!("get_settings failed: {e}")))?;
        Ok(json_result(v))
    }

    #[tool(description = "Set a single key in SoloMD's settings.v1. SoloMD must be CLOSED (WebKit holds the SQLite). Args: { bundle?, key, value }.")]
    pub async fn solomd_set_setting(
        &self,
        Parameters(args): Parameters<SetSettingArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut current = ls_get(&args.bundle, "solomd.settings.v1")
            .map_err(|e| err(format!("read settings: {e}")))?;
        if !current.is_object() { current = JsonValue::Object(Default::default()); }
        if let Some(obj) = current.as_object_mut() {
            obj.insert(args.key.clone(), args.value.clone());
        }
        ls_put(&args.bundle, "solomd.settings.v1", &current)
            .map_err(|e| err(format!("write settings: {e}")))?;
        Ok(text_result(format!("set {} = {}", args.key, args.value)))
    }

    #[tool(description = "Read SoloMD's workspace state (currentFolder, recentFiles).")]
    pub async fn solomd_get_workspace(
        &self,
        Parameters(args): Parameters<BundleArgs>,
    ) -> Result<CallToolResult, McpError> {
        let v = ls_get(&args.bundle, "solomd.workspace.v1")
            .map_err(|e| err(format!("get_workspace: {e}")))?;
        Ok(json_result(v))
    }

    #[tool(description = "Set SoloMD's currentFolder. SoloMD must be CLOSED. Args: { bundle?, folder }.")]
    pub async fn solomd_set_workspace(
        &self,
        Parameters(args): Parameters<SetWorkspaceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut ws = ls_get(&args.bundle, "solomd.workspace.v1")
            .unwrap_or(JsonValue::Object(Default::default()));
        if !ws.is_object() { ws = JsonValue::Object(Default::default()); }
        if let Some(obj) = ws.as_object_mut() {
            obj.insert("currentFolder".into(), JsonValue::String(args.folder.clone()));
        }
        ls_put(&args.bundle, "solomd.workspace.v1", &ws)
            .map_err(|e| err(format!("write workspace: {e}")))?;
        Ok(text_result(format!("workspace.currentFolder = {}", args.folder)))
    }

    #[tool(description = "Read SoloMD's tabs state (open tabs + activeTabId).")]
    pub async fn solomd_get_tabs(
        &self,
        Parameters(args): Parameters<BundleArgs>,
    ) -> Result<CallToolResult, McpError> {
        let v = ls_get(&args.bundle, "solomd.tabs.v1")
            .map_err(|e| err(format!("get_tabs: {e}")))?;
        Ok(json_result(v))
    }

    #[tool(description = "Replace SoloMD's tabs state with a single open tab pointing at the given file. SoloMD must be CLOSED. Args: { bundle?, file_path }.")]
    pub async fn solomd_set_tabs(
        &self,
        Parameters(args): Parameters<SetTabsArgs>,
    ) -> Result<CallToolResult, McpError> {
        let content = std::fs::read_to_string(&args.file_path)
            .map_err(|e| err(format!("read file: {e}")))?;
        let id = format!("tab-dev-{}", chrono_secs());
        let tab = serde_json::json!({
            "id": id,
            "filePath": args.file_path,
            "title": Path::new(&args.file_path).file_name().and_then(|s| s.to_str()).unwrap_or("note.md"),
            "content": content,
            "savedContent": content,
            "language": "markdown",
            "cursorLine": 1, "cursorCol": 1,
        });
        let v = serde_json::json!({ "tabs": [tab], "activeTabId": id });
        ls_put(&args.bundle, "solomd.tabs.v1", &v)
            .map_err(|e| err(format!("write tabs: {e}")))?;
        Ok(text_result(format!("active tab -> {}", args.file_path)))
    }

    #[tool(description = "Run git_workspace_status against a folder (initialized? head_sha? dirty?).")]
    pub async fn solomd_git_status(
        &self,
        Parameters(args): Parameters<GitFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let folder = args.folder;
        let repo = match Repository::open(Path::new(&folder)) {
            Ok(r) => r,
            Err(_) => {
                return Ok(json_result(serde_json::json!({
                    "initialized": false, "head_sha": null, "branch": null, "dirty": false,
                })));
            }
        };
        let head_sha = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
        let head_msg = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).and_then(|c| c.summary().map(String::from));
        let branch = repo.head().ok().and_then(|h| h.shorthand().map(String::from));
        let dirty = {
            let mut opts = StatusOptions::new();
            opts.include_untracked(true).recurse_untracked_dirs(true);
            repo.statuses(Some(&mut opts))
                .map(|s| s.iter().any(|e| {
                    let p = e.path().unwrap_or("").to_lowercase();
                    (p.ends_with(".md") || p.ends_with(".markdown") || p.ends_with(".txt"))
                        && !e.status().is_empty()
                }))
                .unwrap_or(false)
        };
        Ok(json_result(serde_json::json!({
            "initialized": true,
            "head_sha": head_sha,
            "head_message": head_msg,
            "branch": branch,
            "dirty": dirty,
        })))
    }

    #[tool(description = "Initialize a folder as a git repo and make an initial commit. Args: { folder }.")]
    pub async fn solomd_git_init(
        &self,
        Parameters(args): Parameters<GitFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let path = Path::new(&args.folder);
        if !path.exists() { return Err(err(format!("no such folder: {}", args.folder))); }
        let repo = Repository::open(path).or_else(|_| Repository::init(path))
            .map_err(|e| err(format!("init: {e}")))?;
        // Default .gitignore
        let gi = path.join(".gitignore");
        if !gi.exists() {
            let _ = std::fs::write(&gi, ".DS_Store\nThumbs.db\nnode_modules/\n");
        }
        stage(&repo, None).map_err(|e| err(e.to_string()))?;
        let sig = build_signature(&repo).map_err(|e| err(e.to_string()))?;
        let sha = commit_staged(&repo, &sig, "init: SoloMD workspace")
            .map_err(|e| err(e.to_string()))?
            .unwrap_or_default();
        Ok(text_result(format!("init ok (sha: {})", sha)))
    }

    #[tool(description = "Run git_auto_commit. Stages and commits. Returns the new sha or null if tree unchanged. Args: { folder, file_path?, message? }.")]
    pub async fn solomd_git_commit(
        &self,
        Parameters(args): Parameters<GitCommitArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = open_repo(&args.folder).map_err(|e| err(e.to_string()))?;
        let pathspec = match args.file_path.as_ref() {
            Some(abs) => match rel_path(&repo, abs) {
                Some(r) => Some(r),
                None => return Err(err(format!("file outside workspace: {}", abs))),
            },
            None => None,
        };
        stage(&repo, pathspec.as_deref()).map_err(|e| err(e.to_string()))?;
        let sig = build_signature(&repo).map_err(|e| err(e.to_string()))?;
        let msg = args.message.unwrap_or_else(|| format!("auto: dev-mcp {}", chrono_secs()));
        let sha = commit_staged(&repo, &sig, &msg).map_err(|e| err(e.to_string()))?;
        Ok(json_result(serde_json::json!({ "sha": sha })))
    }

    #[tool(description = "List commits that touched a single file, newest first. Args: { folder, file_path, limit? }.")]
    pub async fn solomd_git_log(
        &self,
        Parameters(args): Parameters<GitFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = open_repo(&args.folder).map_err(|e| err(e.to_string()))?;
        let rel = rel_path(&repo, &args.file_path)
            .ok_or_else(|| err(format!("file outside workspace: {}", args.file_path)))?;
        let head_oid = match repo.head().ok().and_then(|h| h.target()) {
            Some(o) => o,
            None => return Ok(json_result(serde_json::json!([]))),
        };
        let mut walk = repo.revwalk().map_err(|e| err(e.to_string()))?;
        walk.set_sorting(Sort::TIME).ok();
        walk.push(head_oid).map_err(|e| err(e.to_string()))?;
        let cap = args.limit.unwrap_or(50).max(1) as usize;
        let mut out: Vec<CommitInfo> = Vec::with_capacity(cap);
        for oid in walk {
            let oid = match oid { Ok(o) => o, Err(_) => continue };
            let commit = match repo.find_commit(oid) { Ok(c) => c, Err(_) => continue };
            // Did this commit touch `rel`?
            let tree = match commit.tree() { Ok(t) => t, Err(_) => continue };
            let touches = if commit.parent_count() == 0 {
                tree.get_path(Path::new(&rel)).is_ok()
            } else {
                let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
                let mut opts = DiffOptions::new();
                opts.pathspec(&rel);
                repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
                    .map(|d| d.deltas().len() > 0).unwrap_or(false)
            };
            if !touches { continue; }
            out.push(commit_info(&commit));
            if out.len() >= cap { break; }
        }
        Ok(json_result(serde_json::to_value(&out).unwrap()))
    }

    #[tool(description = "Read a file's content at a specific commit (without modifying disk). Args: { folder, file_path, sha }.")]
    pub async fn solomd_git_file_at(
        &self,
        Parameters(args): Parameters<GitFileShaArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = open_repo(&args.folder).map_err(|e| err(e.to_string()))?;
        let rel = rel_path(&repo, &args.file_path)
            .ok_or_else(|| err(format!("file outside workspace: {}", args.file_path)))?;
        let oid = Oid::from_str(&args.sha).map_err(|e| err(format!("bad sha: {e}")))?;
        let commit = repo.find_commit(oid).map_err(|e| err(e.to_string()))?;
        let tree = commit.tree().map_err(|e| err(e.to_string()))?;
        let entry = tree.get_path(Path::new(&rel))
            .map_err(|e| err(format!("not in commit: {e}")))?;
        let object = entry.to_object(&repo).map_err(|e| err(e.to_string()))?;
        let blob = object.as_blob().ok_or_else(|| err("not a blob"))?;
        let content = String::from_utf8_lossy(blob.content()).to_string();
        Ok(text_result(content))
    }

    #[tool(description = "Roll back a single file's working-copy content to a specific commit. Args: { folder, file_path, sha }.")]
    pub async fn solomd_git_rollback(
        &self,
        Parameters(args): Parameters<GitFileShaArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Reuse our own file_at then write to disk.
        let folder = args.folder.clone();
        let file_path = args.file_path.clone();
        let sha = args.sha.clone();
        let repo = open_repo(&folder).map_err(|e| err(e.to_string()))?;
        let rel = rel_path(&repo, &file_path)
            .ok_or_else(|| err(format!("file outside workspace: {}", file_path)))?;
        let oid = Oid::from_str(&sha).map_err(|e| err(format!("bad sha: {e}")))?;
        let commit = repo.find_commit(oid).map_err(|e| err(e.to_string()))?;
        let tree = commit.tree().map_err(|e| err(e.to_string()))?;
        let entry = tree.get_path(Path::new(&rel))
            .map_err(|e| err(format!("not in commit: {e}")))?;
        let object = entry.to_object(&repo).map_err(|e| err(e.to_string()))?;
        let blob = object.as_blob().ok_or_else(|| err("not a blob"))?;
        std::fs::write(&file_path, blob.content())
            .map_err(|e| err(format!("write: {e}")))?;
        Ok(text_result(format!("rollback ok ({} bytes -> {})", blob.content().len(), file_path)))
    }

    #[tool(description = "Read a file from disk. Args: { path }.")]
    pub async fn solomd_read_file(
        &self,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, McpError> {
        let s = std::fs::read_to_string(&args.path)
            .map_err(|e| err(format!("read: {e}")))?;
        Ok(text_result(s))
    }

    #[tool(description = "Write a file to disk. Args: { path, content }.")]
    pub async fn solomd_write_file(
        &self,
        Parameters(args): Parameters<WriteFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        std::fs::write(&args.path, &args.content)
            .map_err(|e| err(format!("write: {e}")))?;
        Ok(text_result(format!("wrote {} bytes -> {}", args.content.len(), args.path)))
    }

    #[tool(description = "Take a full-screen screenshot. Returns the absolute path to a PNG that the caller can read.")]
    pub async fn solomd_screenshot(
        &self,
        Parameters(_args): Parameters<EmptyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let path = format!("/tmp/solomd-dev-mcp-{}.png", chrono_secs());
        let status = AsyncCommand::new("screencapture")
            .args(["-x", "-o", &path])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status().await.map_err(|e| err(format!("screencapture spawn: {e}")))?;
        if !status.success() {
            return Err(err(format!("screencapture exited: {status}")));
        }
        Ok(text_result(path))
    }

    #[tool(description = "List running SoloMD processes (dev = `target/debug/SoloMD`, prod = `/Applications/SoloMD.app`).")]
    pub async fn solomd_app_status(
        &self,
        Parameters(_args): Parameters<EmptyArgs>,
    ) -> Result<CallToolResult, McpError> {
        let out = AsyncCommand::new("/bin/sh")
            .arg("-c")
            .arg("ps -ax -o pid,etime,command | grep -E 'target/debug/SoloMD|/Applications/SoloMD.app/Contents/MacOS/SoloMD' | grep -v grep")
            .output().await.map_err(|e| err(format!("ps: {e}")))?;
        let s = String::from_utf8_lossy(&out.stdout).to_string();
        let lines: Vec<HashMap<&str, String>> = s.lines().map(|line| {
            let mut parts = line.trim().splitn(3, char::is_whitespace);
            let pid = parts.next().unwrap_or("").to_string();
            let elapsed = parts.next().unwrap_or("").to_string();
            let cmd = parts.next().unwrap_or("").to_string();
            let kind = if cmd.contains("/Applications/") { "prod" } else { "dev" };
            HashMap::from([
                ("pid", pid),
                ("elapsed", elapsed),
                ("kind", kind.to_string()),
                ("cmd", cmd),
            ])
        }).collect();
        Ok(json_result(serde_json::to_value(&lines).unwrap()))
    }
}

#[tool_handler]
impl ServerHandler for DevServer {
    fn get_info(&self) -> ServerInfo {
        let implementation = Implementation::new("solomd-dev-mcp", env!("CARGO_PKG_VERSION"))
            .with_title("SoloMD dev test harness");
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(implementation)
            .with_instructions(
                "Internal MCP server for end-to-end self-testing of SoloMD. \
                 Tools: solomd_get_settings/solomd_set_setting, \
                 solomd_get_workspace/solomd_set_workspace, \
                 solomd_get_tabs/solomd_set_tabs, \
                 solomd_git_status/init/commit/log/rollback/file_at, \
                 solomd_read_file/solomd_write_file, \
                 solomd_screenshot, solomd_app_status. \
                 Settings/workspace/tabs writes require SoloMD be closed.",
            )
    }
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

fn err(msg: impl Into<String>) -> McpError {
    McpError::internal_error(msg.into(), None)
}

fn text_result(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(s.into())])
}

fn json_result(v: JsonValue) -> CallToolResult {
    let pretty = serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string());
    CallToolResult::success(vec![Content::text(pretty)])
}

fn chrono_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
