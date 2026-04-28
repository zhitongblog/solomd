//! MCP tool definitions + handlers.
//!
//! All eight v2.2 tools live here. The two write tools are gated by
//! `allow_write` — when false they return an error explaining how to enable
//! them, and they are still listed so clients see consistent capabilities
//! (this matches what most MCP servers do for safety toggles). If you'd
//! rather *omit* them entirely, build with `--allow-write` off and the
//! checks here will refuse the call.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, Implementation, ServerCapabilities, ServerInfo},
    schemars::{self, JsonSchema},
    tool, tool_handler, tool_router,
};
use serde::{Deserialize, Serialize};
use tokio::process::Command as AsyncCommand;
use tracing::debug;

use crate::safety;
use crate::workspace::{self, BacklinkRef, HeadingRef, NoteMeta, TagCount};

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct SoloMdServer {
    inner: Arc<ServerState>,
    tool_router: ToolRouter<Self>,
}

struct ServerState {
    workspace: PathBuf,
    allow_write: bool,
}

impl SoloMdServer {
    pub fn new(workspace: PathBuf, allow_write: bool) -> Self {
        Self {
            inner: Arc::new(ServerState { workspace, allow_write }),
            tool_router: Self::tool_router(),
        }
    }

    fn workspace(&self) -> &std::path::Path {
        &self.inner.workspace
    }
}

