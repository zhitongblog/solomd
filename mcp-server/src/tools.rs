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