// ---------------------------------------------------------------------------
// Tool parameter structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct ListNotesArgs {
    /// Optional sub-folder under the workspace root.
    #[serde(default)]
    pub folder: Option<String>,
    /// Maximum number of notes to return. Defaults to 100.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct ReadNoteArgs {
    /// Path to the note. May be absolute (inside the workspace) or relative.
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SearchArgs {
    /// Query string. Treated as a literal substring unless `mode == "regex"`.
    pub query: String,
    /// `"literal"` (default) or `"regex"`.
    #[serde(default)]
    pub mode: Option<String>,
    /// Cap on number of matches. Default 200.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GetBacklinksArgs {
    /// Note name (file stem) to search for as a wikilink target.
    pub note_name: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct EmptyArgs {}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GetOutlineArgs {
    /// Path to the note.
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct WriteNoteArgs {
    /// Path to the note. Created if it does not exist (parent must exist).
    pub path: String,
    /// New file content (UTF-8).
    pub content: String,
    /// If false (default), refuse to overwrite an existing file.
    #[serde(default)]
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct AppendArgs {
    /// Path to an existing note.
    pub path: String,
    /// Text to append. A newline is added between existing content and the
    /// new text if the file does not already end with one.
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub snippet: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WriteResult {
    pub ok: bool,
    pub bytes_written: usize,
    pub path: String,
}

// ---------------------------------------------------------------------------
// v3.1 SoloMD-only tool args (autogit / sync / share)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct AutogitLogArgs {
    /// Path to the note (absolute or workspace-relative).
    pub path: String,
    /// Max commits to return (default 50, max 500).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct AutogitDiffArgs {
    /// Path to the note.
    pub path: String,
    /// SHA (or short SHA) to diff. Defaults to comparing HEAD against
    /// the previous commit.
    #[serde(default)]
    pub sha: Option<String>,
    /// Base SHA (defaults to the parent of `sha`). Use this to compare
    /// arbitrary two commits.
    #[serde(default)]
    pub base: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct AutogitRollbackArgs {
    /// Path to the note.
    pub path: String,
    /// SHA whose version of the file should overwrite the current
    /// working-tree copy.
    pub sha: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct ShareUrlArgs {
    /// Path to the note.
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct AutogitCommitMeta {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
}

// ---------------------------------------------------------------------------
// Tool router
// ---------------------------------------------------------------------------

#[tool_router(router = tool_router)]
impl SoloMdServer {
    /// List notes in the workspace (metadata only — content is *not* loaded).
    #[tool(
        name = "list_notes",
        description = "List Markdown notes in the SoloMD workspace. Returns metadata only (path, name, title, mtime, size, summary). Use read_note to fetch full content."
    )]
    pub async fn list_notes(
        &self,
        args: Parameters<ListNotesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = args.0.limit.unwrap_or(100).min(1000) as usize;
        let folder = match args.0.folder.as_deref() {
            Some(f) => safety::resolve_subfolder(self.workspace(), f)
                .map_err(|e| McpError::invalid_params(e, None))?,
            None => self.workspace().to_path_buf(),
        };

        let mut metas: Vec<NoteMeta> = Vec::new();
        for path in workspace::walk_markdown_files(&folder) {
            match workspace::scan_meta(&path) {
                Ok(m) => metas.push(m),
                Err(e) => debug!("scan_meta failed for {}: {}", path.display(), e),
            }
            if metas.len() >= limit {
                break;
            }
        }
        metas.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        let json = serde_json::json!({ "notes": metas, "count": metas.len() });
        Ok(CallToolResult::success(vec![
            Content::json(json).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Read the full content + parsed metadata of a single note.
    #[tool(
        name = "read_note",
        description = "Read a single Markdown note. Returns full content plus parsed front matter, headings, tags, and outbound wikilinks."
    )]
    pub async fn read_note(
        &self,
        args: Parameters<ReadNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        let path = safety::resolve_in(self.workspace(), &args.0.path, true)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let note = workspace::read_full(&path)
            .map_err(|e| McpError::internal_error(e, None))?;
        Ok(CallToolResult::success(vec![
            Content::json(note).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Search across notes. Prefers `rg` if on PATH, otherwise falls back to
    /// a Rust regex walk.
    #[tool(
        name = "search",
        description = "Search notes for a query. Returns up to `limit` matches with 3-line context. mode defaults to \"literal\"; pass \"regex\" for a regular-expression search."
    )]
    pub async fn search(
        &self,
        args: Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mode = args.0.mode.as_deref().unwrap_or("literal");
        let limit = args.0.limit.unwrap_or(200).min(1000) as usize;
        let regex = matches!(mode, "regex");
        let hits = if has_rg().await {
            search_with_rg(self.workspace(), &args.0.query, regex, limit).await
        } else {
            search_native(self.workspace(), &args.0.query, regex, limit)
        }
        .map_err(|e| McpError::internal_error(e, None))?;
        Ok(CallToolResult::success(vec![
            Content::json(serde_json::json!({ "hits": hits, "count": hits.len() }))
                .map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Find every place that wikilinks `[[note_name]]`.
    #[tool(
        name = "get_backlinks",
        description = "Return wikilink-style backlinks (`[[note_name]]`) to the given note. Match is case-insensitive on the file stem."
    )]
    pub async fn get_backlinks(
        &self,
        args: Parameters<GetBacklinksArgs>,
    ) -> Result<CallToolResult, McpError> {
        let needle = args.0.note_name.trim().to_lowercase();
        if needle.is_empty() {
            return Err(McpError::invalid_params("note_name must not be empty", None));
        }
        let mut out: Vec<BacklinkRef> = Vec::new();
        for path in workspace::walk_markdown_files(self.workspace()) {
            let note = match workspace::read_full(&path) {
                Ok(n) => n,
                Err(_) => continue,
            };
            for link in &note.wikilinks {
                if link.target.to_lowercase() == needle {
                    let from_name = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    out.push(BacklinkRef {
                        from_path: path.to_string_lossy().to_string(),
                        from_name,
                        line: link.line,
                        context: workspace::read_context(&path, link.line),
                    });
                }
            }
        }
        out.sort_by(|a, b| a.from_name.cmp(&b.from_name));
        Ok(CallToolResult::success(vec![
            Content::json(serde_json::json!({ "backlinks": out, "count": out.len() }))
                .map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Aggregated tag counts across the vault.
    #[tool(
        name = "list_tags",
        description = "List every tag found in the workspace (body `#tag` and front-matter `tags:`), sorted by count desc."
    )]
    pub async fn list_tags(
        &self,
        _args: Parameters<EmptyArgs>,
    ) -> Result<CallToolResult, McpError> {
        use std::collections::HashMap;
        let mut by_tag: HashMap<String, (u32, Vec<String>)> = HashMap::new();
        for path in workspace::walk_markdown_files(self.workspace()) {
            let note = match workspace::read_full(&path) {
                Ok(n) => n,
                Err(_) => continue,
            };
            let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
            for tag in &note.tags {
                if seen.insert(tag) {
                    let e = by_tag.entry(tag.clone()).or_insert_with(|| (0, vec![]));
                    e.0 += 1;
                    e.1.push(note.path.clone());
                }
            }
        }
        let mut out: Vec<TagCount> = by_tag
            .into_iter()
            .map(|(tag, (count, files))| TagCount { tag, count, files })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        Ok(CallToolResult::success(vec![
            Content::json(serde_json::json!({ "tags": out, "count": out.len() }))
                .map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Heading outline for a note.
    #[tool(
        name = "get_outline",
        description = "Return the heading outline of a note, with level (1-6), text, and 1-based line number."
    )]
    pub async fn get_outline(
        &self,
        args: Parameters<GetOutlineArgs>,
    ) -> Result<CallToolResult, McpError> {
        let path = safety::resolve_in(self.workspace(), &args.0.path, true)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        let (_fm, body) = workspace::split_front_matter(&raw);
        let headings: Vec<HeadingRef> = workspace::extract_headings(body);
        Ok(CallToolResult::success(vec![
            Content::json(serde_json::json!({ "outline": headings }))
                .map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Write (or overwrite) a note. Gated by `--allow-write`.
    #[tool(
        name = "write_note",
        description = "Write a Markdown note to disk. Requires the server to be started with --allow-write. Refuses to overwrite an existing file unless `allow_overwrite` is true."
    )]
    pub async fn write_note(
        &self,
        args: Parameters<WriteNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.inner.allow_write {
            return Err(McpError::invalid_request(
                "write_note is disabled. Restart solomd-mcp with --allow-write to enable it.",
                None,
            ));
        }
        let path = safety::resolve_in(self.workspace(), &args.0.path, false)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let allow_overwrite = args.0.allow_overwrite.unwrap_or(false);
        if path.exists() && !allow_overwrite {
            return Err(McpError::invalid_request(
                format!(
                    "{} already exists. Pass allow_overwrite=true to replace it.",
                    path.display()
                ),
                None,
            ));
        }
        let bytes = args.0.content.len();
        std::fs::write(&path, args.0.content)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        let result = WriteResult {
            ok: true,
            bytes_written: bytes,
            path: path.to_string_lossy().to_string(),
        };
        Ok(CallToolResult::success(vec![
            Content::json(result).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    // ---- v3.1 SoloMD-only tools (autogit / sync / share) -----------------

    /// List per-note commit history from SoloMD's AutoGit repo.
    #[tool(
        name = "autogit_log",
        description = "List the commit history for a single note from SoloMD's AutoGit repo (saves are auto-committed). Returns sha + short_sha + author + time (unix seconds) + summary, newest first."
    )]
    pub async fn autogit_log(
        &self,
        args: Parameters<AutogitLogArgs>,
    ) -> Result<CallToolResult, McpError> {
        let workspace = self.workspace().to_path_buf();
        let path = safety::resolve_in(&workspace, &args.0.path, true)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let limit = args.0.limit.unwrap_or(50).min(500) as usize;
        let commits = tokio::task::spawn_blocking(move || autogit_log_inner(&workspace, &path, limit))
            .await
            .map_err(|e| McpError::internal_error(format!("join: {e}"), None))?
            .map_err(|e| McpError::internal_error(e, None))?;
        let json = serde_json::json!({ "commits": commits, "count": commits.len() });
        Ok(CallToolResult::success(vec![
            Content::json(json).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Show the textual diff for one note between two AutoGit commits.
    #[tool(
        name = "autogit_diff",
        description = "Show a unified diff for one note between two AutoGit commits. Defaults: sha=HEAD, base=parent of sha. Returns the diff as a string plus the resolved sha/base."
    )]
    pub async fn autogit_diff(
        &self,
        args: Parameters<AutogitDiffArgs>,
    ) -> Result<CallToolResult, McpError> {
        let workspace = self.workspace().to_path_buf();
        let path = safety::resolve_in(&workspace, &args.0.path, true)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let sha = args.0.sha.clone();
        let base = args.0.base.clone();
        let result = tokio::task::spawn_blocking(move || autogit_diff_inner(&workspace, &path, sha.as_deref(), base.as_deref()))
            .await
            .map_err(|e| McpError::internal_error(format!("join: {e}"), None))?
            .map_err(|e| McpError::internal_error(e, None))?;
        Ok(CallToolResult::success(vec![
            Content::json(result).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Restore a note's content from a specific AutoGit commit. Gated by
    /// `--allow-write`. Writes through the AutoGit repo so the rollback
    /// itself becomes a new commit on top.
    #[tool(
        name = "autogit_rollback",
        description = "Restore a note's content from a specific AutoGit commit by overwriting the working tree. Requires --allow-write. The rollback is itself a new save (and thus a new AutoGit commit), so the prior history is preserved."
    )]
    pub async fn autogit_rollback(
        &self,
        args: Parameters<AutogitRollbackArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.inner.allow_write {
            return Err(McpError::invalid_request(
                "autogit_rollback is disabled. Restart solomd-mcp with --allow-write to enable it.",
                None,
            ));
        }
        let workspace = self.workspace().to_path_buf();
        let path = safety::resolve_in(&workspace, &args.0.path, true)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let sha = args.0.sha.clone();
        let path_str = path.to_string_lossy().to_string();
        let bytes = tokio::task::spawn_blocking(move || autogit_rollback_inner(&workspace, &path, &sha))
            .await
            .map_err(|e| McpError::internal_error(format!("join: {e}"), None))?
            .map_err(|e| McpError::internal_error(e, None))?;
        let result = WriteResult {
            ok: true,
            bytes_written: bytes,
            path: path_str,
        };
        Ok(CallToolResult::success(vec![
            Content::json(result).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Read SoloMD's GitHub-sync state for the workspace.
    #[tool(
        name = "sync_status",
        description = "Return SoloMD's GitHub-sync configuration for this workspace: linked remote, current branch, encryption flag, last push/pull timestamps. Reads .solomd/sync.json — does not require credentials."
    )]
    pub async fn sync_status(&self) -> Result<CallToolResult, McpError> {
        let workspace = self.workspace().to_path_buf();
        let json = tokio::task::spawn_blocking(move || sync_status_inner(&workspace))
            .await
            .map_err(|e| McpError::internal_error(format!("join: {e}"), None))?
            .map_err(|e| McpError::internal_error(e, None))?;
        Ok(CallToolResult::success(vec![
            Content::json(json).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Compute the public share URL for a note (only valid if the
    /// workspace is linked to a public GitHub repo).
    #[tool(
        name = "share_url",
        description = "Return the public solomd.app/share/ URL for a note. Only resolves to a real page if the workspace's linked repo is public; for private repos the URL exists but raw.githubusercontent.com will 404. Use sync_status first to check `private`."
    )]
    pub async fn share_url(
        &self,
        args: Parameters<ShareUrlArgs>,
    ) -> Result<CallToolResult, McpError> {
        let workspace = self.workspace().to_path_buf();
        let path = safety::resolve_in(&workspace, &args.0.path, true)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let json = tokio::task::spawn_blocking(move || share_url_inner(&workspace, &path))
            .await
            .map_err(|e| McpError::internal_error(format!("join: {e}"), None))?
            .map_err(|e| McpError::internal_error(e, None))?;
        Ok(CallToolResult::success(vec![
            Content::json(json).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }

    /// Append to an existing note. Gated by `--allow-write`.
    #[tool(
        name = "append_to_note",
        description = "Append text to an existing note. Requires --allow-write. A newline is inserted between existing content and new text if needed."
    )]
    pub async fn append_to_note(
        &self,
        args: Parameters<AppendArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.inner.allow_write {
            return Err(McpError::invalid_request(
                "append_to_note is disabled. Restart solomd-mcp with --allow-write to enable it.",
                None,
            ));
        }
        let path = safety::resolve_in(self.workspace(), &args.0.path, true)
            .map_err(|e| McpError::invalid_params(e, None))?;
        let mut existing = std::fs::read_to_string(&path)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        if !existing.ends_with('\n') && !existing.is_empty() {
            existing.push('\n');
        }
        existing.push_str(&args.0.content);
        let bytes = existing.len();
        std::fs::write(&path, existing)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        let result = WriteResult {
            ok: true,
            bytes_written: bytes,
            path: path.to_string_lossy().to_string(),
        };
        Ok(CallToolResult::success(vec![
            Content::json(result).map_err(|e| McpError::internal_error(e.to_string(), None))?
        ]))
    }
}

// ---------------------------------------------------------------------------
// ServerHandler
// ---------------------------------------------------------------------------

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SoloMdServer {
    fn get_info(&self) -> ServerInfo {
        let implementation =
            Implementation::new("solomd-mcp", env!("CARGO_PKG_VERSION")).with_title("SoloMD Vault");
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(implementation)
            .with_instructions(
                "Read and (optionally) write a SoloMD Markdown notes vault. \
                 Tools are read-only by default; restart with --allow-write to expose \
                 write_note + append_to_note.",
            )
    }
}

// ---------------------------------------------------------------------------
// Search backends
// ---------------------------------------------------------------------------

async fn has_rg() -> bool {
    AsyncCommand::new("rg")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn search_with_rg(
    root: &std::path::Path,
    query: &str,
    regex: bool,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let mut cmd = AsyncCommand::new("rg");
    cmd.arg("--json")
        .arg("--with-filename")
        .arg("--line-number")
        .arg("--column")
        .arg("--no-heading")
        .arg("--max-count")
        .arg(limit.to_string())
        .arg("--type-add")
        .arg("md:*.md")
        .arg("--type-add")
        .arg("md:*.markdown")
        .arg("--type-add")
        .arg("md:*.mdown")
        .arg("--type")
        .arg("md");
    if !regex {
        cmd.arg("--fixed-strings");
    }
    cmd.arg("--").arg(query).arg(root);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("rg failed to start: {e}"))?;
    if !output.status.success() && !output.status.code().map(|c| c == 1).unwrap_or(false) {
        // exit 1 == no matches; otherwise it's an error.
        return Err(format!(
            "rg exited with {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let mut hits: Vec<SearchHit> = Vec::new();
    for line in output.stdout.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_slice(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let data = match v.get("data") {
            Some(d) => d,
            None => continue,
        };
        let path = data
            .pointer("/path/text")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let line_no = data.get("line_number").and_then(|n| n.as_u64()).unwrap_or(0) as u32;
        let column = data
            .pointer("/submatches/0/start")
            .and_then(|n| n.as_u64())
            .unwrap_or(0) as u32
            + 1;
        let snippet = workspace::read_context(std::path::Path::new(&path), line_no);
        hits.push(SearchHit {
            path,
            line: line_no,
            column,
            snippet,
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

fn search_native(
    root: &std::path::Path,
    query: &str,
    regex: bool,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let pattern = if regex {
        Some(regex_lite::Regex::new(query).map_err(|e| format!("invalid regex: {e}"))?)
    } else {
        None
    };
    let needle_lower = query.to_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();
    'outer: for path in workspace::walk_markdown_files(root) {
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for (line_idx, line) in raw.lines().enumerate() {
            let col = if let Some(re) = &pattern {
                re.find(line).map(|m| m.start() + 1)
            } else {
                line.to_lowercase().find(&needle_lower).map(|c| c + 1)
            };
            if let Some(column) = col {
                hits.push(SearchHit {
                    path: path.to_string_lossy().to_string(),
                    line: (line_idx as u32) + 1,
                    column: column as u32,
                    snippet: workspace::read_context(&path, (line_idx as u32) + 1),
                });
                if hits.len() >= limit {
                    break 'outer;
                }
            }
        }
    }
    Ok(hits)
}

// ---------------------------------------------------------------------------
// v3.1 inner helpers — git2 / sync.json / share URL
// ---------------------------------------------------------------------------

fn autogit_log_inner(
    workspace: &std::path::Path,
    note_path: &std::path::Path,
    limit: usize,
) -> Result<Vec<AutogitCommitMeta>, String> {
    let repo = git2::Repository::open(workspace)
        .map_err(|e| format!("not an AutoGit workspace: {e}"))?;
    let rel = note_path
        .strip_prefix(workspace)
        .map_err(|_| "note is outside the workspace".to_string())?;
    let mut walker = repo.revwalk().map_err(|e| e.to_string())?;
    walker.push_head().map_err(|e| e.to_string())?;

    let mut out: Vec<AutogitCommitMeta> = Vec::new();
    for oid in walker.flatten() {
        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !commit_touches(&repo, &commit, rel).unwrap_or(false) {
            continue;
        }
        let summary = commit.summary().unwrap_or("").to_string();
        let name = commit.author().name().unwrap_or("").to_string();
        out.push(AutogitCommitMeta {
            sha: commit.id().to_string(),
            short_sha: commit.id().to_string().chars().take(7).collect(),
            author: name,
            time: commit.time().seconds(),
            summary,
        });
    }
    // Sort newest-first by author time. Doing it in Rust dodges git2's
    // sorting modes — Sort::TIME is ascending, REVERSE is non-obvious,
    // and the resulting filter+visit order is fragile across history
    // shapes. A plain sort_by here is unambiguous.
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out.truncate(limit);
    Ok(out)
}

fn commit_touches(
    repo: &git2::Repository,
    commit: &git2::Commit,
    rel: &std::path::Path,
) -> Result<bool, git2::Error> {
    let tree = commit.tree()?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(commit.parent(0)?.tree()?)
    } else {
        None
    };
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
    let mut hit = false;
    diff.foreach(
        &mut |delta, _| {
            if delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p == rel)
                .unwrap_or(false)
            {
                hit = true;
            }
            true
        },
        None,
        None,
        None,
    )?;
    Ok(hit)
}

fn autogit_diff_inner(
    workspace: &std::path::Path,
    note_path: &std::path::Path,
    sha: Option<&str>,
    base: Option<&str>,
) -> Result<serde_json::Value, String> {
    let repo = git2::Repository::open(workspace)
        .map_err(|e| format!("not an AutoGit workspace: {e}"))?;
    let rel = note_path
        .strip_prefix(workspace)
        .map_err(|_| "note is outside the workspace".to_string())?;

    let new_oid = match sha {
        Some(s) => repo
            .revparse_single(s)
            .map_err(|e| format!("resolve {s}: {e}"))?
            .id(),
        None => {
            // Default: the most recent commit that actually touched this
            // path. Plain HEAD-vs-parent is misleading when HEAD only
            // changed *other* files — the diff would be empty even though
            // there's plenty of history for the requested path.
            let mut walker = repo.revwalk().map_err(|e| e.to_string())?;
            walker.push_head().map_err(|e| e.to_string())?;
            // Collect every commit that touches the path, then pick the
            // newest by author time. (Don't rely on revwalk sort modes.)
            let mut candidates: Vec<(git2::Oid, i64)> = Vec::new();
            for oid in walker.flatten() {
                if let Ok(c) = repo.find_commit(oid) {
                    if commit_touches(&repo, &c, rel).unwrap_or(false) {
                        candidates.push((oid, c.time().seconds()));
                    }
                }
            }
            candidates.sort_by(|a, b| b.1.cmp(&a.1));
            candidates
                .into_iter()
                .next()
                .map(|(oid, _)| oid)
                .ok_or_else(|| format!("no commit in this repo has touched '{}'", rel.display()))?
        }
    };
    let new_commit = repo.find_commit(new_oid).map_err(|e| e.to_string())?;
    let new_tree = new_commit.tree().map_err(|e| e.to_string())?;

    let base_commit = match base {
        Some(s) => Some(
            repo.revparse_single(s)
                .map_err(|e| format!("resolve {s}: {e}"))?
                .peel_to_commit()
                .map_err(|e| e.to_string())?,
        ),
        None => {
            if new_commit.parent_count() > 0 {
                Some(new_commit.parent(0).map_err(|e| e.to_string())?)
            } else {
                None
            }
        }
    };
    let base_tree = match &base_commit {
        Some(c) => Some(c.tree().map_err(|e| e.to_string())?),
        None => None,
    };

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(rel.to_string_lossy().as_ref());
    let diff = repo
        .diff_tree_to_tree(base_tree.as_ref(), Some(&new_tree), Some(&mut diff_opts))
        .map_err(|e| e.to_string())?;

    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_d, _h, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            out.push(origin);
        }
        out.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "sha": new_oid.to_string(),
        "base": base_commit.as_ref().map(|c| c.id().to_string()),
        "diff": out,
        "path": rel.to_string_lossy(),
    }))
}

fn autogit_rollback_inner(
    workspace: &std::path::Path,
    note_path: &std::path::Path,
    sha: &str,
) -> Result<usize, String> {
    let repo = git2::Repository::open(workspace)
        .map_err(|e| format!("not an AutoGit workspace: {e}"))?;
    let rel = note_path
        .strip_prefix(workspace)
        .map_err(|_| "note is outside the workspace".to_string())?;
    let object = repo
        .revparse_single(sha)
        .map_err(|e| format!("resolve {sha}: {e}"))?;
    let commit = object
        .peel_to_commit()
        .map_err(|e| format!("not a commit: {e}"))?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree
        .get_path(rel)
        .map_err(|_| format!("file '{}' not in commit {}", rel.display(), sha))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| format!("blob: {e}"))?;
    let bytes = blob.content().to_vec();
    let n = bytes.len();
    std::fs::write(note_path, bytes).map_err(|e| format!("write: {e}"))?;
    Ok(n)
}

fn sync_status_inner(workspace: &std::path::Path) -> Result<serde_json::Value, String> {
    let cfg_path = workspace.join(".solomd").join("sync.json");
    if !cfg_path.exists() {
        return Ok(serde_json::json!({
            "linked": false,
            "remote_url": null,
            "encrypted": false,
        }));
    }
    let raw = std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?;
    // Refuse to invent state if the config is corrupted — same fail-closed
    // posture as the desktop app's github_push_inner / github_pull_inner.
    let mut value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("sync.json corrupted: {e}"))?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("linked".into(), serde_json::Value::Bool(true));
    }
    Ok(value)
}

fn share_url_inner(
    workspace: &std::path::Path,
    note_path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let cfg_path = workspace.join(".solomd").join("sync.json");
    if !cfg_path.exists() {
        return Err("workspace is not linked to a GitHub repo".into());
    }
    let raw = std::fs::read_to_string(&cfg_path).map_err(|e| e.to_string())?;
    let cfg: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("sync.json corrupted: {e}"))?;
    let remote = cfg
        .get("remote_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "remote_url missing in sync.json".to_string())?;
    // Accept both https://github.com/<owner>/<repo>.git and the bare form.
    let owner_repo = parse_owner_repo(remote)
        .ok_or_else(|| format!("not a GitHub remote: {remote}"))?;
    let branch = cfg
        .get("branch")
        .and_then(|v| v.as_str())
        .unwrap_or("main")
        .to_string();
    let rel = note_path
        .strip_prefix(workspace)
        .map_err(|_| "note is outside the workspace".to_string())?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let url = format!(
        "https://solomd.app/share/?repo={}&path={}&branch={}",
        urlencode(&owner_repo),
        urlencode(&rel_str),
        urlencode(&branch),
    );
    Ok(serde_json::json!({
        "url": url,
        "repo": owner_repo,
        "branch": branch,
        "path": rel_str,
        "warning": "Public share only renders if the linked repo is public. Use sync_status if unsure.",
    }))
}

fn parse_owner_repo(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let after = trimmed.split("github.com").nth(1)?.trim_start_matches([':', '/']);
    let parts: Vec<&str> = after.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// v3.1 unit tests for SoloMD-only inner helpers.
//
// These don't go through the MCP protocol layer — they call the inner
// functions directly so we can pin down behavior (fail-closed on bad
// sync.json, smart default for autogit_diff, branch-with-slash for share
// URL, etc.) without spinning up the JSON-RPC server.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fresh_repo(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("solomd-mcp-{label}-{nanos}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // git init + identity (avoid test depending on user's git config)
        Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&dir).status().unwrap();
        Command::new("git").args(["config", "user.email", "test@local"]).current_dir(&dir).status().unwrap();
        Command::new("git").args(["config", "user.name", "Test"]).current_dir(&dir).status().unwrap();
        dir
    }

    fn commit(repo: &std::path::Path, path: &str, body: &str, msg: &str) {
        let full = repo.join(path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&full, body).unwrap();
        Command::new("git").args(["add", "."]).current_dir(repo).status().unwrap();
        Command::new("git").args(["commit", "-q", "-m", msg]).current_dir(repo).status().unwrap();
    }

    #[test]
    fn autogit_log_returns_only_commits_touching_path_newest_first() {
        let repo = fresh_repo("log");
        commit(&repo, "notes/foo.md", "v1\n", "initial: foo");
        // Sleep 1s so author times differ deterministically.
        std::thread::sleep(std::time::Duration::from_secs(1));
        commit(&repo, "notes/bar.md", "bar\n", "add: bar (does not touch foo)");
        std::thread::sleep(std::time::Duration::from_secs(1));
        commit(&repo, "notes/foo.md", "v2\n", "edit: foo round 2");

        let foo = repo.join("notes/foo.md");
        let log = autogit_log_inner(&repo, &foo, 50).unwrap();
        assert_eq!(log.len(), 2, "should skip the bar-only commit");
        assert_eq!(log[0].summary, "edit: foo round 2", "newest first");
        assert_eq!(log[1].summary, "initial: foo");
        assert!(log[0].time >= log[1].time);
    }

    #[test]
    fn autogit_diff_default_picks_most_recent_commit_touching_path() {
        let repo = fresh_repo("diff");
        commit(&repo, "notes/foo.md", "v1\n", "initial: foo");
        std::thread::sleep(std::time::Duration::from_secs(1));
        commit(&repo, "notes/foo.md", "v2\n", "edit: foo round 2");
        std::thread::sleep(std::time::Duration::from_secs(1));
        // HEAD doesn't touch foo — naive HEAD-vs-parent would diff empty.
        commit(&repo, "notes/bar.md", "bar\n", "add: bar (HEAD)");

        let foo = repo.join("notes/foo.md");
        let result = autogit_diff_inner(&repo, &foo, None, None).unwrap();
        let diff = result.get("diff").unwrap().as_str().unwrap();
        assert!(diff.contains("-v1"), "expected the foo edit diff, got: {diff}");
        assert!(diff.contains("+v2"), "expected the foo edit diff, got: {diff}");
    }

    #[test]
    fn autogit_rollback_overwrites_working_tree() {
        let repo = fresh_repo("roll");
        commit(&repo, "notes/foo.md", "first\n", "initial");
        let initial_sha = String::from_utf8(
            Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&repo).output().unwrap().stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        commit(&repo, "notes/foo.md", "second\n", "round 2");

        let foo = repo.join("notes/foo.md");
        assert_eq!(fs::read_to_string(&foo).unwrap(), "second\n");
        let written = autogit_rollback_inner(&repo, &foo, &initial_sha).unwrap();
        assert_eq!(written, 6); // "first\n"
        assert_eq!(fs::read_to_string(&foo).unwrap(), "first\n");
    }

    #[test]
    fn sync_status_no_config_means_unlinked() {
        let repo = fresh_repo("st1");
        let v = sync_status_inner(&repo).unwrap();
        assert_eq!(v.get("linked").and_then(|x| x.as_bool()), Some(false));
    }

    #[test]
    fn sync_status_corrupted_json_fails_closed() {
        let repo = fresh_repo("st2");
        fs::create_dir_all(repo.join(".solomd")).unwrap();
        fs::write(repo.join(".solomd/sync.json"), b"{not valid json").unwrap();
        let err = sync_status_inner(&repo).unwrap_err();
        // Same posture as desktop github_push_inner: refuse to invent state.
        assert!(err.contains("corrupted"), "got: {err}");
    }

    #[test]
    fn sync_status_happy_path() {
        let repo = fresh_repo("st3");
        fs::create_dir_all(repo.join(".solomd")).unwrap();
        fs::write(
            repo.join(".solomd/sync.json"),
            br#"{"remote_url":"https://github.com/me/notes.git","branch":"main","encrypted":true}"#,
        )
        .unwrap();
        let v = sync_status_inner(&repo).unwrap();
        assert_eq!(v.get("linked").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v.get("encrypted").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v.get("branch").and_then(|x| x.as_str()), Some("main"));
    }

    #[test]
    fn share_url_handles_branch_with_slash() {
        let repo = fresh_repo("share");
        fs::create_dir_all(repo.join(".solomd")).unwrap();
        // Branch name contains '/' — used to be the share-page bug.
        fs::write(
            repo.join(".solomd/sync.json"),
            br#"{"remote_url":"https://github.com/owner/repo.git","branch":"feature/foo"}"#,
        )
        .unwrap();
        let note = repo.join("notes/a.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, b"# A").unwrap();

        let v = share_url_inner(&repo, &note).unwrap();
        let url = v.get("url").unwrap().as_str().unwrap();
        // The slash in feature/foo must survive — encodeURIComponent on the
        // whole branch would turn it into %2F and 404 the share page.
        assert!(url.contains("branch=feature/foo"), "url={url}");
        assert!(url.contains("repo=owner/repo"));
        assert!(url.contains("path=notes/a.md"));
    }

    #[test]
    fn parse_owner_repo_handles_https_ssh_with_or_without_dot_git() {
        assert_eq!(parse_owner_repo("https://github.com/owner/repo.git"), Some("owner/repo".into()));
        assert_eq!(parse_owner_repo("https://github.com/owner/repo"), Some("owner/repo".into()));
        assert_eq!(parse_owner_repo("git@github.com:owner/repo.git"), Some("owner/repo".into()));
        assert_eq!(parse_owner_repo("https://gitlab.com/owner/repo.git"), None);
    }

    #[test]
    fn share_url_refuses_when_workspace_not_linked() {
        let repo = fresh_repo("nolink");
        let note = repo.join("notes/a.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, b"# A").unwrap();
        let err = share_url_inner(&repo, &note).unwrap_err();
        assert!(err.contains("not linked"), "got: {err}");
    }
}
