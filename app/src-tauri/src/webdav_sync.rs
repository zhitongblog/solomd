//! #458 — WebDAV workspace sync (坚果云 Nutstore, Nextcloud, ownCloud, AList /
//! OpenList, Synology WebDAV, etc.).
//!
//! Uses pure HTTP/WebDAV (`PROPFIND`, `MKCOL`, `GET`, `PUT`) over `reqwest`
//! with Basic Auth so it works across macOS, Windows, Linux, iOS, and Android
//! without needing `libgit2`.

use reqwest::Method;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static SYNC_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgressPayload {
    pub channel: String,
    pub direction: String,
    pub current: usize,
    pub total: usize,
    pub percent: u8,
    pub message: String,
}

fn set_sync_app_handle(app: &tauri::AppHandle) {
    let _ = SYNC_APP_HANDLE.set(app.clone());
}

fn emit_sync_progress(
    channel: &str,
    direction: &str,
    current: usize,
    total: usize,
    message: impl Into<String>,
) {
    if let Some(app) = SYNC_APP_HANDLE.get() {
        use tauri::Emitter;
        let percent = if total == 0 {
            0
        } else {
            ((current.saturating_mul(100)) / total).min(100) as u8
        };
        let _ = app.emit(
            "solomd://sync-progress",
            SyncProgressPayload {
                channel: channel.to_string(),
                direction: direction.to_string(),
                current,
                total,
                percent,
                message: message.into(),
            },
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebdavSyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub message: String,
}

const VAULT_MANIFEST_NAME: &str = "solomd-vault.json";
const VAULT_PROBE_AAD: &str = "encryption.probe";
const VAULT_PROBE_PLAIN: &[u8] = b"SoloMD probe v1";

const SYNC_META_DIR: &str = ".solomd-sync";
const SYNC_MANIFEST_REL: &str = ".solomd-sync/manifest.json";
const SYNC_VERSIONS_REL: &str = ".solomd-sync/versions";
const DEFAULT_MAX_VERSIONS: usize = 20;

/// Built-in public OAuth Client IDs so users can authorize via browser
/// without registering a developer account first, while still allowing custom Client ID overrides.
const DEFAULT_BAIDU_OAUTH_CLIENT_ID: &str = "iYCeC9g08h5vuP9UqvPHKKSVrKFXGa1v";
const DEFAULT_ALIPAN_OAUTH_CLIENT_ID: &str = "50929a2f00194127a7f3ce9d7b604e7f";
const DEFAULT_ONEDRIVE_OAUTH_CLIENT_ID: &str = "d50ca740-c83f-4d1b-b616-12c519384f0c";
const DEFAULT_DROPBOX_OAUTH_CLIENT_ID: &str = "n6f039234p498c0";
const DEFAULT_GDRIVE_OAUTH_CLIENT_ID: &str = "202264815644.apps.googleusercontent.com";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncFileManifestEntry {
    pub local_rel: String,
    pub remote_rel: String,
    pub sha256: String,
    pub size: u64,
    pub updated_at: i64,
    #[serde(default)]
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncFolderManifest {
    pub version: u8,
    pub workspace_name: String,
    pub updated_at: i64,
    pub encrypted: bool,
    #[serde(default)]
    pub vault_crypto: Option<CloudVaultManifest>,
    #[serde(default)]
    pub files: BTreeMap<String, SyncFileManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncVersionEntry {
    pub id: String,
    pub rel_path: String,
    pub sha256: String,
    pub size: u64,
    pub created_at: i64,
    pub label: String,
    pub device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDiffLine {
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<SnapshotDiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDiffResult {
    pub from_sha: Option<String>,
    pub to_sha: String,
    pub hunks: Vec<SnapshotDiffHunk>,
    pub unified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedCloudDir {
    pub provider: String,
    pub label: String,
    pub base_dir: String,
    pub suggested_vault_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickAuthInfo {
    pub auth_url: String,
    pub instructions: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    super::crypto::hex_encode(&digest)
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn device_hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "SoloMD".to_string())
}

/// Sanitize a workspace folder name for safe use as a dedicated cloud subdirectory.
pub fn workspace_folder_name(workspace: &Path) -> String {
    let raw = workspace
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Notes")
        .trim();
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.');
    if trimmed.is_empty() {
        "Notes".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Resolve the remote workspace root directory. When `auto_workspace_subdir` is true,
/// automatically creates/targets a dedicated subdirectory named after the local workspace
/// folder (e.g. `/apps/SoloMD/MyNotes`), unless `base_remote_dir` already ends with it.
pub fn resolve_remote_workspace_dir(
    provider: &str,
    base_remote_dir: &str,
    workspace: &Path,
    auto_workspace_subdir: bool,
) -> String {
    let cleaned = base_remote_dir.trim().replace('\\', "/");
    let trimmed = cleaned.trim_matches('/');
    let mut base = if trimmed.is_empty() {
        if provider == "baidu" {
            "/apps/SoloMD".to_string()
        } else {
            "/SoloMD".to_string()
        }
    } else if provider == "baidu" && !trimmed.starts_with("apps/") {
        format!("/apps/{trimmed}")
    } else {
        format!("/{trimmed}")
    };

    if auto_workspace_subdir {
        let ws_name = workspace_folder_name(workspace);
        let suffix = format!("/{ws_name}");
        if !base.ends_with(&suffix) {
            base.push_str(&suffix);
        }
    }
    base
}

/// Map a workspace-relative path (`rel_path`) to its cloud-drive relative path.
/// - Files already in a user-created subdirectory (e.g. `工作笔记/周报.md`, `_assets/a.png`)
///   always keep their exact subdirectory hierarchy (`工作笔记/周报.md`).
/// - Root-level loose files can optionally be sorted into category folders (`笔记文档/`, `图片素材/`, `文献附件/`)
///   when `categorize_loose_files` is enabled.
pub fn map_categorized_rel_path(rel_path: &str, categorize_loose_files: bool) -> String {
    let normalized = rel_path.replace('\\', "/");
    let clean = normalized.trim_matches('/');
    if !categorize_loose_files || clean.contains('/') {
        return clean.to_string();
    }
    let ext = Path::new(clean)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdown" | "mkd" | "txt" => format!("笔记文档/{clean}"),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => format!("图片素材/{clean}"),
        "pdf" | "bib" | "csl" => format!("文献附件/{clean}"),
        _ => clean.to_string(),
    }
}

/// Reverse a categorized cloud path back to the local workspace-relative path
/// when no manifest mapping is present.
pub fn unmap_categorized_rel_path(remote_rel: &str, categorize_loose_files: bool) -> String {
    let clean = remote_rel.replace('\\', "/");
    let clean = clean.trim_matches('/');
    if !categorize_loose_files {
        return clean.to_string();
    }
    for prefix in ["笔记文档/", "图片素材/", "文献附件/"] {
        if let Some(rest) = clean.strip_prefix(prefix) {
            if !rest.contains('/') && !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    clean.to_string()
}

/// Extract an OAuth `access_token` from either a raw token string, a full callback URL
/// (e.g. `https://openapi.baidu.com/oauth/2.0/login_success#expires_in=2592000&access_token=24.xxx&...`),
/// or a JSON snippet (`{"access_token": "24.xxx"}`).
pub fn extract_access_token(input: &str) -> String {
    let s = input.trim();
    if s.is_empty() {
        return String::new();
    }
    if s.starts_with('{') {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(s) {
            if let Some(tok) = val.get("access_token").and_then(|v| v.as_str()) {
                return tok.trim().to_string();
            }
        }
    }
    if let Some(idx) = s.find("access_token=") {
        let after = &s[idx + "access_token=".len()..];
        let end = after.find(&['&', '#', ' ', '"', '\'', '\n', '\r'][..]).unwrap_or(after.len());
        let extracted = percent_decode(&after[..end]);
        if !extracted.trim().is_empty() {
            return extracted.trim().to_string();
        }
    }
    s.to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Local & Cloud Sync Snapshot Version Manager (`.solomd-sync/versions/`)
// Works on all platforms (Desktop + Android + iOS) without requiring libgit2,
// and travels with the workspace across Baidu Netdisk / WebDAV / Cloud Vault.
// ─────────────────────────────────────────────────────────────────────────────

fn version_slot_dir(workspace: &Path, rel_path: &str) -> PathBuf {
    let clean = rel_path.replace('\\', "/");
    let clean = clean.trim_matches('/');
    let path_hash = &sha256_hex(clean.as_bytes())[..16];
    let leaf = Path::new(clean)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let safe_leaf: String = leaf
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    workspace
        .join(SYNC_VERSIONS_REL)
        .join(format!("{safe_leaf}_{path_hash}"))
}

fn read_local_base_manifest(workspace: &Path) -> Option<SyncFolderManifest> {
    let path = workspace.join(SYNC_MANIFEST_REL);
    if !path.exists() {
        return None;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn write_local_base_manifest(workspace: &Path, manifest: &SyncFolderManifest) {
    let path = workspace.join(SYNC_MANIFEST_REL);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(manifest) {
        let _ = std::fs::write(&path, json);
    }
}

fn is_conflict_copy_rel(rel_path: &str) -> bool {
    rel_path.contains(" (冲突副本 ")
}

/// Write a side-by-side conflict copy (`<stem> (冲突副本 <origin> <timestamp>_<sha6>).<ext>`)
/// so multi-device concurrent modifications never silently overwrite each other in the file tree.
pub fn write_conflict_copy_file(
    workspace: &Path,
    local_rel: &str,
    conflicting_bytes: &[u8],
    origin_tag: &str,
) -> Option<String> {
    if conflicting_bytes.is_empty() || is_conflict_copy_rel(local_rel) {
        return None;
    }
    let rel_p = Path::new(local_rel);
    let parent = rel_p.parent();
    let stem = rel_p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let ext = rel_p.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let sha6 = &sha256_hex(conflicting_bytes)[..6];
    let ts = now_unix_secs();
    let conflict_filename = if ext.is_empty() {
        format!("{stem} (冲突副本 {origin_tag} {ts}_{sha6})")
    } else {
        format!("{stem} (冲突副本 {origin_tag} {ts}_{sha6}).{ext}")
    };
    let conflict_rel = match parent {
        Some(p) if !p.as_os_str().is_empty() => {
            let p_str = p
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            format!("{p_str}/{conflict_filename}")
        }
        _ => conflict_filename,
    };
    let target = workspace.join(&conflict_rel);
    if let Some(tp) = target.parent() {
        let _ = std::fs::create_dir_all(tp);
    }
    if std::fs::write(&target, conflicting_bytes).is_ok() {
        Some(conflict_rel)
    } else {
        None
    }
}

fn normalize_workspace_rel(workspace: &Path, file_or_rel: &str) -> Option<String> {
    let p = Path::new(file_or_rel);
    if p.is_absolute() {
        if let Ok(stripped) = p.strip_prefix(workspace) {
            let s = stripped
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if !s.is_empty() {
                return Some(s);
            }
        }
        // Canonicalize parent fallback for macOS /private/var symlinks
        if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
            if let (Ok(canon_parent), Ok(canon_ws)) = (parent.canonicalize(), workspace.canonicalize()) {
                let full_canon = canon_parent.join(name);
                if let Ok(stripped) = full_canon.strip_prefix(&canon_ws) {
                    let s = stripped
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/");
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
        }
        None
    } else {
        let s = file_or_rel.replace('\\', "/").trim_matches('/').to_string();
        if s.is_empty() { None } else { Some(s) }
    }
}

pub fn save_local_version_snapshot(
    workspace: &Path,
    rel_path: &str,
    content: &[u8],
    label: &str,
    max_versions: usize,
) -> Result<Option<SyncVersionEntry>, String> {
    if content.is_empty() {
        return Ok(None);
    }
    let clean_rel = rel_path.replace('\\', "/").trim_matches('/').to_string();
    if clean_rel.is_empty() {
        return Ok(None);
    }
    let sha = sha256_hex(content);
    let slot_dir = version_slot_dir(workspace, &clean_rel);
    std::fs::create_dir_all(&slot_dir)
        .map_err(|e| format!("创建版本历史目录失败: {e}"))?;

    let index_path = slot_dir.join("index.json");
    let mut entries: Vec<SyncVersionEntry> = if index_path.exists() {
        std::fs::read_to_string(&index_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Deduplicate: if any existing snapshot already has identical SHA-256 and same label, or newest has identical SHA-256, skip.
    if entries.first().map(|e| e.sha256.as_str()) == Some(sha.as_str()) {
        return Ok(None);
    }

    let now = now_unix_secs();
    let short_sha = &sha[..8];
    let id = format!("{now}_{short_sha}");
    let snap_path = slot_dir.join(format!("{id}.snap"));
    std::fs::write(&snap_path, content)
        .map_err(|e| format!("写入版本快照失败: {e}"))?;

    let entry = SyncVersionEntry {
        id: id.clone(),
        rel_path: clean_rel,
        sha256: sha,
        size: content.len() as u64,
        created_at: now,
        label: if label.trim().is_empty() {
            "自动保存快照".to_string()
        } else {
            label.trim().to_string()
        },
        device: device_hostname(),
    };
    entries.insert(0, entry.clone());

    let keep = max_versions.max(1);
    while entries.len() > keep {
        if let Some(removed) = entries.pop() {
            let old_snap = slot_dir.join(format!("{}.snap", removed.id));
            let _ = std::fs::remove_file(old_snap);
        }
    }

    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    std::fs::write(&index_path, json)
        .map_err(|e| format!("更新版本索引失败: {e}"))?;

    Ok(Some(entry))
}

pub fn list_local_version_snapshots(
    workspace: &Path,
    rel_path: &str,
) -> Result<Vec<SyncVersionEntry>, String> {
    let slot_dir = version_slot_dir(workspace, rel_path);
    if !slot_dir.is_dir() {
        return Ok(Vec::new());
    }
    let index_path = slot_dir.join("index.json");
    let mut entries: Vec<SyncVersionEntry> = if index_path.exists() {
        std::fs::read_to_string(&index_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    entries.retain(|e| slot_dir.join(format!("{}.snap", e.id)).exists());

    // Self-healing discovery: include any `.snap` files synced from other devices
    // that were not yet merged into `index.json`.
    let known_ids: HashSet<String> = entries.iter().map(|e| e.id.clone()).collect();
    if let Ok(rd) = std::fs::read_dir(&slot_dir) {
        let clean_rel = rel_path.replace('\\', "/").trim_matches('/').to_string();
        for f in rd.flatten() {
            let fp = f.path();
            let Some(name) = fp.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(stem_id) = name.strip_suffix(".snap") else {
                continue;
            };
            if known_ids.contains(stem_id) {
                continue;
            }
            if let Ok(bytes) = std::fs::read(&fp) {
                let sha = sha256_hex(&bytes);
                let ts = stem_id
                    .split('_')
                    .next()
                    .and_then(|t| t.parse::<i64>().ok())
                    .unwrap_or_else(now_unix_secs);
                entries.push(SyncVersionEntry {
                    id: stem_id.to_string(),
                    rel_path: clean_rel.clone(),
                    sha256: sha,
                    size: bytes.len() as u64,
                    created_at: ts,
                    label: "跨设备同步历史快照".to_string(),
                    device: "remote".to_string(),
                });
            }
        }
    }

    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Ok(entries)
}

pub fn read_local_version_snapshot(
    workspace: &Path,
    rel_path: &str,
    version_id: &str,
) -> Result<Vec<u8>, String> {
    let safe_id: String = version_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let slot_dir = version_slot_dir(workspace, rel_path);
    let snap_path = slot_dir.join(format!("{safe_id}.snap"));
    if !snap_path.exists() {
        return Err(format!("未找到历史版本快照: {safe_id}"));
    }
    std::fs::read(&snap_path).map_err(|e| format!("读取历史版本快照失败: {e}"))
}

/// Simple line-based LCS diff between `old_text` (snapshot) and `new_text` (current file).
pub fn compute_snapshot_diff(old_text: &str, new_text: &str, version_id: &str) -> SnapshotDiffResult {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();
    let n = old_lines.len();
    let m = new_lines.len();

    let mut diff_lines = Vec::new();
    // Use LCS DP for reasonable line counts, fallback to prefix/suffix diff for huge files
    if n.saturating_mul(m) <= 400_000 {
        let mut dp = vec![vec![0u32; m + 1]; n + 1];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                if old_lines[i] == new_lines[j] {
                    dp[i][j] = dp[i + 1][j + 1] + 1;
                } else {
                    dp[i][j] = dp[i + 1][j].max(dp[i][j + 1]);
                }
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if old_lines[i] == new_lines[j] {
                diff_lines.push(SnapshotDiffLine {
                    kind: "context".into(),
                    text: old_lines[i].to_string(),
                });
                i += 1;
                j += 1;
            } else if dp[i + 1][j] >= dp[i][j + 1] {
                diff_lines.push(SnapshotDiffLine {
                    kind: "remove".into(),
                    text: old_lines[i].to_string(),
                });
                i += 1;
            } else {
                diff_lines.push(SnapshotDiffLine {
                    kind: "add".into(),
                    text: new_lines[j].to_string(),
                });
                j += 1;
            }
        }
        while i < n {
            diff_lines.push(SnapshotDiffLine {
                kind: "remove".into(),
                text: old_lines[i].to_string(),
            });
            i += 1;
        }
        while j < m {
            diff_lines.push(SnapshotDiffLine {
                kind: "add".into(),
                text: new_lines[j].to_string(),
            });
            j += 1;
        }
    } else {
        for l in &old_lines {
            diff_lines.push(SnapshotDiffLine {
                kind: "remove".into(),
                text: (*l).to_string(),
            });
        }
        for l in &new_lines {
            diff_lines.push(SnapshotDiffLine {
                kind: "add".into(),
                text: (*l).to_string(),
            });
        }
    }

    let mut unified = format!("@@ -1,{} +1,{} @@\n", n, m);
    for l in &diff_lines {
        let prefix = match l.kind.as_str() {
            "add" => '+',
            "remove" => '-',
            _ => ' ',
        };
        unified.push(prefix);
        unified.push_str(&l.text);
        unified.push('\n');
    }

    SnapshotDiffResult {
        from_sha: Some(version_id.to_string()),
        to_sha: "working-copy".into(),
        hunks: vec![SnapshotDiffHunk {
            old_start: 1,
            old_lines: n as u32,
            new_start: 1,
            new_lines: m as u32,
            lines: diff_lines,
        }],
        unified,
    }
}

#[tauri::command]
pub async fn sync_save_file_snapshot(
    workspace: String,
    file_path: String,
    label: Option<String>,
    max_versions: Option<usize>,
) -> Result<Option<SyncVersionEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Path::new(workspace.trim());
        let Some(rel) = normalize_workspace_rel(ws, file_path.trim()) else {
            return Ok(None);
        };
        let full = ws.join(&rel);
        if !full.is_file() {
            return Ok(None);
        }
        let bytes = std::fs::read(&full).map_err(|e| format!("读取文件失败: {e}"))?;
        let lbl = label.unwrap_or_else(|| "保存快照".to_string());
        let max_v = max_versions.unwrap_or(DEFAULT_MAX_VERSIONS);
        save_local_version_snapshot(ws, &rel, &bytes, &lbl, max_v)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn sync_list_file_versions(
    workspace: String,
    file_path: String,
) -> Result<Vec<SyncVersionEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Path::new(workspace.trim());
        let Some(rel) = normalize_workspace_rel(ws, file_path.trim()) else {
            return Ok(Vec::new());
        };
        list_local_version_snapshots(ws, &rel)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn sync_get_file_version_diff(
    workspace: String,
    file_path: String,
    version_id: String,
) -> Result<SnapshotDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Path::new(workspace.trim());
        let rel = normalize_workspace_rel(ws, file_path.trim())
            .ok_or("文件不在当前工作区目录内")?;
        let snap_bytes = read_local_version_snapshot(ws, &rel, &version_id)?;
        let snap_text = String::from_utf8_lossy(&snap_bytes).into_owned();
        let current_path = ws.join(&rel);
        let current_text = if current_path.exists() {
            std::fs::read_to_string(&current_path).unwrap_or_default()
        } else {
            String::new()
        };
        Ok(compute_snapshot_diff(&snap_text, &current_text, &version_id))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn sync_restore_file_version(
    workspace: String,
    file_path: String,
    version_id: String,
    max_versions: Option<usize>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Path::new(workspace.trim());
        let rel = normalize_workspace_rel(ws, file_path.trim())
            .ok_or("文件不在当前工作区目录内")?;
        let snap_bytes = read_local_version_snapshot(ws, &rel, &version_id)?;
        let target = ws.join(&rel);
        let max_v = max_versions.unwrap_or(DEFAULT_MAX_VERSIONS);
        if target.exists() {
            if let Ok(cur_bytes) = std::fs::read(&target) {
                let _ = save_local_version_snapshot(
                    ws,
                    &rel,
                    &cur_bytes,
                    "版本回滚前自动备份",
                    max_v,
                );
            }
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::write(&target, &snap_bytes)
            .map_err(|e| format!("写入恢复文件失败: {e}"))?;
        Ok(String::from_utf8_lossy(&snap_bytes).into_owned())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn sync_prune_file_versions(
    workspace: String,
    file_path: Option<String>,
    keep: usize,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = Path::new(workspace.trim());
        let versions_root = ws.join(SYNC_VERSIONS_REL);
        if !versions_root.is_dir() {
            return Ok(0);
        }
        let keep_count = keep.max(1);
        let mut pruned = 0usize;

        let target_slots: Vec<PathBuf> = if let Some(fp) = file_path {
            if let Some(rel) = normalize_workspace_rel(ws, fp.trim()) {
                vec![version_slot_dir(ws, &rel)]
            } else {
                vec![]
            }
        } else {
            std::fs::read_dir(&versions_root)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        };

        for slot in target_slots {
            let idx_path = slot.join("index.json");
            if !idx_path.is_file() {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&idx_path) {
                if let Ok(mut entries) = serde_json::from_str::<Vec<SyncVersionEntry>>(&raw) {
                    while entries.len() > keep_count {
                        if let Some(old) = entries.pop() {
                            let _ = std::fs::remove_file(slot.join(format!("{}.snap", old.id)));
                            pruned += 1;
                        }
                    }
                    if let Ok(json) = serde_json::to_string_pretty(&entries) {
                        let _ = std::fs::write(&idx_path, json);
                    }
                }
            }
        }
        Ok(pruned)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Auto-detect installed personal cloud drive sync folders on the local computer
/// (Baidu Netdisk, Aliyun Drive, OneDrive, iCloud Drive, Dropbox, Nutstore, Quark Drive).
#[tauri::command]
pub fn cloud_vault_detect_local_dirs() -> Vec<DetectedCloudDir> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let home_dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from));

    let mut candidates: Vec<(String, String, PathBuf)> = Vec::new();

    if let Some(ref h) = home_dir {
        candidates.push(("baidu".into(), "百度网盘同步空间".into(), h.join("BaiduNetdiskWorkspace")));
        candidates.push(("baidu".into(), "百度网盘同步盘".into(), h.join("百度网盘同步空间")));
        candidates.push(("baidu".into(), "百度网盘".into(), h.join("BaiduNetdisk")));
        candidates.push(("onedrive".into(), "OneDrive".into(), h.join("OneDrive")));
        candidates.push(("dropbox".into(), "Dropbox".into(), h.join("Dropbox")));
        candidates.push(("gdrive".into(), "Google Drive".into(), h.join("Google Drive")));
        candidates.push(("gdrive".into(), "Google Drive (My Drive)".into(), h.join("My Drive")));
        candidates.push(("nutstore".into(), "坚果云 (Nutstore)".into(), h.join("Nutstore Files")));
        candidates.push(("nutstore".into(), "我的坚果云".into(), h.join("我的坚果云")));
        candidates.push(("alipan".into(), "阿里云盘".into(), h.join("AliyunDrive")));
        candidates.push(("quark".into(), "夸克网盘".into(), h.join("QuarkDrive")));
        candidates.push(("123pan".into(), "123云盘".into(), h.join("123Pan")));
        candidates.push(("189cloud".into(), "天翼云盘".into(), h.join("天翼云盘")));
        candidates.push(("mega".into(), "MEGA".into(), h.join("MEGA")));
        candidates.push(("pcloud".into(), "pCloud".into(), h.join("pCloud Drive")));
        candidates.push((
            "icloud".into(),
            "iCloud Drive".into(),
            h.join("Library/Mobile Documents/com~apple~CloudDocs"),
        ));

        let cloud_storage = h.join("Library/CloudStorage");
        if let Ok(entries) = std::fs::read_dir(&cloud_storage) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    let lower = name.to_ascii_lowercase();
                    if lower.contains("baidunetdisk") {
                        candidates.push(("baidu".into(), format!("百度网盘 ({name})"), p));
                    } else if lower.contains("onedrive") {
                        candidates.push(("onedrive".into(), format!("OneDrive ({name})"), p));
                    } else if lower.contains("dropbox") {
                        candidates.push(("dropbox".into(), format!("Dropbox ({name})"), p));
                    } else if lower.contains("googledrive") {
                        let my_drive = p.join("My Drive");
                        let cn_drive = p.join("我的云端硬盘");
                        if my_drive.is_dir() {
                            candidates.push(("gdrive".into(), format!("Google Drive ({name})"), my_drive));
                        } else if cn_drive.is_dir() {
                            candidates.push(("gdrive".into(), format!("Google Drive ({name})"), cn_drive));
                        } else {
                            candidates.push(("gdrive".into(), format!("Google Drive ({name})"), p));
                        }
                    } else if lower.contains("aliyundrive") || lower.contains("adrive") {
                        candidates.push(("alipan".into(), format!("阿里云盘 ({name})"), p));
                    }
                }
            }
        }
    }

    // Windows common drive letters for Baidu Netdisk / Aliyun Drive / Nutstore / Google Drive
    for drive in ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\"] {
        let root = PathBuf::from(drive);
        if root.is_dir() {
            candidates.push(("baidu".into(), format!("百度网盘同步空间 ({drive})"), root.join("BaiduNetdiskWorkspace")));
            candidates.push(("baidu".into(), format!("百度网盘下载/同步 ({drive})"), root.join("BaiduNetdiskDownload")));
            candidates.push(("baidu".into(), format!("百度网盘 ({drive})"), root.join("百度网盘同步空间")));
            candidates.push(("alipan".into(), format!("阿里云盘 ({drive})"), root.join("AliyunDrive")));
            candidates.push(("quark".into(), format!("夸克网盘 ({drive})"), root.join("QuarkDrive")));
            candidates.push(("nutstore".into(), format!("我的坚果云 ({drive})"), root.join("我的坚果云")));
            candidates.push(("gdrive".into(), format!("Google Drive ({drive})"), root.join("My Drive")));
            candidates.push(("gdrive".into(), format!("Google Drive ({drive})"), root.join("我的云端硬盘")));
            candidates.push(("123pan".into(), format!("123云盘 ({drive})"), root.join("123云盘")));
            candidates.push(("189cloud".into(), format!("天翼云盘 ({drive})"), root.join("天翼云盘")));
        }
    }

    for (provider, label, base_path) in candidates {
        if base_path.is_dir() {
            let base_str = base_path.to_string_lossy().into_owned();
            if seen.insert(base_str.clone()) {
                let suggested = base_path.join("SoloMD").to_string_lossy().into_owned();
                out.push(DetectedCloudDir {
                    provider,
                    label,
                    base_dir: base_str,
                    suggested_vault_dir: suggested,
                });
            }
        }
    }
    out
}

#[tauri::command]
pub fn cloud_api_build_quick_auth_url(
    provider: String,
    client_id: Option<String>,
) -> Result<QuickAuthInfo, String> {
    let prov = provider.trim().to_ascii_lowercase();
    let custom_cid = client_id.unwrap_or_default().trim().to_string();
    match prov.as_str() {
        "baidu" => {
            let cid = if custom_cid.is_empty() {
                DEFAULT_BAIDU_OAUTH_CLIENT_ID
            } else {
                custom_cid.as_str()
            };
            let auth_url = format!(
                "https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&client_id={}&redirect_uri=oob&scope=basic,netdisk&display=page",
                percent_encode_segment(cid)
            );
            Ok(QuickAuthInfo {
                auth_url,
                instructions: "在打开的百度网盘授权页扫码/确认登录 → 跳转后直接复制浏览器地址栏中的整段网址（或 access_token）→ 粘贴到下方 Token 输入框即可自动识别，无需申请 SecretKey！".into(),
            })
        }
        "alipan" => {
            let cid = if custom_cid.is_empty() {
                DEFAULT_ALIPAN_OAUTH_CLIENT_ID
            } else {
                custom_cid.as_str()
            };
            let auth_url = format!(
                "https://openapi.alipan.com/oauth/authorize?client_id={}&redirect_uri=oob&scope=user:base,file:all:read,file:all:write&response_type=token",
                percent_encode_segment(cid)
            );
            Ok(QuickAuthInfo {
                auth_url,
                instructions: "在打开的阿里云盘授权页面扫码登录 → 授权成功后复制跳转地址栏中的整段网址（或 access_token）→ 粘贴到下方 Token 输入框即可自动提取。".into(),
            })
        }
        "onedrive" => {
            let cid = if custom_cid.is_empty() {
                DEFAULT_ONEDRIVE_OAUTH_CLIENT_ID
            } else {
                custom_cid.as_str()
            };
            let auth_url = format!(
                "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id={}&response_type=token&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient&scope=Files.ReadWrite",
                percent_encode_segment(cid)
            );
            Ok(QuickAuthInfo {
                auth_url,
                instructions: "在浏览器完成微软 OneDrive 账号授权后，复制跳转后地址栏中的整段 URL（含 #access_token=...）粘贴到下方 Token 输入框即可自动提取 Token，或使用下方「设备码扫码登录」。".into(),
            })
        }
        "dropbox" => {
            let cid = if custom_cid.is_empty() {
                DEFAULT_DROPBOX_OAUTH_CLIENT_ID
            } else {
                custom_cid.as_str()
            };
            let auth_url = format!(
                "https://www.dropbox.com/oauth2/authorize?client_id={}&response_type=token&redirect_uri=https://localhost",
                percent_encode_segment(cid)
            );
            Ok(QuickAuthInfo {
                auth_url,
                instructions: "在浏览器完成 Dropbox 授权后，即使 localhost 页面提示无法连接，只需复制浏览器地址栏中的整段 URL（含 #access_token=...）粘贴到下方 Token 输入框即可自动提取 Token！".into(),
            })
        }
        "gdrive" => {
            let cid = if custom_cid.is_empty() {
                DEFAULT_GDRIVE_OAUTH_CLIENT_ID
            } else {
                custom_cid.as_str()
            };
            let auth_url = format!(
                "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri=https://developers.google.com/oauthplayground&response_type=token&scope=https://www.googleapis.com/auth/drive.file",
                percent_encode_segment(cid)
            );
            Ok(QuickAuthInfo {
                auth_url,
                instructions: "在打开的 Google 账号授权页完成授权后，复制跳转地址栏中的整段 URL（含 #access_token=...）粘贴到下方 Token 输入框即可自动识别！".into(),
            })
        }
        other => Err(format!("暂不支持 {other} 免 Key 快捷跳转，请直接粘贴凭证")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudVaultManifest {
    pub version: u8,
    pub salt: String,
    pub kdf: super::crypto::KdfParams,
    pub probe: String,
}

fn create_vault_manifest(passphrase: &str) -> Result<(CloudVaultManifest, [u8; 32]), String> {
    let pass = passphrase.trim();
    if pass.is_empty() {
        return Err("请先设置加密口令 (Encryption passphrase is required)".into());
    }
    let salt = super::crypto::random_bytes(16);
    let kdf = super::crypto::KdfParams::default();
    let key = super::crypto::derive_key(pass, &salt, &kdf)?;
    let probe_bytes = super::crypto::encrypt_bytes(&key, VAULT_PROBE_AAD, VAULT_PROBE_PLAIN)?;
    let manifest = CloudVaultManifest {
        version: 1,
        salt: super::crypto::hex_encode(&salt),
        kdf,
        probe: super::crypto::hex_encode(&probe_bytes),
    };
    Ok((manifest, key))
}

fn unlock_vault_manifest(
    manifest: &CloudVaultManifest,
    passphrase: &str,
) -> Result<[u8; 32], String> {
    let pass = passphrase.trim();
    if pass.is_empty() {
        return Err("需要输入加密口令才能解密同步 (Encryption passphrase is required)".into());
    }
    let salt = super::crypto::hex_decode(&manifest.salt)?;
    let key = super::crypto::derive_key(pass, &salt, &manifest.kdf)?;
    let probe_bytes = super::crypto::hex_decode(&manifest.probe)?;
    let decrypted = super::crypto::decrypt_bytes(&key, VAULT_PROBE_AAD, &probe_bytes)
        .map_err(|_| "加密口令不正确，无法解密该网盘库 (Incorrect encryption passphrase)".to_string())?;
    if decrypted != VAULT_PROBE_PLAIN {
        return Err("加密口令校验失败 (Encryption probe mismatch)".into());
    }
    Ok(key)
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("SoloMD-WebDAV/5.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn normalize_remote_path(remote_path: &str) -> String {
    let trimmed = remote_path.trim().replace('\\', "/");
    let stripped = trimmed.trim_matches('/');
    if stripped.is_empty() {
        String::new()
    } else {
        format!("/{stripped}")
    }
}

fn percent_encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for &b in seg.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn encode_rel_segments(rel: &str) -> String {
    rel.split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn build_target_url(base_url: &str, remote_path: &str, rel_path: &str) -> String {
    let base = normalize_base_url(base_url);
    let root = normalize_remote_path(remote_path);
    let root_encoded = if root.is_empty() {
        String::new()
    } else {
        format!("/{}", encode_rel_segments(&root[1..]))
    };
    let rel_encoded = encode_rel_segments(rel_path);
    if rel_encoded.is_empty() {
        format!("{base}{root_encoded}/")
    } else {
        format!("{base}{root_encoded}/{rel_encoded}")
    }
}

async fn ensure_remote_dir(
    client: &reqwest::Client,
    base_url: &str,
    remote_path: &str,
    rel_dir: &str,
    username: &str,
    password: &str,
    created_cache: &mut HashSet<String>,
) -> Result<(), String> {
    let mut parts: Vec<String> = Vec::new();
    let root = normalize_remote_path(remote_path);
    if !root.is_empty() {
        for seg in root.trim_matches('/').split('/') {
            if !seg.is_empty() {
                parts.push(seg.to_string());
            }
        }
    }
    for seg in rel_dir.trim_matches('/').split('/') {
        if !seg.is_empty() && seg != "." {
            parts.push(seg.to_string());
        }
    }

    let base = normalize_base_url(base_url);
    let mut current = String::new();
    for seg in parts {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(&seg);
        if created_cache.contains(&current) {
            continue;
        }
        let encoded = encode_rel_segments(&current);
        let dir_url = format!("{base}/{encoded}/");
        let mkcol = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;
        let resp = client
            .request(mkcol, &dir_url)
            .basic_auth(username, Some(password))
            .send()
            .await
            .map_err(|e| format!("MKCOL {dir_url} failed: {e}"))?;
        let code = resp.status().as_u16();
        // 201 Created, 405 Method Not Allowed (already exists), 301/200/409
        if code == 401 || code == 403 {
            return Err(format!("Authentication failed (HTTP {code})"));
        }
        created_cache.insert(current.clone());
    }
    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.')
        || name == "node_modules"
        || name == "target"
        || name == "dist"
}

fn should_sync_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.starts_with('.') || name == "Thumbs.db" || name == ".DS_Store" {
        return false;
    }
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "txt" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "pdf" | "bib" | "csl"
    )
}

fn collect_local_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if should_skip_dir(name) {
                continue;
            }
            collect_local_files(root, &path, out);
        } else if path.is_file() && should_sync_file(&path) {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                if !rel_str.is_empty() {
                    out.push((rel_str, path));
                }
            }
        }
    }
}

/// Extract `<d:href>` / `<D:href>` / `<href>` entries from a WebDAV `PROPFIND` XML response,
/// paired with whether the `<response>` contains `<collection/>`.
fn parse_propfind_xml(xml: &str) -> Vec<(String, bool)> {
    let mut results = Vec::new();
    let lower = xml.to_ascii_lowercase();
    let mut pos = 0;
    while let Some(resp_start) = lower[pos..].find("response") {
        let abs_start = pos + resp_start;
        // Ensure it's an opening tag `<d:response` or `<response`
        if abs_start == 0 || !matches!(xml.as_bytes()[abs_start - 1], b'<' | b':') {
            pos = abs_start + 8;
            continue;
        }
        let Some(resp_end_rel) = lower[abs_start..].find("response>") else {
            break;
        };
        let block_end = abs_start + resp_end_rel + 9;
        let block = &xml[abs_start..block_end];
        let block_lower = &lower[abs_start..block_end];
        pos = block_end;

        // Extract href
        if let Some(href_open) = block_lower.find("href>") {
            let content_start = href_open + 5;
            if let Some(href_close) = block_lower[content_start..].find("href>") {
                let raw_inside = &block[content_start..content_start + href_close];
                // Strip trailing `</d:` or `</`
                let href = raw_inside
                    .trim_end_matches(|c: char| c != '<')
                    .trim_end_matches('<')
                    .trim();
                let is_collection = block_lower.contains(":collection")
                    || block_lower.contains("<collection");
                if !href.is_empty() {
                    results.push((href.to_string(), is_collection));
                }
            }
        }
    }
    results
}

#[tauri::command]
pub async fn webdav_test_connection(
    url: String,
    username: String,
    password: String,
    remote_path: String,
) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("WebDAV server URL is required".into());
    }
    let client = build_client()?;
    let target = build_target_url(&url, &remote_path, "");
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;
    let resp = client
        .request(propfind.clone(), &target)
        .header("Depth", "0")
        .basic_auth(username.trim(), Some(password.as_str()))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(format!("Authentication failed (HTTP {status})"));
    }
    if status == 404 {
        // Attempt to create the remote folder automatically
        let mut cache = HashSet::new();
        ensure_remote_dir(
            &client,
            &url,
            &remote_path,
            "",
            username.trim(),
            password.as_str(),
            &mut cache,
        )
        .await?;
        return Ok("Connected (created remote folder)".into());
    }
    if (200..300).contains(&status) || status == 207 {
        return Ok(format!("Connected (HTTP {status})"));
    }
    Err(format!("WebDAV server returned HTTP {status}"))
}

#[tauri::command]
pub async fn webdav_push_workspace(
    app: tauri::AppHandle,
    workspace: String,
    url: String,
    username: String,
    password: String,
    remote_path: String,
    encrypted: Option<bool>,
    passphrase: Option<String>,
    auto_workspace_subdir: Option<bool>,
    categorize_files: Option<bool>,
    max_versions: Option<usize>,
) -> Result<WebdavSyncResult, String> {
    set_sync_app_handle(&app);
    let ws_path = PathBuf::from(workspace.trim());
    if !ws_path.is_dir() {
        return Err("Open a workspace folder before syncing".into());
    }
    if url.trim().is_empty() {
        return Err("Configure WebDAV server URL in Settings › Sync first".into());
    }

    let use_encryption = encrypted.unwrap_or(false);
    let pass_str = passphrase.unwrap_or_default();
    let auto_sub = auto_workspace_subdir.unwrap_or(true);
    let cat_files = categorize_files.unwrap_or(false);
    let max_v = max_versions.unwrap_or(DEFAULT_MAX_VERSIONS);

    let target_remote = resolve_remote_workspace_dir("webdav", &remote_path, &ws_path, auto_sub);

    let mut files = Vec::new();
    collect_local_files(&ws_path, &ws_path, &mut files);
    let total_files = files.len();
    emit_sync_progress(
        "webdav",
        "push",
        0,
        total_files.max(1),
        format!("正在连接 WebDAV 服务器 ({target_remote})，共扫描到 {total_files} 个本地文件…"),
    );

    let client = build_client()?;
    let mut created_dirs = HashSet::new();
    ensure_remote_dir(
        &client,
        &url,
        &target_remote,
        "",
        username.trim(),
        password.as_str(),
        &mut created_dirs,
    )
    .await?;

    let enc_key: Option<[u8; 32]> = if use_encryption {
        let manifest_url = build_target_url(&url, &target_remote, VAULT_MANIFEST_NAME);
        let existing_resp = client
            .get(&manifest_url)
            .basic_auth(username.trim(), Some(password.as_str()))
            .send()
            .await
            .map_err(|e| format!("Failed to check remote vault manifest: {e}"))?;
        let key = if existing_resp.status().is_success() {
            let text = existing_resp.text().await.unwrap_or_default();
            let manifest: CloudVaultManifest = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid remote solomd-vault.json: {e}"))?;
            unlock_vault_manifest(&manifest, &pass_str)?
        } else {
            let (manifest, k) = create_vault_manifest(&pass_str)?;
            let manifest_json = serde_json::to_string_pretty(&manifest)
                .map_err(|e| e.to_string())?;
            let put_resp = client
                .put(&manifest_url)
                .basic_auth(username.trim(), Some(password.as_str()))
                .body(manifest_json.into_bytes())
                .send()
                .await
                .map_err(|e| format!("Failed to upload vault manifest: {e}"))?;
            if !put_resp.status().is_success() {
                return Err(format!(
                    "Failed to upload solomd-vault.json (HTTP {})",
                    put_resp.status()
                ));
            }
            k
        };
        Some(key)
    } else {
        None
    };

    // Fetch remote `.solomd-sync/manifest.json` if present for incremental SHA-256 skipping & 3-way conflict check
    let sync_manifest_url = build_target_url(&url, &target_remote, SYNC_MANIFEST_REL);
    let mut folder_manifest: SyncFolderManifest = match client
        .get(&sync_manifest_url)
        .basic_auth(username.trim(), Some(password.as_str()))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let b = r.bytes().await.unwrap_or_default();
            serde_json::from_slice(&b).unwrap_or_default()
        }
        _ => SyncFolderManifest {
            version: 1,
            workspace_name: workspace_folder_name(&ws_path),
            updated_at: now_unix_secs(),
            encrypted: use_encryption,
            vault_crypto: None,
            files: BTreeMap::new(),
        },
    };

    let local_base = read_local_base_manifest(&ws_path);
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut new_files_map = BTreeMap::new();

    for (idx, (rel, full_path)) in files.into_iter().enumerate() {
        let plain_bytes = std::fs::read(&full_path)
            .map_err(|e| format!("Failed to read {rel}: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, cat_files);
        let remote_rel = if use_encryption {
            format!("{cat_rel}.enc")
        } else {
            cat_rel.clone()
        };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        let mut stale_remote_rel: Option<String> = None;
        if let Some(prev) = folder_manifest.files.get(&rel) {
            if prev.sha256 == sha && prev.remote_rel == remote_rel && prev.encrypted == use_encryption {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                emit_sync_progress(
                    "webdav",
                    "push",
                    idx + 1,
                    total_files.max(1),
                    format!("[{}/{}] 跳过未改动: {rel}", idx + 1, total_files),
                );
                continue;
            }
            if prev.remote_rel == remote_rel && prev.encrypted == use_encryption && base_sha == Some(sha.as_str()) {
                // Local file was NOT modified on this device since last sync, while another device updated WebDAV
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                emit_sync_progress(
                    "webdav",
                    "push",
                    idx + 1,
                    total_files.max(1),
                    format!("[{}/{}] 保留云端更新: {rel}", idx + 1, total_files),
                );
                continue;
            }
            if prev.remote_rel != remote_rel {
                stale_remote_rel = Some(prev.remote_rel.clone());
            }
            let _ = save_local_version_snapshot(&ws_path, &rel, &plain_bytes, "WebDAV 同步快照", max_v);
        } else {
            let _ = save_local_version_snapshot(&ws_path, &rel, &plain_bytes, "首次 WebDAV 同步快照", max_v);
        }

        emit_sync_progress(
            "webdav",
            "push",
            idx,
            total_files.max(1),
            format!("[{}/{}] 正在上传: {rel}", idx + 1, total_files),
        );

        if let Some((parent, _)) = remote_rel.rsplit_once('/') {
            ensure_remote_dir(
                &client,
                &url,
                &target_remote,
                parent,
                username.trim(),
                password.as_str(),
                &mut created_dirs,
            )
            .await?;
        }

        let upload_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let file_url = build_target_url(&url, &target_remote, &remote_rel);
        let resp = client
            .put(&file_url)
            .basic_auth(username.trim(), Some(password.as_str()))
            .body(upload_bytes)
            .send()
            .await
            .map_err(|e| format!("Failed to upload {remote_rel}: {e}"))?;
        let code = resp.status().as_u16();
        if code == 401 || code == 403 {
            return Err(format!(
                "Authentication failed while uploading {remote_rel} (HTTP {code})"
            ));
        }
        if !(200..300).contains(&code) {
            return Err(format!("Upload failed for {remote_rel} (HTTP {code})"));
        }
        if let Some(old_rel) = stale_remote_rel {
            let old_url = build_target_url(&url, &target_remote, &old_rel);
            let _ = client
                .delete(&old_url)
                .basic_auth(username.trim(), Some(password.as_str()))
                .send()
                .await;
        }
        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted: use_encryption,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "webdav",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已上传: {rel}", idx + 1, total_files),
        );
    }

    for (rem_rel_key, rem_entry) in &folder_manifest.files {
        if !new_files_map.contains_key(rem_rel_key) {
            let was_deleted_locally = local_base
                .as_ref()
                .map(|b| b.files.contains_key(rem_rel_key))
                .unwrap_or(false);
            if !was_deleted_locally {
                new_files_map.insert(rem_rel_key.clone(), rem_entry.clone());
            }
        }
    }

    folder_manifest.version = 1;
    folder_manifest.workspace_name = workspace_folder_name(&ws_path);
    folder_manifest.updated_at = now_unix_secs();
    folder_manifest.encrypted = use_encryption;
    folder_manifest.files = new_files_map;

    write_local_base_manifest(&ws_path, &folder_manifest);
    if ensure_remote_dir(
        &client,
        &url,
        &target_remote,
        SYNC_META_DIR,
        username.trim(),
        password.as_str(),
        &mut created_dirs,
    )
    .await
    .is_ok()
    {
        if let Ok(m_bytes) = serde_json::to_vec_pretty(&folder_manifest) {
            let _ = client
                .put(&sync_manifest_url)
                .basic_auth(username.trim(), Some(password.as_str()))
                .body(m_bytes)
                .send()
                .await;
        }
    }

    let msg = if use_encryption {
        format!("已端到端加密上传 {uploaded} 个文件到 WebDAV ({target_remote}，跳过未改动 {skipped} 个)")
    } else {
        format!("已增量同步 {uploaded} 个文件到 WebDAV ({target_remote}，跳过未改动 {skipped} 个)")
    };
    emit_sync_progress("webdav", "push", 100, 100, &msg);

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: msg,
    })
}

#[tauri::command]
pub async fn webdav_pull_workspace(
    app: tauri::AppHandle,
    workspace: String,
    url: String,
    username: String,
    password: String,
    remote_path: String,
    encrypted: Option<bool>,
    passphrase: Option<String>,
    auto_workspace_subdir: Option<bool>,
    categorize_files: Option<bool>,
    max_versions: Option<usize>,
) -> Result<WebdavSyncResult, String> {
    set_sync_app_handle(&app);
    let ws_path = PathBuf::from(workspace.trim());
    if !ws_path.is_dir() {
        return Err("Open a workspace folder before syncing".into());
    }
    if url.trim().is_empty() {
        return Err("Configure WebDAV server URL in Settings › Sync first".into());
    }

    emit_sync_progress(
        "webdav",
        "pull",
        5,
        100,
        format!("正在连接 WebDAV 服务器 ({url})，读取远程目录清单…"),
    );

    let client = build_client()?;
    let pass_str = passphrase.unwrap_or_default();
    let auto_sub = auto_workspace_subdir.unwrap_or(true);
    let cat_files = categorize_files.unwrap_or(false);
    let max_v = max_versions.unwrap_or(DEFAULT_MAX_VERSIONS);

    // Check dedicated workspace subdir first; fallback to raw `remote_path` if subdir 404s
    let candidate_remote = resolve_remote_workspace_dir("webdav", &remote_path, &ws_path, auto_sub);
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;
    let probe_url = build_target_url(&url, &candidate_remote, "");
    let target_remote = match client
        .request(propfind.clone(), &probe_url)
        .header("Depth", "0")
        .basic_auth(username.trim(), Some(password.as_str()))
        .send()
        .await
    {
        Ok(r) if r.status().as_u16() == 404 && candidate_remote != normalize_remote_path(&remote_path) => {
            remote_path.clone()
        }
        _ => candidate_remote,
    };

    // Check if the remote folder has a `solomd-vault.json` encrypted manifest.
    let manifest_url = build_target_url(&url, &target_remote, VAULT_MANIFEST_NAME);
    let manifest_resp = client
        .get(&manifest_url)
        .basic_auth(username.trim(), Some(password.as_str()))
        .send()
        .await;

    let enc_key: Option<[u8; 32]> = match manifest_resp {
        Ok(r) if r.status().is_success() => {
            let text = r.text().await.unwrap_or_default();
            if let Ok(manifest) = serde_json::from_str::<CloudVaultManifest>(&text) {
                Some(unlock_vault_manifest(&manifest, &pass_str)?)
            } else if encrypted.unwrap_or(false) {
                return Err("远程网盘未找到有效的加密元数据 solomd-vault.json".into());
            } else {
                None
            }
        }
        _ => {
            if encrypted.unwrap_or(false) {
                return Err("远程网盘尚未初始化加密库 (Remote encrypted vault not found — push first)".into());
            }
            None
        }
    };

    let sync_manifest_url = build_target_url(&url, &target_remote, SYNC_MANIFEST_REL);
    let folder_manifest: Option<SyncFolderManifest> = match client
        .get(&sync_manifest_url)
        .basic_auth(username.trim(), Some(password.as_str()))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let b = r.bytes().await.unwrap_or_default();
            serde_json::from_slice(&b).ok()
        }
        _ => None,
    };

    let mut remote_to_entry: BTreeMap<String, SyncFileManifestEntry> = BTreeMap::new();
    if let Some(ref fm) = folder_manifest {
        for entry in fm.files.values() {
            remote_to_entry.insert(entry.remote_rel.clone(), entry.clone());
        }
    }
    let local_base = read_local_base_manifest(&ws_path);

    // Breadth-first `Depth: 1` traversal (works on all WebDAV servers including
    // 坚果云 Nutstore and Nextcloud, which reject `Depth: infinity`).
    let mut queue: Vec<String> = vec![String::new()];
    let mut visited_dirs: HashSet<String> = HashSet::new();
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;

    while let Some(rel_dir) = queue.pop() {
        if !visited_dirs.insert(rel_dir.clone()) {
            continue;
        }
        let dir_url = build_target_url(&url, &target_remote, &rel_dir);
        let resp = client
            .request(propfind.clone(), &dir_url)
            .header("Depth", "1")
            .basic_auth(username.trim(), Some(password.as_str()))
            .send()
            .await
            .map_err(|e| format!("PROPFIND failed: {e}"))?;

        let status = resp.status().as_u16();
        if status == 404 && rel_dir.is_empty() {
            return Ok(WebdavSyncResult {
                uploaded: 0,
                downloaded: 0,
                message: "Remote WebDAV folder is empty".into(),
            });
        }
        if status == 401 || status == 403 {
            return Err(format!("Authentication failed (HTTP {status})"));
        }
        if !(200..300).contains(&status) && status != 207 {
            return Err(format!("WebDAV PROPFIND returned HTTP {status}"));
        }

        let xml = resp.text().await.unwrap_or_default();
        let entries = parse_propfind_xml(&xml);
        for (idx, (href, is_collection)) in entries.into_iter().enumerate() {
            let decoded = percent_decode(&href);
            let trimmed_href = decoded.trim_end_matches('/');
            let Some(leaf) = trimmed_href.rsplit('/').next() else {
                continue;
            };
            if leaf.is_empty() || leaf.starts_with('.') || leaf == VAULT_MANIFEST_NAME || leaf == SYNC_META_DIR {
                continue;
            }
            if idx == 0 {
                continue;
            }
            let child_rel = if rel_dir.is_empty() {
                leaf.to_string()
            } else {
                format!("{rel_dir}/{leaf}")
            };
            if is_collection {
                if !should_skip_dir(leaf) && visited_dirs.len() < 200 {
                    queue.push(child_rel);
                }
            } else {
                let manifest_entry = remote_to_entry.get(&child_rel);
                let local_rel = if let Some(me) = manifest_entry {
                    me.local_rel.clone()
                } else {
                    let stripped = child_rel.strip_suffix(".enc").unwrap_or(&child_rel);
                    unmap_categorized_rel_path(stripped, cat_files)
                };
                let local_target = ws_path.join(&local_rel);
                if !should_sync_file(&local_target) {
                    continue;
                }

                if let Some(me) = manifest_entry {
                    if local_target.exists() {
                        if let Ok(existing_bytes) = std::fs::read(&local_target) {
                            if sha256_hex(&existing_bytes) == me.sha256 {
                                skipped += 1;
                                let total_est = remote_to_entry.len().max(downloaded + skipped + 1);
                                emit_sync_progress(
                                    "webdav",
                                    "pull",
                                    downloaded + skipped,
                                    total_est,
                                    format!("跳过未改动: {local_rel}"),
                                );
                                continue;
                            }
                        }
                    }
                }

                let total_est = remote_to_entry.len().max(downloaded + skipped + 1);
                emit_sync_progress(
                    "webdav",
                    "pull",
                    downloaded + skipped,
                    total_est,
                    format!("正在下载: {local_rel}"),
                );
                let file_url = build_target_url(&url, &target_remote, &child_rel);
                let get_resp = client
                    .get(&file_url)
                    .basic_auth(username.trim(), Some(password.as_str()))
                    .send()
                    .await
                    .map_err(|e| format!("Failed to download {child_rel}: {e}"))?;
                if !get_resp.status().is_success() {
                    continue;
                }
                let raw_bytes = get_resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Read error for {child_rel}: {e}"))?
                    .to_vec();
                let plain_bytes = if child_rel.ends_with(".enc") {
                    let Some(ref key) = enc_key else {
                        continue;
                    };
                    let stripped = child_rel.strip_suffix(".enc").unwrap_or(&child_rel);
                    super::crypto::decrypt_bytes(key, &local_rel, &raw_bytes)
                        .or_else(|_| super::crypto::decrypt_bytes(key, stripped, &raw_bytes))?
                } else {
                    raw_bytes
                };

                if local_target.exists() {
                    if let Ok(existing) = std::fs::read(&local_target) {
                        if existing != plain_bytes {
                            let local_sha = sha256_hex(&existing);
                            let remote_sha = sha256_hex(&plain_bytes);
                            let base_sha = local_base
                                .as_ref()
                                .and_then(|m| m.files.get(&local_rel))
                                .map(|e| e.sha256.as_str());
                            if base_sha == Some(remote_sha.as_str()) {
                                skipped += 1;
                                continue;
                            }
                            if base_sha != Some(local_sha.as_str()) {
                                let _ = save_local_version_snapshot(
                                    &ws_path,
                                    &local_rel,
                                    &existing,
                                    "WebDAV 多端冲突备份 (本地修改)",
                                    max_v,
                                );
                                let _ = write_conflict_copy_file(
                                    &ws_path,
                                    &local_rel,
                                    &existing,
                                    &device_hostname(),
                                );
                                conflicts += 1;
                            } else {
                                let _ = save_local_version_snapshot(
                                    &ws_path,
                                    &local_rel,
                                    &existing,
                                    "WebDAV 拉取覆盖前备份",
                                    max_v,
                                );
                            }
                        } else {
                            skipped += 1;
                            continue;
                        }
                    }
                }
                if let Some(parent) = local_target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&local_target, &plain_bytes)
                    .map_err(|e| format!("Write error for {local_rel}: {e}"))?;
                downloaded += 1;
                let total_est = remote_to_entry.len().max(downloaded + skipped);
                emit_sync_progress(
                    "webdav",
                    "pull",
                    downloaded + skipped,
                    total_est,
                    format!("已下载还原: {local_rel}"),
                );
            }
        }
    }

    if let Some(ref fm) = folder_manifest {
        write_local_base_manifest(&ws_path, fm);
    }

    let conflict_note = if conflicts > 0 {
        format!("，检测到 {conflicts} 处多端冲突并已保存冲突副本")
    } else {
        String::new()
    };
    let msg = if enc_key.is_some() {
        format!("已从 WebDAV ({target_remote}) 下载并解密 {downloaded} 个文件（跳过未改动 {skipped} 个{conflict_note}）")
    } else {
        format!("已从 WebDAV ({target_remote}) 同步更新 {downloaded} 个文件（跳过未改动 {skipped} 个{conflict_note}）")
    };
    emit_sync_progress("webdav", "pull", 100, 100, &msg);

    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: msg,
    })
}

fn merge_version_slot_dirs(slot_a: &Path, slot_b: &Path) {
    let _ = std::fs::create_dir_all(slot_a);
    let _ = std::fs::create_dir_all(slot_b);

    // 1. Copy missing `.snap` files in both directions (content-addressed IDs never collide)
    for (from_dir, to_dir) in [(slot_a, slot_b), (slot_b, slot_a)] {
        if let Ok(files) = std::fs::read_dir(from_dir) {
            for f in files.flatten() {
                let fp = f.path();
                if !fp.is_file() {
                    continue;
                }
                let Some(fname) = fp.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if fname == "index.json" {
                    continue;
                }
                let dst_fp = to_dir.join(fname);
                if !dst_fp.exists() {
                    let _ = std::fs::copy(&fp, &dst_fp);
                }
            }
        }
    }

    // 2. Union-merge `index.json` from both sides by `id` so multi-device snapshots never overwrite each other
    let read_idx = |dir: &Path| -> Vec<SyncVersionEntry> {
        let p = dir.join("index.json");
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    };
    let list_a = read_idx(slot_a);
    let list_b = read_idx(slot_b);
    let mut by_id: BTreeMap<String, SyncVersionEntry> = BTreeMap::new();
    for item in list_a.into_iter().chain(list_b.into_iter()) {
        if slot_a.join(format!("{}.snap", item.id)).exists()
            || slot_b.join(format!("{}.snap", item.id)).exists()
        {
            by_id.entry(item.id.clone()).or_insert(item);
        }
    }
    let mut merged: Vec<SyncVersionEntry> = by_id.into_values().collect();
    merged.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    if let Ok(json) = serde_json::to_string_pretty(&merged) {
        let _ = std::fs::write(slot_a.join("index.json"), &json);
        let _ = std::fs::write(slot_b.join("index.json"), &json);
    }
}

fn sync_versions_dir_between(src_versions: &Path, dst_versions: &Path) {
    let mut slot_names: HashSet<std::ffi::OsString> = HashSet::new();
    for root in [src_versions, dst_versions] {
        if let Ok(slots) = std::fs::read_dir(root) {
            for entry in slots.flatten() {
                if entry.path().is_dir() {
                    slot_names.insert(entry.file_name());
                }
            }
        }
    }
    for slot_name in slot_names {
        let src_slot = src_versions.join(&slot_name);
        let dst_slot = dst_versions.join(&slot_name);
        merge_version_slot_dirs(&src_slot, &dst_slot);
    }
}

#[cfg(test)]
pub fn cloud_vault_push_inner(
    workspace: &Path,
    vault_dir: &Path,
    passphrase: &str,
) -> Result<WebdavSyncResult, String> {
    cloud_vault_push_options_inner(
        workspace,
        vault_dir,
        passphrase,
        true,
        false,
        false,
        DEFAULT_MAX_VERSIONS,
    )
}

pub fn cloud_vault_push_options_inner(
    workspace: &Path,
    vault_dir: &Path,
    passphrase: &str,
    encrypted: bool,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    if !workspace.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    if vault_dir.as_os_str().is_empty() {
        return Err("请先选择个人网盘同步目录 (Select a cloud drive folder first)".into());
    }
    if workspace == vault_dir || vault_dir.starts_with(workspace) {
        return Err("网盘同步目录不能与当前笔记目录相同或位于其内部 (Vault folder must be outside workspace)".into());
    }

    let target_root = if auto_workspace_subdir {
        let ws_name = workspace_folder_name(workspace);
        if vault_dir.file_name().and_then(|n| n.to_str()) == Some(ws_name.as_str()) {
            vault_dir.to_path_buf()
        } else {
            vault_dir.join(ws_name)
        }
    } else {
        vault_dir.to_path_buf()
    };

    std::fs::create_dir_all(&target_root)
        .map_err(|e| format!("无法创建网盘专用目录: {e}"))?;

    let enc_key: Option<[u8; 32]> = if encrypted {
        let manifest_path = target_root.join(VAULT_MANIFEST_NAME);
        let key = if manifest_path.exists() {
            let raw = std::fs::read_to_string(&manifest_path)
                .map_err(|e| format!("读取网盘加密元数据失败: {e}"))?;
            let manifest: CloudVaultManifest = serde_json::from_str(&raw)
                .map_err(|e| format!("解析 solomd-vault.json 失败: {e}"))?;
            unlock_vault_manifest(&manifest, passphrase)?
        } else {
            let (manifest, k) = create_vault_manifest(passphrase)?;
            let raw = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
            std::fs::write(&manifest_path, raw)
                .map_err(|e| format!("写入 solomd-vault.json 失败: {e}"))?;
            k
        };
        Some(key)
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let sync_manifest_path = target_root.join(SYNC_MANIFEST_REL);
    let mut folder_manifest: SyncFolderManifest = if sync_manifest_path.exists() {
        std::fs::read_to_string(&sync_manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        SyncFolderManifest {
            version: 1,
            workspace_name: workspace_folder_name(workspace),
            updated_at: now_unix_secs(),
            encrypted,
            vault_crypto: None,
            files: BTreeMap::new(),
        }
    };

    let mut files = Vec::new();
    collect_local_files(workspace, workspace, &mut files);
    let total_files = files.len();
    emit_sync_progress(
        "local_vault",
        "push",
        0,
        total_files.max(1),
        format!("开始同步到网盘目录 ({})，共 {total_files} 个文件…", target_root.display()),
    );

    let mut uploaded = 0usize;
    let mut downloaded = 0usize;
    let mut conflicts = 0usize;
    let mut new_files_map = BTreeMap::new();

    for (idx, (rel, full_path)) in files.into_iter().enumerate() {
        let plain_bytes = std::fs::read(&full_path)
            .map_err(|e| format!("读取 {rel} 失败: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, categorize_files);
        let remote_rel = if encrypted {
            format!("{cat_rel}.enc")
        } else {
            cat_rel.clone()
        };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        let mut stale_remote_rel: Option<String> = None;
        if let Some(prev) = folder_manifest.files.get(&rel) {
            if prev.remote_rel != remote_rel {
                stale_remote_rel = Some(prev.remote_rel.clone());
            }
            if prev.sha256 != sha {
                // Multi-device three-way check:
                if prev.remote_rel == remote_rel
                    && prev.encrypted == encrypted
                    && base_sha == Some(sha.as_str())
                {
                    // Local file was NOT modified on this device since last sync (`sha == base_sha`),
                    // while another device updated it on the cloud (`prev.sha256 != sha`).
                    // Fast-forward local file from cloud instead of overwriting cloud with stale local!
                    let rem_file = target_root.join(&prev.remote_rel);
                    if let Ok(rem_raw) = std::fs::read(&rem_file) {
                        let rem_plain_res = if let Some(ref key) = enc_key {
                            super::crypto::decrypt_bytes(key, &rel, &rem_raw)
                                .or_else(|_| {
                                    let s = prev.remote_rel.strip_suffix(".enc").unwrap_or(&prev.remote_rel);
                                    super::crypto::decrypt_bytes(key, s, &rem_raw)
                                })
                        } else {
                            Ok(rem_raw)
                        };
                        if let Ok(rem_plain) = rem_plain_res {
                            let _ = save_local_version_snapshot(
                                workspace,
                                &rel,
                                &plain_bytes,
                                "自动拉取云端新版本前备份",
                                max_versions,
                            );
                            let _ = std::fs::write(&full_path, &rem_plain);
                            new_files_map.insert(rel.clone(), prev.clone());
                            downloaded += 1;
                            continue;
                        }
                    }
                } else if base_sha != Some(prev.sha256.as_str()) {
                    // Both this device (`sha != base_sha`) and another device (`prev.sha256 != base_sha`)
                    // modified `rel` concurrently! Preserve the cloud version as both a snapshot AND a conflict copy.
                    let rem_file = target_root.join(&prev.remote_rel);
                    if let Ok(rem_raw) = std::fs::read(&rem_file) {
                        let rem_plain_opt = if let Some(ref key) = enc_key {
                            super::crypto::decrypt_bytes(key, &rel, &rem_raw)
                                .or_else(|_| {
                                    let s = prev.remote_rel.strip_suffix(".enc").unwrap_or(&prev.remote_rel);
                                    super::crypto::decrypt_bytes(key, s, &rem_raw)
                                })
                                .ok()
                        } else {
                            Some(rem_raw)
                        };
                        if let Some(rem_plain) = rem_plain_opt {
                            if rem_plain != plain_bytes {
                                let _ = save_local_version_snapshot(
                                    workspace,
                                    &rel,
                                    &rem_plain,
                                    "多端冲突备份 (云端另一设备版本)",
                                    max_versions,
                                );
                                let _ = write_conflict_copy_file(
                                    workspace,
                                    &rel,
                                    &rem_plain,
                                    "云端版本",
                                );
                                conflicts += 1;
                            }
                        }
                    }
                }

                let _ = save_local_version_snapshot(
                    workspace,
                    &rel,
                    &plain_bytes,
                    "网盘同步快照",
                    max_versions,
                );
            }
        } else {
            let _ = save_local_version_snapshot(
                workspace,
                &rel,
                &plain_bytes,
                "首次同步快照",
                max_versions,
            );
        }

        let target_file = target_root.join(&remote_rel);
        if let Some(parent) = target_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建分类子目录失败: {e}"))?;
        }

        let write_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let unchanged = target_file.exists()
            && std::fs::read(&target_file)
                .map(|existing| existing == write_bytes)
                .unwrap_or(false);
        if !unchanged {
            std::fs::write(&target_file, &write_bytes)
                .map_err(|e| format!("写入网盘文件 {remote_rel} 失败: {e}"))?;
        }
        if let Some(old_rel) = stale_remote_rel {
            let old_file = target_root.join(&old_rel);
            if old_file != target_file && old_file.is_file() {
                let _ = std::fs::remove_file(old_file);
            }
        }

        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "local_vault",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已同步: {rel}", idx + 1, total_files),
        );
    }

    // Preserve any files in remote manifest that were created by another device
    for (rem_rel_key, rem_entry) in &folder_manifest.files {
        if !new_files_map.contains_key(rem_rel_key) {
            let was_deleted_locally = local_base
                .as_ref()
                .map(|b| b.files.contains_key(rem_rel_key))
                .unwrap_or(false);
            if !was_deleted_locally && target_root.join(&rem_entry.remote_rel).exists() {
                new_files_map.insert(rem_rel_key.clone(), rem_entry.clone());
            }
        }
    }

    folder_manifest.version = 1;
    folder_manifest.workspace_name = workspace_folder_name(workspace);
    folder_manifest.updated_at = now_unix_secs();
    folder_manifest.encrypted = encrypted;
    folder_manifest.files = new_files_map;

    if let Some(parent) = sync_manifest_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&folder_manifest) {
        let _ = std::fs::write(&sync_manifest_path, json);
    }
    write_local_base_manifest(workspace, &folder_manifest);

    // Sync & union-merge version history snapshots between local workspace and cloud drive folder
    sync_versions_dir_between(
        &workspace.join(SYNC_VERSIONS_REL),
        &target_root.join(SYNC_VERSIONS_REL),
    );

    let mode_desc = if encrypted { "加密分类备份" } else { "分类目录同步" };
    let conflict_note = if conflicts > 0 {
        format!("（检测到 {conflicts} 处多端并发修改，已自动生成冲突副本与历史快照）")
    } else {
        String::new()
    };
    let final_msg = format!(
        "已{mode_desc} {uploaded} 个文件到网盘专用目录 ({}){conflict_note}",
        target_root.display()
    );
    emit_sync_progress("local_vault", "push", 100, 100, &final_msg);
    Ok(WebdavSyncResult {
        uploaded,
        downloaded,
        message: final_msg,
    })
}

fn collect_vault_files_any(
    root: &Path,
    dir: &Path,
    encrypted: bool,
    out: &mut Vec<(String, PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if should_skip_dir(name) || name == SYNC_META_DIR {
                continue;
            }
            collect_vault_files_any(root, &path, encrypted, out);
        } else if path.is_file() && !name.starts_with('.') && name != VAULT_MANIFEST_NAME {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                if encrypted {
                    if let Some(plain_rel) = rel_str.strip_suffix(".enc") {
                        if !plain_rel.is_empty() {
                            out.push((plain_rel.to_string(), path));
                        }
                    }
                } else if !rel_str.ends_with(".enc") && !rel_str.is_empty() {
                    out.push((rel_str, path));
                }
            }
        }
    }
}

#[cfg(test)]
pub fn cloud_vault_pull_inner(
    workspace: &Path,
    vault_dir: &Path,
    passphrase: &str,
) -> Result<WebdavSyncResult, String> {
    cloud_vault_pull_options_inner(
        workspace,
        vault_dir,
        passphrase,
        true,
        false,
        false,
        DEFAULT_MAX_VERSIONS,
    )
}

pub fn cloud_vault_pull_options_inner(
    workspace: &Path,
    vault_dir: &Path,
    passphrase: &str,
    encrypted: bool,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    if !workspace.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    if !vault_dir.is_dir() {
        return Err("网盘同步目录不存在 (Cloud drive folder does not exist)".into());
    }

    let ws_name = workspace_folder_name(workspace);
    let subdir_candidate = vault_dir.join(&ws_name);
    let target_root = if auto_workspace_subdir && subdir_candidate.is_dir() {
        subdir_candidate
    } else {
        vault_dir.to_path_buf()
    };

    let manifest_path = target_root.join(VAULT_MANIFEST_NAME);
    let is_actually_encrypted = encrypted || manifest_path.exists();
    let enc_key: Option<[u8; 32]> = if is_actually_encrypted {
        if !manifest_path.exists() {
            return Err("该网盘目录中未找到加密库元数据 solomd-vault.json，请先执行一次加密备份或关闭加密开关".into());
        }
        let raw = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("读取 solomd-vault.json 失败: {e}"))?;
        let manifest: CloudVaultManifest = serde_json::from_str(&raw)
            .map_err(|e| format!("解析 solomd-vault.json 失败: {e}"))?;
        Some(unlock_vault_manifest(&manifest, passphrase)?)
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let sync_manifest_path = target_root.join(SYNC_MANIFEST_REL);
    let folder_manifest: Option<SyncFolderManifest> = if sync_manifest_path.exists() {
        std::fs::read_to_string(&sync_manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    // Map remote_rel (without .enc) -> local_rel from manifest if available
    let mut remote_to_local: BTreeMap<String, String> = BTreeMap::new();
    if let Some(ref fm) = folder_manifest {
        for entry in fm.files.values() {
            let clean_rem = entry
                .remote_rel
                .strip_suffix(".enc")
                .unwrap_or(&entry.remote_rel)
                .to_string();
            remote_to_local.insert(clean_rem, entry.local_rel.clone());
        }
    }

    let mut vault_files = Vec::new();
    collect_vault_files_any(&target_root, &target_root, is_actually_encrypted, &mut vault_files);
    let total_files = vault_files.len();
    emit_sync_progress(
        "local_vault",
        "pull",
        0,
        total_files.max(1),
        format!("开始从网盘目录拉取 ({})，共 {total_files} 个文件…", target_root.display()),
    );

    let mut downloaded = 0usize;
    let mut conflicts = 0usize;
    let mut pulled_files_map: BTreeMap<String, SyncFileManifestEntry> = local_base
        .as_ref()
        .map(|b| b.files.clone())
        .unwrap_or_default();

    for (idx, (rem_rel_no_enc, file_path)) in vault_files.into_iter().enumerate() {
        let local_rel = remote_to_local
            .get(&rem_rel_no_enc)
            .cloned()
            .unwrap_or_else(|| unmap_categorized_rel_path(&rem_rel_no_enc, categorize_files));

        let local_target = workspace.join(&local_rel);
        if !should_sync_file(&local_target) {
            continue;
        }
        let raw_bytes = std::fs::read(&file_path)
            .map_err(|e| format!("读取网盘文件 {rem_rel_no_enc} 失败: {e}"))?;
        let plain_bytes = if let Some(ref key) = enc_key {
            // Try decrypting with `local_rel` AAD first, fallback to `rem_rel_no_enc`
            super::crypto::decrypt_bytes(key, &local_rel, &raw_bytes)
                .or_else(|_| super::crypto::decrypt_bytes(key, &rem_rel_no_enc, &raw_bytes))?
        } else {
            raw_bytes
        };
        let remote_sha = sha256_hex(&plain_bytes);

        if let Some(parent) = local_target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建本地目录失败: {e}"))?;
        }
        if local_target.exists() {
            if let Ok(existing) = std::fs::read(&local_target) {
                if existing != plain_bytes {
                    let local_sha = sha256_hex(&existing);
                    let base_sha = local_base
                        .as_ref()
                        .and_then(|m| m.files.get(&local_rel))
                        .map(|e| e.sha256.as_str());

                    if base_sha == Some(remote_sha.as_str()) {
                        // Cloud file has NOT changed since our last sync (`remote_sha == base_sha`),
                        // whereas local file has newer unsynced edits (`local_sha != base_sha`).
                        // Keep the newer local file untouched so it can be pushed on the next sync!
                        continue;
                    }

                    if base_sha != Some(local_sha.as_str()) {
                        // Multi-device conflict: local file has unsynced edits (`local_sha != base_sha`)
                        // AND cloud file also differs (`remote_sha != local_sha`)!
                        // Save BOTH a version snapshot AND a side-by-side conflict copy file.
                        let _ = save_local_version_snapshot(
                            workspace,
                            &local_rel,
                            &existing,
                            "多端冲突备份 (本地未同步修改)",
                            max_versions,
                        );
                        let _ = write_conflict_copy_file(
                            workspace,
                            &local_rel,
                            &existing,
                            &device_hostname(),
                        );
                        conflicts += 1;
                    } else {
                        let _ = save_local_version_snapshot(
                            workspace,
                            &local_rel,
                            &existing,
                            "网盘拉取覆盖前备份",
                            max_versions,
                        );
                    }
                    std::fs::write(&local_target, &plain_bytes)
                        .map_err(|e| format!("写入文件 {local_rel} 失败: {e}"))?;
                }
            }
        } else {
            std::fs::write(&local_target, &plain_bytes)
                .map_err(|e| format!("写入文件 {local_rel} 失败: {e}"))?;
        }

        let remote_rel_stored = if is_actually_encrypted {
            format!("{rem_rel_no_enc}.enc")
        } else {
            rem_rel_no_enc.clone()
        };
        pulled_files_map.insert(
            local_rel.clone(),
            SyncFileManifestEntry {
                local_rel: local_rel.clone(),
                remote_rel: remote_rel_stored,
                sha256: remote_sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted: is_actually_encrypted,
            },
        );
        downloaded += 1;
        emit_sync_progress(
            "local_vault",
            "pull",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已还原: {local_rel}", idx + 1, total_files),
        );
    }

    let updated_base = SyncFolderManifest {
        version: 1,
        workspace_name: workspace_folder_name(workspace),
        updated_at: now_unix_secs(),
        encrypted: is_actually_encrypted,
        vault_crypto: folder_manifest.and_then(|m| m.vault_crypto),
        files: pulled_files_map,
    };
    write_local_base_manifest(workspace, &updated_base);

    // Also pull & union-merge version snapshots between the cloud drive folder and local workspace
    sync_versions_dir_between(
        &target_root.join(SYNC_VERSIONS_REL),
        &workspace.join(SYNC_VERSIONS_REL),
    );

    let conflict_note = if conflicts > 0 {
        format!("（检测到 {conflicts} 处多端并发修改，已自动生成冲突副本并保留历史快照）")
    } else {
        String::new()
    };
    let final_msg = format!(
        "已从网盘专用目录同步还原 {downloaded} 个文件 ({}){conflict_note}",
        target_root.display()
    );
    emit_sync_progress("local_vault", "pull", 100, 100, &final_msg);
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: final_msg,
    })
}

/// Sync all notes & attachments in `workspace` into a local personal cloud drive
/// directory (`vault_dir`, e.g. 百度网盘 / 阿里云盘 / 夸克网盘 / 坚果云 / OneDrive / iCloud),
/// creating a dedicated workspace folder and organizing files into categorized folders.
#[tauri::command]
pub async fn cloud_vault_push_workspace(
    app: tauri::AppHandle,
    workspace: String,
    vault_dir: String,
    passphrase: String,
    encrypted: Option<bool>,
    auto_workspace_subdir: Option<bool>,
    categorize_files: Option<bool>,
    max_versions: Option<usize>,
) -> Result<WebdavSyncResult, String> {
    set_sync_app_handle(&app);
    tauri::async_runtime::spawn_blocking(move || {
        cloud_vault_push_options_inner(
            Path::new(workspace.trim()),
            Path::new(vault_dir.trim()),
            &passphrase,
            encrypted.unwrap_or(true),
            auto_workspace_subdir.unwrap_or(true),
            categorize_files.unwrap_or(false),
            max_versions.unwrap_or(DEFAULT_MAX_VERSIONS),
        )
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Sync notes & attachments from a local personal cloud drive directory (`vault_dir`)
/// back into `workspace`, preserving version history before overwriting modified files.
#[tauri::command]
pub async fn cloud_vault_pull_workspace(
    app: tauri::AppHandle,
    workspace: String,
    vault_dir: String,
    passphrase: String,
    encrypted: Option<bool>,
    auto_workspace_subdir: Option<bool>,
    categorize_files: Option<bool>,
    max_versions: Option<usize>,
) -> Result<WebdavSyncResult, String> {
    set_sync_app_handle(&app);
    tauri::async_runtime::spawn_blocking(move || {
        cloud_vault_pull_options_inner(
            Path::new(workspace.trim()),
            Path::new(vault_dir.trim()),
            &passphrase,
            encrypted.unwrap_or(true),
            auto_workspace_subdir.unwrap_or(true),
            categorize_files.unwrap_or(false),
            max_versions.unwrap_or(DEFAULT_MAX_VERSIONS),
        )
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────────
// Solution 3: Direct Personal Cloud Drive OpenAPI (百度网盘 / 阿里云盘 / OneDrive / Dropbox)
// Packs all workspace files into a compressed ZIP archive and encrypts the entire
// archive with Argon2id + XChaCha20-Poly1305 (`solomd-vault.enc`), so even
// filenames and directory structure remain 100% hidden from the cloud provider.
// ─────────────────────────────────────────────────────────────────────────────

const BUNDLE_MAGIC: &[u8; 5] = b"SLMB\x01";
const BUNDLE_AAD: &str = "solomd-cloud-bundle-v1";
const BUNDLE_FILENAME: &str = "solomd-vault.enc";

pub fn pack_encrypted_vault_bundle(
    workspace: &Path,
    passphrase: &str,
) -> Result<(Vec<u8>, usize), String> {
    if !workspace.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    let (manifest, key) = create_vault_manifest(passphrase)?;
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|e| format!("序列化加密元数据失败: {e}"))?;

    let mut files = Vec::new();
    collect_local_files(workspace, workspace, &mut files);

    let mut zip_buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut zip_buf);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (rel, full_path) in &files {
            let bytes =
                std::fs::read(full_path).map_err(|e| format!("读取文件 {rel} 失败: {e}"))?;
            zip.start_file(rel, options)
                .map_err(|e| format!("打包文件 {rel} 失败: {e}"))?;
            std::io::Write::write_all(&mut zip, &bytes)
                .map_err(|e| format!("写入压缩包 {rel} 失败: {e}"))?;
        }
        zip.finish()
            .map_err(|e| format!("完成压缩包打包失败: {e}"))?;
    }

    let plain_zip = zip_buf.into_inner();
    let cipher_zip = super::crypto::encrypt_bytes(&key, BUNDLE_AAD, &plain_zip)?;

    let manifest_len = manifest_bytes.len() as u32;
    let mut out =
        Vec::with_capacity(BUNDLE_MAGIC.len() + 4 + manifest_bytes.len() + cipher_zip.len());
    out.extend_from_slice(BUNDLE_MAGIC);
    out.extend_from_slice(&manifest_len.to_le_bytes());
    out.extend_from_slice(&manifest_bytes);
    out.extend_from_slice(&cipher_zip);

    Ok((out, files.len()))
}

pub fn unpack_encrypted_vault_bundle(
    workspace: &Path,
    bundle_bytes: &[u8],
    passphrase: &str,
) -> Result<usize, String> {
    if !workspace.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    if bundle_bytes.len() < BUNDLE_MAGIC.len() + 4 {
        return Err("网盘加密包数据损坏或格式无效 (Invalid encrypted vault bundle)".into());
    }
    if &bundle_bytes[..BUNDLE_MAGIC.len()] != BUNDLE_MAGIC {
        return Err("不是有效的 SoloMD 加密网盘备份包 (Unrecognized bundle magic)".into());
    }
    let len_offset = BUNDLE_MAGIC.len();
    let manifest_len = u32::from_le_bytes([
        bundle_bytes[len_offset],
        bundle_bytes[len_offset + 1],
        bundle_bytes[len_offset + 2],
        bundle_bytes[len_offset + 3],
    ]) as usize;
    let manifest_start = len_offset + 4;
    let manifest_end = manifest_start.saturating_add(manifest_len);
    if bundle_bytes.len() <= manifest_end {
        return Err("网盘加密包元数据长度异常 (Corrupted bundle manifest)".into());
    }

    let manifest: CloudVaultManifest =
        serde_json::from_slice(&bundle_bytes[manifest_start..manifest_end])
            .map_err(|e| format!("解析加密包元数据失败: {e}"))?;
    let key = unlock_vault_manifest(&manifest, passphrase)?;
    let cipher_zip = &bundle_bytes[manifest_end..];
    let plain_zip = super::crypto::decrypt_bytes(&key, BUNDLE_AAD, cipher_zip)?;

    let reader = std::io::Cursor::new(plain_zip);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("解压网盘加密包失败: {e}"))?;

    let mut extracted = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().replace('\\', "/");
        let clean_segs: Vec<&str> = raw_name
            .split('/')
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .collect();
        if clean_segs.is_empty() {
            continue;
        }
        let rel_path = clean_segs.join("/");
        let target = workspace.join(&rel_path);
        if !should_sync_file(&target) {
            continue;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut buf)
            .map_err(|e| format!("读取条目 {rel_path} 失败: {e}"))?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建本地目录失败: {e}"))?;
        }
        let unchanged = target.exists()
            && std::fs::read(&target)
                .map(|existing| existing == buf)
                .unwrap_or(false);
        if !unchanged {
            std::fs::write(&target, &buf)
                .map_err(|e| format!("写入文件 {rel_path} 失败: {e}"))?;
        }
        extracted += 1;
    }

    Ok(extracted)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAuthStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub qrcode_url: Option<String>,
    pub interval: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAuthPoll {
    pub status: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub message: String,
}

#[tauri::command]
pub async fn cloud_api_start_device_auth(
    provider: String,
    client_id: String,
) -> Result<DeviceAuthStart, String> {
    let prov = provider.trim().to_ascii_lowercase();
    let custom_cid = client_id.trim();
    let cid = if !custom_cid.is_empty() {
        custom_cid
    } else {
        match prov.as_str() {
            "baidu" => DEFAULT_BAIDU_OAUTH_CLIENT_ID,
            "onedrive" => DEFAULT_ONEDRIVE_OAUTH_CLIENT_ID,
            "gdrive" => DEFAULT_GDRIVE_OAUTH_CLIENT_ID,
            "alipan" => DEFAULT_ALIPAN_OAUTH_CLIENT_ID,
            "dropbox" => DEFAULT_DROPBOX_OAUTH_CLIENT_ID,
            _ => return Err("请先填写开放平台 AppKey / Client ID，或使用「一键浏览器免 Key 授权」".into()),
        }
    };
    let client = build_client()?;
    match prov.as_str() {
        "baidu" => {
            let url = format!(
                "https://openapi.baidu.com/oauth/2.0/device/code?response_type=device_code&client_id={}&scope=basic,netdisk",
                percent_encode_segment(cid)
            );
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("请求百度网盘设备授权失败: {e}"))?;
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析百度网盘响应失败: {e}"))?;
            if let Some(err) = json.get("error_description").and_then(|v| v.as_str()) {
                return Err(format!("百度网盘授权错误: {err}"));
            }
            let device_code = json
                .get("device_code")
                .and_then(|v| v.as_str())
                .ok_or("未返回 device_code")?
                .to_string();
            let user_code = json
                .get("user_code")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let verification_url = json
                .get("verification_url")
                .and_then(|v| v.as_str())
                .unwrap_or("https://openapi.baidu.com/device")
                .to_string();
            let qrcode_url = json
                .get("qrcode_url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let interval = json.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);
            Ok(DeviceAuthStart {
                device_code,
                user_code: user_code.clone(),
                verification_url: verification_url.clone(),
                qrcode_url,
                interval,
                message: format!(
                    "请在浏览器打开 {verification_url} 并输入授权码 【{user_code}】（或扫描二维码），完成后点击「完成授权获取 Token」"
                ),
            })
        }
        "onedrive" => {
            let resp = client
                .post("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode")
                .form(&[
                    ("client_id", cid),
                    ("scope", "Files.ReadWrite offline_access"),
                ])
                .send()
                .await
                .map_err(|e| format!("请求 OneDrive 设备授权失败: {e}"))?;
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析 OneDrive 响应失败: {e}"))?;
            if let Some(err) = json.get("error_description").and_then(|v| v.as_str()) {
                return Err(format!("OneDrive 授权错误: {err}"));
            }
            let device_code = json
                .get("device_code")
                .and_then(|v| v.as_str())
                .ok_or("未返回 device_code")?
                .to_string();
            let user_code = json
                .get("user_code")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let verification_url = json
                .get("verification_uri")
                .and_then(|v| v.as_str())
                .unwrap_or("https://microsoft.com/devicelogin")
                .to_string();
            let interval = json.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);
            Ok(DeviceAuthStart {
                device_code,
                user_code: user_code.clone(),
                verification_url: verification_url.clone(),
                qrcode_url: None,
                interval,
                message: format!(
                    "请在浏览器打开 {verification_url} 并输入代码 【{user_code}】，授权后点击「完成授权获取 Token」"
                ),
            })
        }
        "gdrive" => {
            let resp = client
                .post("https://oauth2.googleapis.com/device/code")
                .form(&[
                    ("client_id", cid),
                    ("scope", "https://www.googleapis.com/auth/drive.file"),
                ])
                .send()
                .await
                .map_err(|e| format!("请求 Google Drive 设备授权失败: {e}"))?;
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析 Google Drive 响应失败: {e}"))?;
            if let Some(err) = json.get("error_description").and_then(|v| v.as_str()) {
                return Err(format!("Google Drive 授权错误: {err}"));
            }
            let device_code = json
                .get("device_code")
                .and_then(|v| v.as_str())
                .ok_or("未返回 device_code")?
                .to_string();
            let user_code = json
                .get("user_code")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let verification_url = json
                .get("verification_url")
                .or_else(|| json.get("verification_uri"))
                .and_then(|v| v.as_str())
                .unwrap_or("https://www.google.com/device")
                .to_string();
            let interval = json.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);
            Ok(DeviceAuthStart {
                device_code,
                user_code: user_code.clone(),
                verification_url: verification_url.clone(),
                qrcode_url: None,
                interval,
                message: format!(
                    "请在浏览器打开 {verification_url} 并输入代码 【{user_code}】，授权后点击「完成授权获取 Token」"
                ),
            })
        }
        other => Err(format!(
            "当前网盘 ({other}) 请使用上方「一键浏览器免 Key 授权」或直接粘贴 Access Token"
        )),
    }
}

#[tauri::command]
pub async fn cloud_api_poll_device_auth(
    provider: String,
    client_id: String,
    client_secret: String,
    device_code: String,
) -> Result<DeviceAuthPoll, String> {
    let client = build_client()?;
    let prov = provider.trim().to_ascii_lowercase();
    let custom_cid = client_id.trim();
    let cid = if !custom_cid.is_empty() {
        custom_cid
    } else {
        match prov.as_str() {
            "baidu" => DEFAULT_BAIDU_OAUTH_CLIENT_ID,
            "onedrive" => DEFAULT_ONEDRIVE_OAUTH_CLIENT_ID,
            "gdrive" => DEFAULT_GDRIVE_OAUTH_CLIENT_ID,
            _ => custom_cid,
        }
    };
    match prov.as_str() {
        "baidu" => {
            let url = format!(
                "https://openapi.baidu.com/oauth/2.0/token?grant_type=device_token&code={}&client_id={}&client_secret={}",
                percent_encode_segment(device_code.trim()),
                percent_encode_segment(cid),
                percent_encode_segment(client_secret.trim()),
            );
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("轮询百度网盘 Token 失败: {e}"))?;
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析百度网盘 Token 失败: {e}"))?;
            if let Some(token) = json.get("access_token").and_then(|v| v.as_str()) {
                return Ok(DeviceAuthPoll {
                    status: "ok".into(),
                    access_token: Some(token.to_string()),
                    refresh_token: json
                        .get("refresh_token")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    message: "百度网盘授权成功！已自动填入 Access Token".into(),
                });
            }
            let err = json
                .get("error_description")
                .or_else(|| json.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("等待扫码授权中");
            Ok(DeviceAuthPoll {
                status: "pending".into(),
                access_token: None,
                refresh_token: None,
                message: format!("尚未完成授权: {err}"),
            })
        }
        "onedrive" => {
            let resp = client
                .post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("client_id", cid),
                    ("device_code", device_code.trim()),
                ])
                .send()
                .await
                .map_err(|e| format!("轮询 OneDrive Token 失败: {e}"))?;
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析 OneDrive Token 失败: {e}"))?;
            if let Some(token) = json.get("access_token").and_then(|v| v.as_str()) {
                return Ok(DeviceAuthPoll {
                    status: "ok".into(),
                    access_token: Some(token.to_string()),
                    refresh_token: json
                        .get("refresh_token")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    message: "OneDrive 授权成功！已自动填入 Access Token".into(),
                });
            }
            let err = json
                .get("error_description")
                .or_else(|| json.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("等待授权中");
            Ok(DeviceAuthPoll {
                status: "pending".into(),
                access_token: None,
                refresh_token: None,
                message: format!("尚未完成授权: {err}"),
            })
        }
        "gdrive" => {
            let resp = client
                .post("https://oauth2.googleapis.com/token")
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("client_id", cid),
                    ("client_secret", client_secret.trim()),
                    ("device_code", device_code.trim()),
                ])
                .send()
                .await
                .map_err(|e| format!("轮询 Google Drive Token 失败: {e}"))?;
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析 Google Drive Token 失败: {e}"))?;
            if let Some(token) = json.get("access_token").and_then(|v| v.as_str()) {
                return Ok(DeviceAuthPoll {
                    status: "ok".into(),
                    access_token: Some(token.to_string()),
                    refresh_token: json
                        .get("refresh_token")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    message: "Google Drive 授权成功！已自动填入 Access Token".into(),
                });
            }
            let err = json
                .get("error_description")
                .or_else(|| json.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("等待授权中");
            Ok(DeviceAuthPoll {
                status: "pending".into(),
                access_token: None,
                refresh_token: None,
                message: format!("尚未完成授权: {err}"),
            })
        }
        other => Err(format!("不支持的设备码轮询类型: {other}")),
    }
}

fn build_cloud_remote_file_path(provider: &str, remote_dir: &str) -> (String, String) {
    let cleaned = remote_dir.trim().replace('\\', "/");
    let trimmed = cleaned.trim_matches('/');
    let dir = if trimmed.is_empty() {
        if provider == "baidu" {
            "/apps/SoloMD".to_string()
        } else {
            "/SoloMD".to_string()
        }
    } else if provider == "baidu" && !trimmed.starts_with("apps/") {
        format!("/apps/{trimmed}")
    } else {
        format!("/{trimmed}")
    };
    let full = format!("{dir}/{BUNDLE_FILENAME}");
    (dir, full)
}

async fn baidu_upload_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
    bundle: Vec<u8>,
) -> Result<(), String> {
    let (_, full_path) = build_cloud_remote_file_path("baidu", remote_dir);
    baidu_upload_single_file(client, token, &full_path, bundle).await
}

async fn baidu_download_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
) -> Result<Vec<u8>, String> {
    let (dir_path, full_path) = build_cloud_remote_file_path("baidu", remote_dir);
    let list_url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir={}&access_token={}",
        percent_encode_segment(&dir_path),
        percent_encode_segment(token)
    );
    let list_resp = client
        .get(&list_url)
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|e| format!("百度网盘目录查询失败: {e}"))?;
    let list_json: serde_json::Value = list_resp
        .json()
        .await
        .map_err(|e| format!("解析百度网盘文件列表失败: {e}"))?;
    let errno = list_json.get("errno").and_then(|v| v.as_i64()).unwrap_or(0);
    if errno != 0 {
        return Err(format!("百度网盘 API 返回错误码 errno={errno}: {list_json}"));
    }
    let items = list_json
        .get("list")
        .and_then(|v| v.as_array())
        .ok_or("百度网盘未返回文件列表")?;
    let fs_id = items
        .iter()
        .find(|item| {
            item.get("path").and_then(|p| p.as_str()) == Some(full_path.as_str())
                || item.get("server_filename").and_then(|n| n.as_str()) == Some(BUNDLE_FILENAME)
        })
        .and_then(|item| item.get("fs_id"))
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("百度网盘目录 {dir_path} 下未找到加密备份包 {BUNDLE_FILENAME}"))?;

    let meta_url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[{fs_id}]&dlink=1&access_token={}",
        percent_encode_segment(token)
    );
    let meta_resp = client
        .get(&meta_url)
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|e| format!("获取百度网盘下载地址失败: {e}"))?;
    let meta_json: serde_json::Value = meta_resp
        .json()
        .await
        .map_err(|e| format!("解析百度网盘下载地址失败: {e}"))?;
    let dlink = meta_json
        .get("list")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("dlink"))
        .and_then(|v| v.as_str())
        .ok_or("百度网盘未返回有效 dlink")?;

    let dl_url = format!("{dlink}&access_token={}", percent_encode_segment(token));
    let dl_resp = client
        .get(&dl_url)
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|e| format!("下载百度网盘加密包失败: {e}"))?;
    if !dl_resp.status().is_success() {
        return Err(format!("下载百度网盘加密包返回 HTTP {}", dl_resp.status()));
    }
    dl_resp
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取百度网盘加密包字节失败: {e}"))
}

async fn alipan_get_drive_id(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo")
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("请求阿里云盘 getDriveInfo 失败: {e}"))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析阿里云盘账户信息失败: {e}"))?;
    if let Some(id) = json
        .get("backup_drive_id")
        .or_else(|| json.get("default_drive_id"))
        .and_then(|v| v.as_str())
    {
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    Err(format!("未能获取阿里云盘 drive_id: {json}"))
}

async fn alipan_find_file_id(
    client: &reqwest::Client,
    token: &str,
    drive_id: &str,
    parent_file_id: &str,
    name: &str,
) -> Result<Option<String>, String> {
    let resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/openFile/list")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "drive_id": drive_id,
            "parent_file_id": parent_file_id,
            "limit": 100
        }))
        .send()
        .await
        .map_err(|e| format!("查询阿里云盘目录失败: {e}"))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析阿里云盘目录失败: {e}"))?;
    let items = json.get("items").and_then(|v| v.as_array());
    if let Some(arr) = items {
        for item in arr {
            if item.get("name").and_then(|v| v.as_str()) == Some(name) {
                if let Some(fid) = item.get("file_id").and_then(|v| v.as_str()) {
                    return Ok(Some(fid.to_string()));
                }
            }
        }
    }
    Ok(None)
}

async fn alipan_ensure_folder(
    client: &reqwest::Client,
    token: &str,
    drive_id: &str,
    remote_dir: &str,
) -> Result<String, String> {
    let mut parent_id = "root".to_string();
    let cleaned = remote_dir.trim().replace('\\', "/");
    let segs: Vec<&str> = cleaned
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    let target_segs = if segs.is_empty() {
        vec!["SoloMD"]
    } else {
        segs
    };
    for seg in target_segs {
        if let Some(existing) = alipan_find_file_id(client, token, drive_id, &parent_id, seg).await?
        {
            parent_id = existing;
            continue;
        }
        let create_resp = client
            .post("https://openapi.alipan.com/adrive/v1.0/openFile/create")
            .bearer_auth(token)
            .json(&serde_json::json!({
                "drive_id": drive_id,
                "parent_file_id": parent_id,
                "name": seg,
                "type": "folder",
                "check_name_mode": "refuse"
            }))
            .send()
            .await
            .map_err(|e| format!("创建阿里云盘目录 {seg} 失败: {e}"))?;
        let json: serde_json::Value = create_resp
            .json()
            .await
            .map_err(|e| format!("解析阿里云盘目录创建结果失败: {e}"))?;
        parent_id = json
            .get("file_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("阿里云盘未返回目录 file_id: {json}"))?
            .to_string();
    }
    Ok(parent_id)
}

async fn alipan_upload_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
    bundle: Vec<u8>,
) -> Result<(), String> {
    let drive_id = alipan_get_drive_id(client, token).await?;
    let folder_id = alipan_ensure_folder(client, token, &drive_id, remote_dir).await?;

    if let Some(old_file_id) =
        alipan_find_file_id(client, token, &drive_id, &folder_id, BUNDLE_FILENAME).await?
    {
        let _ = client
            .post("https://openapi.alipan.com/adrive/v1.0/openFile/delete")
            .bearer_auth(token)
            .json(&serde_json::json!({
                "drive_id": drive_id,
                "file_id": old_file_id
            }))
            .send()
            .await;
    }

    let create_resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/openFile/create")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "drive_id": drive_id,
            "parent_file_id": folder_id,
            "name": BUNDLE_FILENAME,
            "type": "file",
            "check_name_mode": "overwrite",
            "size": bundle.len(),
            "part_info_list": [{ "part_number": 1 }]
        }))
        .send()
        .await
        .map_err(|e| format!("阿里云盘创建上传任务失败: {e}"))?;
    let create_json: serde_json::Value = create_resp
        .json()
        .await
        .map_err(|e| format!("解析阿里云盘上传任务失败: {e}"))?;
    let file_id = create_json
        .get("file_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("阿里云盘未返回 file_id: {create_json}"))?;
    let upload_id = create_json
        .get("upload_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("阿里云盘未返回 upload_id: {create_json}"))?;
    let upload_url = create_json
        .get("part_info_list")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| p.get("upload_url"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("阿里云盘未返回 upload_url: {create_json}"))?;

    let put_resp = client
        .put(upload_url)
        .body(bundle)
        .send()
        .await
        .map_err(|e| format!("上传数据到阿里云盘失败: {e}"))?;
    if !put_resp.status().is_success() {
        return Err(format!("阿里云盘分片上传返回 HTTP {}", put_resp.status()));
    }

    let complete_resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/openFile/complete")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "drive_id": drive_id,
            "file_id": file_id,
            "upload_id": upload_id
        }))
        .send()
        .await
        .map_err(|e| format!("完成阿里云盘上传请求失败: {e}"))?;
    if !complete_resp.status().is_success() {
        let t = complete_resp.text().await.unwrap_or_default();
        return Err(format!("阿里云盘确认上传失败: {t}"));
    }
    Ok(())
}

async fn alipan_download_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
) -> Result<Vec<u8>, String> {
    let drive_id = alipan_get_drive_id(client, token).await?;
    let folder_id = alipan_ensure_folder(client, token, &drive_id, remote_dir).await?;
    let file_id = alipan_find_file_id(client, token, &drive_id, &folder_id, BUNDLE_FILENAME)
        .await?
        .ok_or_else(|| format!("阿里云盘目录中未找到加密备份包 {BUNDLE_FILENAME}"))?;

    let dl_meta_resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/openFile/getDownloadUrl")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "drive_id": drive_id,
            "file_id": file_id,
            "expire_sec": 900
        }))
        .send()
        .await
        .map_err(|e| format!("获取阿里云盘下载链接失败: {e}"))?;
    let dl_meta: serde_json::Value = dl_meta_resp
        .json()
        .await
        .map_err(|e| format!("解析阿里云盘下载链接失败: {e}"))?;
    let url = dl_meta
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("阿里云盘未返回下载 url: {dl_meta}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载阿里云盘加密包失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载阿里云盘加密包返回 HTTP {}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取阿里云盘加密包失败: {e}"))
}

async fn onedrive_upload_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
    bundle: Vec<u8>,
) -> Result<(), String> {
    let (_, full_path) = build_cloud_remote_file_path("onedrive", remote_dir);
    let encoded_path = encode_rel_segments(full_path.trim_start_matches('/'));
    let url = format!("https://graph.microsoft.com/v1.0/me/drive/root:/{encoded_path}:/content");
    let resp = client
        .put(&url)
        .bearer_auth(token)
        .header("Content-Type", "application/octet-stream")
        .body(bundle)
        .send()
        .await
        .map_err(|e| format!("OneDrive 上传失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OneDrive 上传返回 HTTP {status}: {text}"));
    }
    Ok(())
}

async fn onedrive_download_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
) -> Result<Vec<u8>, String> {
    let (_, full_path) = build_cloud_remote_file_path("onedrive", remote_dir);
    let encoded_path = encode_rel_segments(full_path.trim_start_matches('/'));
    let url = format!("https://graph.microsoft.com/v1.0/me/drive/root:/{encoded_path}:/content");
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("OneDrive 下载失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OneDrive 下载返回 HTTP {status}: {text}"));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取 OneDrive 加密包失败: {e}"))
}

async fn dropbox_upload_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
    bundle: Vec<u8>,
) -> Result<(), String> {
    let (_, full_path) = build_cloud_remote_file_path("dropbox", remote_dir);
    let arg = serde_json::json!({
        "path": full_path,
        "mode": "overwrite",
        "mute": true
    })
    .to_string();
    let resp = client
        .post("https://content.dropboxapi.com/2/files/upload")
        .bearer_auth(token)
        .header("Dropbox-API-Arg", arg)
        .header("Content-Type", "application/octet-stream")
        .body(bundle)
        .send()
        .await
        .map_err(|e| format!("Dropbox 上传失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox 上传返回 HTTP {status}: {text}"));
    }
    Ok(())
}

async fn dropbox_download_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
) -> Result<Vec<u8>, String> {
    let (_, full_path) = build_cloud_remote_file_path("dropbox", remote_dir);
    let arg = serde_json::json!({ "path": full_path }).to_string();
    let resp = client
        .post("https://content.dropboxapi.com/2/files/download")
        .bearer_auth(token)
        .header("Dropbox-API-Arg", arg)
        .send()
        .await
        .map_err(|e| format!("Dropbox 下载失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox 下载返回 HTTP {status}: {text}"));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取 Dropbox 加密包失败: {e}"))
}

/// Pure-Rust RFC 1321 MD5 digest (hex string) for Baidu Netdisk `xpan` `block_list`.
pub(crate) fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
        0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
        0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
        0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
        0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    let mut a0: u32 = 0x67452301;
    let mut b0: u32 = 0xefcdab89;
    let mut c0: u32 = 0x98badcfe;
    let mut d0: u32 = 0x10325476;

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = Vec::with_capacity(data.len() + 72);
    msg.extend_from_slice(data);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, w) in chunk.chunks_exact(4).enumerate() {
            m[i] = u32::from_le_bytes([w[0], w[1], w[2], w[3]]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | (!b & d), i),
                16..=31 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(K[i])
                    .wrapping_add(m[g])
                    .rotate_left(S[i]),
            );
            a = temp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    super::crypto::hex_encode(&out)
}

async fn baidu_delete_remote_file(
    client: &reqwest::Client,
    token: &str,
    full_remote_path: &str,
) {
    let filelist = serde_json::json!([full_remote_path]).to_string();
    let url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token={}",
        percent_encode_segment(token)
    );
    let _ = client
        .post(&url)
        .header("User-Agent", "pan.baidu.com")
        .form(&[("async", "1"), ("filelist", filelist.as_str())])
        .send()
        .await;
}

/// Official Baidu Netdisk `xpan` 3-step upload (`precreate` -> `pcs/superfile2` -> `create`).
/// Automatically creates parent directories when `rtype=3` is set, and uses an ASCII
/// multipart filename (`"upload.bin"`) so non-ASCII or `.enc` paths never fail on PCS nodes.
async fn baidu_xpan_upload_file(
    client: &reqwest::Client,
    token: &str,
    full_remote_path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    const CHUNK_SIZE: usize = 4 * 1024 * 1024;
    let chunks: Vec<&[u8]> = if bytes.is_empty() {
        vec![&[][..]]
    } else {
        bytes.chunks(CHUNK_SIZE).collect()
    };
    let block_md5s: Vec<String> = chunks.iter().map(|c| md5_hex(c)).collect();
    let block_list_json = serde_json::to_string(&block_md5s).unwrap_or_else(|_| "[]".to_string());
    let size_str = bytes.len().to_string();

    let precreate_url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token={}",
        percent_encode_segment(token)
    );
    let pre_resp = client
        .post(&precreate_url)
        .header("User-Agent", "pan.baidu.com")
        .form(&[
            ("path", full_remote_path),
            ("size", size_str.as_str()),
            ("isdir", "0"),
            ("autoinit", "1"),
            ("rtype", "3"),
            ("block_list", block_list_json.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("百度网盘 precreate {full_remote_path} 失败: {e}"))?;
    let pre_json: serde_json::Value = pre_resp
        .json()
        .await
        .map_err(|e| format!("解析百度网盘 precreate 响应失败: {e}"))?;
    let pre_errno = pre_json.get("errno").and_then(|v| v.as_i64()).unwrap_or(-1);
    if pre_errno != 0 {
        return Err(format!(
            "百度网盘 precreate {full_remote_path} 失败 (errno={pre_errno}): {pre_json}"
        ));
    }
    let uploadid = pre_json
        .get("uploadid")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    for (partseq, chunk) in chunks.iter().enumerate() {
        let superfile_url = format!(
            "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&access_token={}&type=tmpfile&path={}&uploadid={}&partseq={partseq}",
            percent_encode_segment(token),
            percent_encode_segment(full_remote_path),
            percent_encode_segment(&uploadid),
        );
        let part = reqwest::multipart::Part::bytes(chunk.to_vec()).file_name("upload.bin");
        let form = reqwest::multipart::Form::new().part("file", part);
        let up_resp = client
            .post(&superfile_url)
            .header("User-Agent", "pan.baidu.com")
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("百度网盘分片上传 {full_remote_path} 失败: {e}"))?;
        let up_status = up_resp.status();
        let up_text = up_resp.text().await.unwrap_or_default();
        if !up_status.is_success() || up_text.contains("\"error_code\"") {
            return Err(format!(
                "百度网盘分片上传 {full_remote_path} 失败 (HTTP {up_status}): {up_text}"
            ));
        }
    }

    let create_url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token={}",
        percent_encode_segment(token)
    );
    let create_resp = client
        .post(&create_url)
        .header("User-Agent", "pan.baidu.com")
        .form(&[
            ("path", full_remote_path),
            ("size", size_str.as_str()),
            ("isdir", "0"),
            ("rtype", "3"),
            ("uploadid", uploadid.as_str()),
            ("block_list", block_list_json.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("百度网盘 create {full_remote_path} 失败: {e}"))?;
    let create_json: serde_json::Value = create_resp
        .json()
        .await
        .map_err(|e| format!("解析百度网盘 create 响应失败: {e}"))?;
    let create_errno = create_json.get("errno").and_then(|v| v.as_i64()).unwrap_or(-1);
    if create_errno != 0 {
        return Err(format!(
            "百度网盘创建文件 {full_remote_path} 失败 (errno={create_errno}): {create_json}"
        ));
    }
    Ok(())
}

async fn baidu_upload_single_file(
    client: &reqwest::Client,
    token: &str,
    full_remote_path: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    // Prefer official xpan 3-step upload (precreate -> superfile2 -> create), which
    // reliably creates any deleted/missing parent directories (such as `/apps/SoloMD/<工作区>`)
    // and supports `.enc` files of any size; fall back to direct PCS upload if needed.
    if baidu_xpan_upload_file(client, token, full_remote_path, &bytes)
        .await
        .is_ok()
    {
        return Ok(());
    }

    let url = format!(
        "https://d.pcs.baidu.com/rest/2.0/pcs/file?method=upload&access_token={}&path={}&ondup=overwrite",
        percent_encode_segment(token),
        percent_encode_segment(full_remote_path)
    );
    // Always use an ASCII filename in the multipart Content-Disposition header;
    // Baidu PCS uses the `path=` query parameter for the actual destination path.
    let part = reqwest::multipart::Part::bytes(bytes).file_name("upload.bin");
    let form = reqwest::multipart::Form::new().part("file", part);
    let resp = client
        .post(&url)
        .header("User-Agent", "pan.baidu.com")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("百度网盘上传 {full_remote_path} 失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let errno = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("errno").and_then(|e| e.as_i64()))
        .unwrap_or(0);
    if !status.is_success() || text.contains("\"error_code\"") || errno != 0 {
        return Err(format!("百度网盘上传 {full_remote_path} 失败 (HTTP {status}): {text}"));
    }
    Ok(())
}

/// Server-side copy on Baidu Netdisk to archive an older version into `.solomd-sync/versions/`
/// before overwriting, consuming zero upload bandwidth.
async fn baidu_archive_remote_version(
    client: &reqwest::Client,
    token: &str,
    src_full_path: &str,
    ws_remote_root: &str,
    rel_path: &str,
    old_sha8: &str,
) {
    let dest_dir = format!("{ws_remote_root}/{SYNC_VERSIONS_REL}");
    let safe_name: String = rel_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let new_name = format!("{}_{}_{}.bak", safe_name, now_unix_secs(), old_sha8);
    let filelist = serde_json::json!([{
        "path": src_full_path,
        "dest": dest_dir,
        "newname": new_name,
        "ondup": "overwrite"
    }])
    .to_string();
    let url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=copy&access_token={}",
        percent_encode_segment(token)
    );
    let _ = client
        .post(&url)
        .header("User-Agent", "pan.baidu.com")
        .form(&[("async", "1"), ("filelist", filelist.as_str())])
        .send()
        .await;
}

async fn baidu_download_by_fsid(
    client: &reqwest::Client,
    token: &str,
    fs_id: u64,
) -> Result<Vec<u8>, String> {
    let meta_url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[{fs_id}]&dlink=1&access_token={}",
        percent_encode_segment(token)
    );
    let meta_resp = client
        .get(&meta_url)
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|e| format!("获取百度网盘下载地址失败: {e}"))?;
    let meta_json: serde_json::Value = meta_resp
        .json()
        .await
        .map_err(|e| format!("解析百度网盘下载地址失败: {e}"))?;
    let dlink = meta_json
        .get("list")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("dlink"))
        .and_then(|v| v.as_str())
        .ok_or("百度网盘未返回有效 dlink")?;

    let dl_url = format!("{dlink}&access_token={}", percent_encode_segment(token));
    let dl_resp = client
        .get(&dl_url)
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|e| format!("下载百度网盘文件失败: {e}"))?;
    if !dl_resp.status().is_success() {
        return Err(format!("下载百度网盘文件返回 HTTP {}", dl_resp.status()));
    }
    dl_resp
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取百度网盘文件字节失败: {e}"))
}

async fn baidu_try_download_file(
    client: &reqwest::Client,
    token: &str,
    dir_path: &str,
    file_name: &str,
) -> Option<Vec<u8>> {
    let list_url = format!(
        "https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir={}&access_token={}",
        percent_encode_segment(dir_path),
        percent_encode_segment(token)
    );
    let resp = client
        .get(&list_url)
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .ok()?;
    let json: serde_json::Value = resp.json().await.ok()?;
    if json.get("errno").and_then(|v| v.as_i64()).unwrap_or(-1) != 0 {
        return None;
    }
    let items = json.get("list")?.as_array()?;
    let fs_id = items
        .iter()
        .find(|item| item.get("server_filename").and_then(|n| n.as_str()) == Some(file_name))
        .and_then(|item| item.get("fs_id"))
        .and_then(|v| v.as_u64())?;
    baidu_download_by_fsid(client, token, fs_id).await.ok()
}

/// Push workspace to Baidu Netdisk as a dedicated folder (`/apps/SoloMD/<工作区名>/`)
/// with categorized subdirectories, incremental SHA-256 skipping, and version archiving.
async fn baidu_push_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("baidu", remote_dir, workspace, auto_workspace_subdir);
    let meta_remote_dir = format!("{ws_remote_root}/{SYNC_META_DIR}");

    // 1. Fetch existing remote manifest if present
    let mut manifest: SyncFolderManifest = if let Some(bytes) =
        baidu_try_download_file(client, token, &meta_remote_dir, "manifest.json").await
    {
        serde_json::from_slice(&bytes).unwrap_or_default()
    } else {
        SyncFolderManifest {
            version: 1,
            workspace_name: workspace_folder_name(workspace),
            updated_at: now_unix_secs(),
            encrypted,
            vault_crypto: None,
            files: BTreeMap::new(),
        }
    };

    let local_base = read_local_base_manifest(workspace);

    // 2. Prepare encryption key if per-file encryption is enabled
    let enc_key: Option<[u8; 32]> = if encrypted {
        if let Some(ref vc) = manifest.vault_crypto {
            Some(unlock_vault_manifest(vc, passphrase)?)
        } else if let Some(vc) = local_base
            .as_ref()
            .and_then(|m| m.vault_crypto.clone())
            .filter(|vc| unlock_vault_manifest(vc, passphrase).is_ok())
        {
            let key = unlock_vault_manifest(&vc, passphrase)?;
            manifest.vault_crypto = Some(vc);
            Some(key)
        } else {
            let (vc, key) = create_vault_manifest(passphrase)?;
            manifest.vault_crypto = Some(vc);
            Some(key)
        }
    } else {
        None
    };

    let mut local_files = Vec::new();
    collect_local_files(workspace, workspace, &mut local_files);
    let total_files = local_files.len();
    emit_sync_progress(
        "cloud_api",
        "push",
        0,
        total_files.max(1),
        format!("已扫描本地工作区，共 {total_files} 个文件待同步到百度网盘…"),
    );

    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut new_files_map = BTreeMap::new();

    for (idx, (rel, full_path)) in local_files.into_iter().enumerate() {
        let plain_bytes =
            std::fs::read(&full_path).map_err(|e| format!("读取本地文件 {rel} 失败: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, categorize_files);
        let remote_rel = if encrypted {
            format!("{cat_rel}.enc")
        } else {
            cat_rel.clone()
        };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        let mut stale_remote_full: Option<String> = None;
        // Check if unchanged in remote manifest
        if let Some(prev) = manifest.files.get(&rel) {
            if prev.sha256 == sha && prev.remote_rel == remote_rel && prev.encrypted == encrypted {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel == remote_rel
                && prev.encrypted == encrypted
                && base_sha == Some(sha.as_str())
            {
                // Local file was NOT modified on this device since last sync (`sha == base_sha`),
                // while another device updated it on Baidu Netdisk (`prev.sha256 != sha`).
                // Preserve the newer cloud version in manifest instead of overwriting it with stale local!
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            // Content or encryption mode changed: archive local snapshot & cloud-side copy before overwriting
            let _ = save_local_version_snapshot(
                workspace,
                &rel,
                &plain_bytes,
                "百度网盘同步快照",
                max_versions,
            );
            let old_remote_full = format!("{ws_remote_root}/{}", prev.remote_rel);
            let old_sha8 = if prev.sha256.len() >= 8 {
                &prev.sha256[..8]
            } else {
                "old"
            };
            baidu_archive_remote_version(
                client,
                token,
                &old_remote_full,
                &ws_remote_root,
                &rel,
                old_sha8,
            )
            .await;
            if prev.remote_rel != remote_rel {
                stale_remote_full = Some(old_remote_full);
            }
        } else {
            let _ = save_local_version_snapshot(
                workspace,
                &rel,
                &plain_bytes,
                "首次同步百度网盘快照",
                max_versions,
            );
        }

        let upload_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let remote_full_path = format!("{ws_remote_root}/{remote_rel}");
        baidu_upload_single_file(client, token, &remote_full_path, upload_bytes).await?;
        if let Some(old_full) = stale_remote_full {
            baidu_delete_remote_file(client, token, &old_full).await;
        }

        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "cloud_api",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已上传: {rel}", idx + 1, total_files),
        );
    }

    // Preserve any files in remote manifest that were created by another device
    for (rem_rel_key, rem_entry) in &manifest.files {
        if !new_files_map.contains_key(rem_rel_key) {
            let was_deleted_locally = local_base
                .as_ref()
                .map(|b| b.files.contains_key(rem_rel_key))
                .unwrap_or(false);
            if !was_deleted_locally {
                new_files_map.insert(rem_rel_key.clone(), rem_entry.clone());
            }
        }
    }

    manifest.version = 1;
    manifest.workspace_name = workspace_folder_name(workspace);
    manifest.updated_at = now_unix_secs();
    manifest.encrypted = encrypted;
    manifest.files = new_files_map;

    if let Ok(manifest_bytes) = serde_json::to_vec_pretty(&manifest) {
        let manifest_remote_path = format!("{ws_remote_root}/{SYNC_MANIFEST_REL}");
        baidu_upload_single_file(client, token, &manifest_remote_path, manifest_bytes).await?;
    }
    write_local_base_manifest(workspace, &manifest);

    let mode_label = if encrypted { "加密分类目录" } else { "分类目录" };
    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!(
            "百度网盘{mode_label}同步完成：新增/更新 {uploaded} 个文件，跳过未改动 {skipped} 个文件（网盘路径：{ws_remote_root}）"
        ),
    })
}

/// Pull workspace from Baidu Netdisk dedicated folder (`/apps/SoloMD/<工作区名>/`),
/// supporting both manifest-guided incremental pull and recursive directory walk,
/// with automatic local version backup before overwriting modified files.
async fn baidu_pull_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("baidu", remote_dir, workspace, auto_workspace_subdir);
    let meta_remote_dir = format!("{ws_remote_root}/{SYNC_META_DIR}");

    let manifest_opt: Option<SyncFolderManifest> = if let Some(bytes) =
        baidu_try_download_file(client, token, &meta_remote_dir, "manifest.json").await
    {
        serde_json::from_slice(&bytes).ok()
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let is_encrypted = manifest_opt
        .as_ref()
        .map(|m| m.encrypted)
        .unwrap_or(encrypted);
    let enc_key: Option<[u8; 32]> = if is_encrypted {
        if let Some(vc) = manifest_opt
            .as_ref()
            .and_then(|m| m.vault_crypto.as_ref())
            .or_else(|| local_base.as_ref().and_then(|m| m.vault_crypto.as_ref()))
        {
            Some(unlock_vault_manifest(vc, passphrase)?)
        } else {
            None
        }
    } else {
        None
    };

    let mut remote_to_entry: BTreeMap<String, SyncFileManifestEntry> = BTreeMap::new();
    if let Some(ref m) = manifest_opt {
        for entry in m.files.values() {
            remote_to_entry.insert(entry.remote_rel.clone(), entry.clone());
        }
    }

    // BFS traversal of ws_remote_root on Baidu Netdisk
    let mut queue = vec![ws_remote_root.clone()];
    let mut visited = HashSet::new();
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;

    while let Some(cur_dir) = queue.pop() {
        if !visited.insert(cur_dir.clone()) {
            continue;
        }
        let list_url = format!(
            "https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir={}&access_token={}",
            percent_encode_segment(&cur_dir),
            percent_encode_segment(token)
        );
        let list_resp = client
            .get(&list_url)
            .header("User-Agent", "pan.baidu.com")
            .send()
            .await
            .map_err(|e| format!("百度网盘目录查询失败: {e}"))?;
        let list_json: serde_json::Value = list_resp
            .json()
            .await
            .map_err(|e| format!("解析百度网盘目录失败: {e}"))?;
        let errno = list_json.get("errno").and_then(|v| v.as_i64()).unwrap_or(0);
        if errno != 0 {
            // If the dedicated workspace folder doesn't exist yet, try legacy bundle fallback
            if cur_dir == ws_remote_root {
                if let Ok(bundle) = baidu_download_bundle(client, token, remote_dir).await {
                    let ws_buf = workspace.to_path_buf();
                    let pass_str = passphrase.to_string();
                    let count = tauri::async_runtime::spawn_blocking(move || {
                        unpack_encrypted_vault_bundle(&ws_buf, &bundle, &pass_str)
                    })
                    .await
                    .map_err(|e| format!("join: {e}"))??;
                    return Ok(WebdavSyncResult {
                        uploaded: 0,
                        downloaded: count,
                        message: format!("已从百度网盘旧版加密包还原 {count} 个文件"),
                    });
                }
            }
            return Err(format!(
                "百度网盘目录 {cur_dir} 查询失败 (errno={errno})，请确认已执行过上传同步"
            ));
        }

        let Some(items) = list_json.get("list").and_then(|v| v.as_array()) else {
            continue;
        };
        for item in items {
            let is_dir = item.get("isdir").and_then(|v| v.as_u64()).unwrap_or(0) == 1;
            let Some(server_path) = item.get("path").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(name) = item.get("server_filename").and_then(|v| v.as_str()) else {
                continue;
            };
            if name.starts_with('.') || name == SYNC_META_DIR || name == BUNDLE_FILENAME {
                continue;
            }
            if is_dir {
                if !should_skip_dir(name) && visited.len() < 200 {
                    queue.push(server_path.to_string());
                }
                continue;
            }

            let Some(fs_id) = item.get("fs_id").and_then(|v| v.as_u64()) else {
                continue;
            };
            let rel_from_ws = server_path
                .strip_prefix(&ws_remote_root)
                .unwrap_or(server_path)
                .trim_start_matches('/');

            let manifest_entry = remote_to_entry.get(rel_from_ws);
            let local_rel = if let Some(me) = manifest_entry {
                me.local_rel.clone()
            } else {
                let stripped = rel_from_ws.strip_suffix(".enc").unwrap_or(rel_from_ws);
                unmap_categorized_rel_path(stripped, categorize_files)
            };

            let local_target = workspace.join(&local_rel);
            if !should_sync_file(&local_target) {
                continue;
            }

            // Incremental check: skip download if local file already matches remote manifest SHA-256
            if let Some(me) = manifest_entry {
                if local_target.exists() {
                    if let Ok(existing_bytes) = std::fs::read(&local_target) {
                        if sha256_hex(&existing_bytes) == me.sha256 {
                            skipped += 1;
                            continue;
                        }
                    }
                }
            }

            let raw_bytes = baidu_download_by_fsid(client, token, fs_id).await?;
            let plain_bytes = if rel_from_ws.ends_with(".enc") {
                let Some(ref key) = enc_key else {
                    return Err(format!("文件 {rel_from_ws} 已加密，请输入正确的加密口令"));
                };
                super::crypto::decrypt_bytes(key, &local_rel, &raw_bytes)
                    .or_else(|_| {
                        let s = rel_from_ws.strip_suffix(".enc").unwrap_or(rel_from_ws);
                        super::crypto::decrypt_bytes(key, s, &raw_bytes)
                    })?
            } else {
                raw_bytes
            };

            if local_target.exists() {
                if let Ok(existing_bytes) = std::fs::read(&local_target) {
                    if existing_bytes != plain_bytes {
                        let local_sha = sha256_hex(&existing_bytes);
                        let remote_sha = sha256_hex(&plain_bytes);
                        let base_sha = local_base
                            .as_ref()
                            .and_then(|m| m.files.get(&local_rel))
                            .map(|e| e.sha256.as_str());
                        if base_sha == Some(remote_sha.as_str()) {
                            // Remote has not changed since last sync, while local has unsynced edits -> preserve local
                            skipped += 1;
                            continue;
                        }
                        if base_sha != Some(local_sha.as_str()) {
                            let _ = save_local_version_snapshot(
                                workspace,
                                &local_rel,
                                &existing_bytes,
                                "多端冲突备份 (本地未同步修改)",
                                max_versions,
                            );
                            let _ = write_conflict_copy_file(
                                workspace,
                                &local_rel,
                                &existing_bytes,
                                &device_hostname(),
                            );
                            conflicts += 1;
                        } else {
                            let _ = save_local_version_snapshot(
                                workspace,
                                &local_rel,
                                &existing_bytes,
                                "从百度网盘拉取覆盖前自动备份",
                                max_versions,
                            );
                        }
                    } else {
                        skipped += 1;
                        continue;
                    }
                }
            }

            if let Some(parent) = local_target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建本地目录失败: {e}"))?;
            }
            std::fs::write(&local_target, &plain_bytes)
                .map_err(|e| format!("写入本地文件 {local_rel} 失败: {e}"))?;
            downloaded += 1;
            let total_est = remote_to_entry.len().max(downloaded + skipped);
            emit_sync_progress(
                "cloud_api",
                "pull",
                downloaded + skipped,
                total_est,
                format!("已下载还原: {local_rel}"),
            );
        }
    }

    if let Some(ref m) = manifest_opt {
        write_local_base_manifest(workspace, m);
    }

    let conflict_note = if conflicts > 0 {
        format!("，检测到 {conflicts} 处多端并发修改并已生成冲突副本与历史快照")
    } else {
        String::new()
    };
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!(
            "已从百度网盘专用目录 ({ws_remote_root}) 同步更新 {downloaded} 个文件（跳过未改动 {skipped} 个文件{conflict_note}）"
        ),
    })
}

async fn onedrive_push_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("onedrive", remote_dir, workspace, auto_workspace_subdir);
    let manifest_rel = format!("{}/{}", ws_remote_root.trim_start_matches('/'), SYNC_MANIFEST_REL);
    let manifest_url = format!(
        "https://graph.microsoft.com/v1.0/me/drive/root:/{}:/content",
        encode_rel_segments(&manifest_rel)
    );

    let mut manifest: SyncFolderManifest = match client.get(&manifest_url).bearer_auth(token).send().await {
        Ok(r) if r.status().is_success() => {
            let b = r.bytes().await.unwrap_or_default();
            serde_json::from_slice(&b).unwrap_or_default()
        }
        _ => SyncFolderManifest {
            version: 1,
            workspace_name: workspace_folder_name(workspace),
            updated_at: now_unix_secs(),
            encrypted,
            vault_crypto: None,
            files: BTreeMap::new(),
        },
    };

    let enc_key: Option<[u8; 32]> = if encrypted {
        if let Some(ref vc) = manifest.vault_crypto {
            Some(unlock_vault_manifest(vc, passphrase)?)
        } else {
            let (vc, k) = create_vault_manifest(passphrase)?;
            manifest.vault_crypto = Some(vc);
            Some(k)
        }
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut local_files = Vec::new();
    collect_local_files(workspace, workspace, &mut local_files);
    let total_files = local_files.len();
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut new_files_map = BTreeMap::new();

    for (idx, (rel, full_path)) in local_files.into_iter().enumerate() {
        let plain_bytes = std::fs::read(&full_path).map_err(|e| format!("读取 {rel} 失败: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, categorize_files);
        let remote_rel = if encrypted { format!("{cat_rel}.enc") } else { cat_rel };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        let mut stale_remote_rel: Option<String> = None;
        if let Some(prev) = manifest.files.get(&rel) {
            if prev.sha256 == sha && prev.remote_rel == remote_rel && prev.encrypted == encrypted {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel == remote_rel
                && prev.encrypted == encrypted
                && base_sha == Some(sha.as_str())
            {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel != remote_rel {
                stale_remote_rel = Some(prev.remote_rel.clone());
            }
            let _ = save_local_version_snapshot(workspace, &rel, &plain_bytes, "OneDrive 同步快照", max_versions);
        }

        let upload_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let full_rel = format!("{}/{}", ws_remote_root.trim_start_matches('/'), remote_rel);
        let put_url = format!(
            "https://graph.microsoft.com/v1.0/me/drive/root:/{}:/content",
            encode_rel_segments(&full_rel)
        );
        let resp = client
            .put(&put_url)
            .bearer_auth(token)
            .header("Content-Type", "application/octet-stream")
            .body(upload_bytes)
            .send()
            .await
            .map_err(|e| format!("OneDrive 上传 {remote_rel} 失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("OneDrive 上传 {remote_rel} 返回 HTTP {}", resp.status()));
        }
        if let Some(old_rel) = stale_remote_rel {
            let old_full_rel = format!("{}/{}", ws_remote_root.trim_start_matches('/'), old_rel);
            let del_url = format!(
                "https://graph.microsoft.com/v1.0/me/drive/root:/{}",
                encode_rel_segments(&old_full_rel)
            );
            let _ = client.delete(&del_url).bearer_auth(token).send().await;
        }
        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "cloud_api",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已上传: {rel}", idx + 1, total_files),
        );
    }

    manifest.updated_at = now_unix_secs();
    manifest.encrypted = encrypted;
    manifest.files = new_files_map;
    if let Ok(m_bytes) = serde_json::to_vec_pretty(&manifest) {
        let _ = client
            .put(&manifest_url)
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body(m_bytes)
            .send()
            .await;
    }
    write_local_base_manifest(workspace, &manifest);

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!("OneDrive 分类目录同步完成：上传 {uploaded} 个文件，跳过 {skipped} 个未改动文件 ({ws_remote_root})"),
    })
}

async fn onedrive_pull_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    _categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("onedrive", remote_dir, workspace, auto_workspace_subdir);
    let manifest_rel = format!("{}/{}", ws_remote_root.trim_start_matches('/'), SYNC_MANIFEST_REL);
    let manifest_url = format!(
        "https://graph.microsoft.com/v1.0/me/drive/root:/{}:/content",
        encode_rel_segments(&manifest_rel)
    );

    let resp = client
        .get(&manifest_url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("连接 OneDrive 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("OneDrive 目录 ({ws_remote_root}) 下未找到同步清单 manifest.json"));
    }
    let m_bytes = resp.bytes().await.unwrap_or_default();
    let manifest: SyncFolderManifest =
        serde_json::from_slice(&m_bytes).map_err(|e| format!("解析 OneDrive 同步清单失败: {e}"))?;

    let dec_key: Option<[u8; 32]> = if manifest.encrypted || encrypted {
        let vc = manifest
            .vault_crypto
            .as_ref()
            .ok_or("云端文件已开启加密，但清单缺少加密元数据")?;
        Some(unlock_vault_manifest(vc, passphrase)?)
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;

    for (local_rel, entry) in &manifest.files {
        let target_local = workspace.join(local_rel);
        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(local_rel))
            .map(|e| e.sha256.as_str());

        if target_local.is_file() {
            if let Ok(existing) = std::fs::read(&target_local) {
                let local_sha = sha256_hex(&existing);
                if local_sha == entry.sha256 {
                    skipped += 1;
                    continue;
                }
                if base_sha == Some(entry.sha256.as_str()) {
                    skipped += 1;
                    continue;
                }
                let _ = save_local_version_snapshot(
                    workspace,
                    local_rel,
                    &existing,
                    "OneDrive 拉取前本地快照",
                    max_versions,
                );
                let is_conflict = match base_sha {
                    Some(b_sha) => local_sha != b_sha && entry.sha256 != b_sha,
                    None => true,
                };
                if is_conflict && write_conflict_copy_file(workspace, local_rel, &existing, "本地修改").is_some() {
                    conflicts += 1;
                }
            }
        }

        let full_rel = format!("{}/{}", ws_remote_root.trim_start_matches('/'), entry.remote_rel);
        let dl_url = format!(
            "https://graph.microsoft.com/v1.0/me/drive/root:/{}:/content",
            encode_rel_segments(&full_rel)
        );
        let dl_resp = client
            .get(&dl_url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("OneDrive 下载 {} 失败: {e}", entry.remote_rel))?;
        if !dl_resp.status().is_success() {
            continue;
        }
        let raw_bytes = dl_resp.bytes().await.unwrap_or_default().to_vec();
        let plain_bytes = if entry.encrypted {
            let key = dec_key.as_ref().ok_or("需要加密口令以解密 OneDrive 文件")?;
            super::crypto::decrypt_bytes(key, local_rel, &raw_bytes)?
        } else {
            raw_bytes
        };
        if let Some(parent) = target_local.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&target_local, &plain_bytes)
            .map_err(|e| format!("写入本地文件 {local_rel} 失败: {e}"))?;
        let _ = save_local_version_snapshot(
            workspace,
            local_rel,
            &plain_bytes,
            "从 OneDrive 同步版本",
            max_versions,
        );
        downloaded += 1;
        emit_sync_progress(
            "cloud_api",
            "pull",
            downloaded + skipped,
            manifest.files.len().max(1),
            format!("已下载还原: {local_rel}"),
        );
    }

    write_local_base_manifest(workspace, &manifest);
    let conflict_note = if conflicts > 0 {
        format!("，检测到 {conflicts} 处多端并发修改并已生成冲突副本")
    } else {
        String::new()
    };
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!(
            "已从 OneDrive 专用目录 ({ws_remote_root}) 同步更新 {downloaded} 个文件（跳过未改动 {skipped} 个{conflict_note}）"
        ),
    })
}

async fn dropbox_push_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("dropbox", remote_dir, workspace, auto_workspace_subdir);
    let manifest_path = format!("{ws_remote_root}/{SYNC_MANIFEST_REL}");

    let mut manifest: SyncFolderManifest = {
        let arg = serde_json::json!({ "path": manifest_path }).to_string();
        match client
            .post("https://content.dropboxapi.com/2/files/download")
            .bearer_auth(token)
            .header("Dropbox-API-Arg", arg)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                let b = r.bytes().await.unwrap_or_default();
                serde_json::from_slice(&b).unwrap_or_default()
            }
            _ => SyncFolderManifest {
                version: 1,
                workspace_name: workspace_folder_name(workspace),
                updated_at: now_unix_secs(),
                encrypted,
                vault_crypto: None,
                files: BTreeMap::new(),
            },
        }
    };

    let enc_key: Option<[u8; 32]> = if encrypted {
        if let Some(ref vc) = manifest.vault_crypto {
            Some(unlock_vault_manifest(vc, passphrase)?)
        } else {
            let (vc, k) = create_vault_manifest(passphrase)?;
            manifest.vault_crypto = Some(vc);
            Some(k)
        }
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut local_files = Vec::new();
    collect_local_files(workspace, workspace, &mut local_files);
    let total_files = local_files.len();
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut new_files_map = BTreeMap::new();

    for (idx, (rel, full_path)) in local_files.into_iter().enumerate() {
        let plain_bytes = std::fs::read(&full_path).map_err(|e| format!("读取 {rel} 失败: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, categorize_files);
        let remote_rel = if encrypted { format!("{cat_rel}.enc") } else { cat_rel };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        let mut stale_remote_rel: Option<String> = None;
        if let Some(prev) = manifest.files.get(&rel) {
            if prev.sha256 == sha && prev.remote_rel == remote_rel && prev.encrypted == encrypted {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel == remote_rel
                && prev.encrypted == encrypted
                && base_sha == Some(sha.as_str())
            {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel != remote_rel {
                stale_remote_rel = Some(prev.remote_rel.clone());
            }
            let _ = save_local_version_snapshot(workspace, &rel, &plain_bytes, "Dropbox 同步快照", max_versions);
        }

        let upload_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let target_path = format!("{ws_remote_root}/{remote_rel}");
        let arg = serde_json::json!({
            "path": target_path,
            "mode": "overwrite",
            "mute": true
        })
        .to_string();
        let resp = client
            .post("https://content.dropboxapi.com/2/files/upload")
            .bearer_auth(token)
            .header("Dropbox-API-Arg", arg)
            .header("Content-Type", "application/octet-stream")
            .body(upload_bytes)
            .send()
            .await
            .map_err(|e| format!("Dropbox 上传 {remote_rel} 失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Dropbox 上传 {remote_rel} 返回 HTTP {}", resp.status()));
        }
        if let Some(old_rel) = stale_remote_rel {
            let old_path = format!("{ws_remote_root}/{old_rel}");
            let _ = client
                .post("https://api.dropboxapi.com/2/files/delete_v2")
                .bearer_auth(token)
                .json(&serde_json::json!({ "path": old_path }))
                .send()
                .await;
        }
        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "cloud_api",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已上传: {rel}", idx + 1, total_files),
        );
    }

    manifest.updated_at = now_unix_secs();
    manifest.encrypted = encrypted;
    manifest.files = new_files_map;
    if let Ok(m_bytes) = serde_json::to_vec_pretty(&manifest) {
        let arg = serde_json::json!({
            "path": manifest_path,
            "mode": "overwrite",
            "mute": true
        })
        .to_string();
        let _ = client
            .post("https://content.dropboxapi.com/2/files/upload")
            .bearer_auth(token)
            .header("Dropbox-API-Arg", arg)
            .header("Content-Type", "application/octet-stream")
            .body(m_bytes)
            .send()
            .await;
    }
    write_local_base_manifest(workspace, &manifest);

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!("Dropbox 分类目录同步完成：上传 {uploaded} 个文件，跳过 {skipped} 个未改动文件 ({ws_remote_root})"),
    })
}

async fn dropbox_pull_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    _categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("dropbox", remote_dir, workspace, auto_workspace_subdir);
    let manifest_path = format!("{ws_remote_root}/{SYNC_MANIFEST_REL}");
    let arg = serde_json::json!({ "path": manifest_path }).to_string();
    let resp = client
        .post("https://content.dropboxapi.com/2/files/download")
        .bearer_auth(token)
        .header("Dropbox-API-Arg", arg)
        .send()
        .await
        .map_err(|e| format!("连接 Dropbox 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Dropbox 目录 ({ws_remote_root}) 下未找到同步清单 manifest.json"));
    }
    let m_bytes = resp.bytes().await.unwrap_or_default();
    let manifest: SyncFolderManifest =
        serde_json::from_slice(&m_bytes).map_err(|e| format!("解析 Dropbox 同步清单失败: {e}"))?;

    let dec_key: Option<[u8; 32]> = if manifest.encrypted || encrypted {
        let vc = manifest
            .vault_crypto
            .as_ref()
            .ok_or("云端文件已开启加密，但清单缺少加密元数据")?;
        Some(unlock_vault_manifest(vc, passphrase)?)
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;

    for (local_rel, entry) in &manifest.files {
        let target_local = workspace.join(local_rel);
        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(local_rel))
            .map(|e| e.sha256.as_str());

        if target_local.is_file() {
            if let Ok(existing) = std::fs::read(&target_local) {
                let local_sha = sha256_hex(&existing);
                if local_sha == entry.sha256 {
                    skipped += 1;
                    continue;
                }
                if base_sha == Some(entry.sha256.as_str()) {
                    skipped += 1;
                    continue;
                }
                let _ = save_local_version_snapshot(
                    workspace,
                    local_rel,
                    &existing,
                    "Dropbox 拉取前本地快照",
                    max_versions,
                );
                let is_conflict = match base_sha {
                    Some(b_sha) => local_sha != b_sha && entry.sha256 != b_sha,
                    None => true,
                };
                if is_conflict && write_conflict_copy_file(workspace, local_rel, &existing, "本地修改").is_some() {
                    conflicts += 1;
                }
            }
        }

        let target_path = format!("{ws_remote_root}/{}", entry.remote_rel);
        let dl_arg = serde_json::json!({ "path": target_path }).to_string();
        let dl_resp = client
            .post("https://content.dropboxapi.com/2/files/download")
            .bearer_auth(token)
            .header("Dropbox-API-Arg", dl_arg)
            .send()
            .await
            .map_err(|e| format!("Dropbox 下载 {} 失败: {e}", entry.remote_rel))?;
        if !dl_resp.status().is_success() {
            continue;
        }
        let raw_bytes = dl_resp.bytes().await.unwrap_or_default().to_vec();
        let plain_bytes = if entry.encrypted {
            let key = dec_key.as_ref().ok_or("需要加密口令以解密 Dropbox 文件")?;
            super::crypto::decrypt_bytes(key, local_rel, &raw_bytes)?
        } else {
            raw_bytes
        };
        if let Some(parent) = target_local.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&target_local, &plain_bytes)
            .map_err(|e| format!("写入本地文件 {local_rel} 失败: {e}"))?;
        let _ = save_local_version_snapshot(
            workspace,
            local_rel,
            &plain_bytes,
            "从 Dropbox 同步版本",
            max_versions,
        );
        downloaded += 1;
        emit_sync_progress(
            "cloud_api",
            "pull",
            downloaded + skipped,
            manifest.files.len().max(1),
            format!("已下载还原: {local_rel}"),
        );
    }

    write_local_base_manifest(workspace, &manifest);
    let conflict_note = if conflicts > 0 {
        format!("，检测到 {conflicts} 处多端并发修改并已生成冲突副本")
    } else {
        String::new()
    };
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!(
            "已从 Dropbox 专用目录 ({ws_remote_root}) 同步更新 {downloaded} 个文件（跳过未改动 {skipped} 个{conflict_note}）"
        ),
    })
}

async fn alipan_upload_bytes_to_folder(
    client: &reqwest::Client,
    token: &str,
    drive_id: &str,
    folder_id: &str,
    file_name: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if let Some(old_id) = alipan_find_file_id(client, token, drive_id, folder_id, file_name).await? {
        let _ = client
            .post("https://openapi.alipan.com/adrive/v1.0/openFile/delete")
            .bearer_auth(token)
            .json(&serde_json::json!({
                "drive_id": drive_id,
                "file_id": old_id
            }))
            .send()
            .await;
    }

    let create_resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/openFile/create")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "drive_id": drive_id,
            "parent_file_id": folder_id,
            "name": file_name,
            "type": "file",
            "check_name_mode": "overwrite",
            "size": bytes.len(),
            "part_info_list": [{ "part_number": 1 }]
        }))
        .send()
        .await
        .map_err(|e| format!("阿里云盘创建上传任务 {file_name} 失败: {e}"))?;
    let create_json: serde_json::Value = create_resp
        .json()
        .await
        .map_err(|e| format!("解析阿里云盘上传任务失败: {e}"))?;
    let file_id = create_json
        .get("file_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("阿里云盘未返回 file_id: {create_json}"))?;
    let upload_id = create_json
        .get("upload_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("阿里云盘未返回 upload_id: {create_json}"))?;
    let upload_url = create_json
        .get("part_info_list")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| p.get("upload_url"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("阿里云盘未返回 upload_url: {create_json}"))?;

    let put_resp = client
        .put(upload_url)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("上传数据到阿里云盘失败: {e}"))?;
    if !put_resp.status().is_success() {
        return Err(format!("阿里云盘分片上传返回 HTTP {}", put_resp.status()));
    }

    let complete_resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/openFile/complete")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "drive_id": drive_id,
            "file_id": file_id,
            "upload_id": upload_id
        }))
        .send()
        .await
        .map_err(|e| format!("完成阿里云盘上传请求失败: {e}"))?;
    if !complete_resp.status().is_success() {
        let t = complete_resp.text().await.unwrap_or_default();
        return Err(format!("阿里云盘确认上传失败: {t}"));
    }
    Ok(())
}

async fn alipan_download_bytes_from_folder(
    client: &reqwest::Client,
    token: &str,
    drive_id: &str,
    folder_id: &str,
    file_name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let Some(file_id) = alipan_find_file_id(client, token, drive_id, folder_id, file_name).await? else {
        return Ok(None);
    };
    let dl_meta_resp = client
        .post("https://openapi.alipan.com/adrive/v1.0/openFile/getDownloadUrl")
        .bearer_auth(token)
        .json(&serde_json::json!({
            "drive_id": drive_id,
            "file_id": file_id,
            "expire_sec": 900
        }))
        .send()
        .await
        .map_err(|e| format!("获取阿里云盘下载链接失败: {e}"))?;
    let dl_meta: serde_json::Value = dl_meta_resp
        .json()
        .await
        .map_err(|e| format!("解析阿里云盘下载链接失败: {e}"))?;
    let Some(url) = dl_meta.get("url").and_then(|v| v.as_str()) else {
        return Ok(None);
    };
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载阿里云盘文件失败: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let b = resp
        .bytes()
        .await
        .map_err(|e| format!("读取阿里云盘文件字节失败: {e}"))?;
    Ok(Some(b.to_vec()))
}

async fn alipan_push_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("alipan", remote_dir, workspace, auto_workspace_subdir);
    let drive_id = alipan_get_drive_id(client, token).await?;
    let meta_folder_path = format!("{ws_remote_root}/{SYNC_META_DIR}");
    let meta_folder_id = alipan_ensure_folder(client, token, &drive_id, &meta_folder_path).await?;

    let mut manifest: SyncFolderManifest = match alipan_download_bytes_from_folder(
        client,
        token,
        &drive_id,
        &meta_folder_id,
        "manifest.json",
    )
    .await?
    {
        Some(b) => serde_json::from_slice(&b).unwrap_or_default(),
        None => SyncFolderManifest {
            version: 1,
            workspace_name: workspace_folder_name(workspace),
            updated_at: now_unix_secs(),
            encrypted,
            vault_crypto: None,
            files: BTreeMap::new(),
        },
    };

    let enc_key: Option<[u8; 32]> = if encrypted {
        if let Some(ref vc) = manifest.vault_crypto {
            Some(unlock_vault_manifest(vc, passphrase)?)
        } else {
            let (vc, k) = create_vault_manifest(passphrase)?;
            manifest.vault_crypto = Some(vc);
            Some(k)
        }
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut local_files = Vec::new();
    collect_local_files(workspace, workspace, &mut local_files);
    let total_files = local_files.len();
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut new_files_map = BTreeMap::new();
    let mut folder_cache: BTreeMap<String, String> = BTreeMap::new();

    for (idx, (rel, full_path)) in local_files.into_iter().enumerate() {
        let plain_bytes = std::fs::read(&full_path).map_err(|e| format!("读取 {rel} 失败: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, categorize_files);
        let remote_rel = if encrypted { format!("{cat_rel}.enc") } else { cat_rel };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        if let Some(prev) = manifest.files.get(&rel) {
            if prev.sha256 == sha && prev.remote_rel == remote_rel && prev.encrypted == encrypted {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel == remote_rel
                && prev.encrypted == encrypted
                && base_sha == Some(sha.as_str())
            {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            let _ = save_local_version_snapshot(workspace, &rel, &plain_bytes, "阿里云盘同步快照", max_versions);
        }

        let upload_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let full_remote = format!("{ws_remote_root}/{remote_rel}");
        let (parent_dir, fname) = match full_remote.rfind('/') {
            Some(slash_pos) => (&full_remote[..slash_pos], &full_remote[slash_pos + 1..]),
            None => (ws_remote_root.as_str(), full_remote.as_str()),
        };
        let parent_id = if let Some(cached) = folder_cache.get(parent_dir) {
            cached.clone()
        } else {
            let pid = alipan_ensure_folder(client, token, &drive_id, parent_dir).await?;
            folder_cache.insert(parent_dir.to_string(), pid.clone());
            pid
        };

        alipan_upload_bytes_to_folder(client, token, &drive_id, &parent_id, fname, upload_bytes).await?;
        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "cloud_api",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已上传: {rel}", idx + 1, total_files),
        );
    }

    manifest.updated_at = now_unix_secs();
    manifest.encrypted = encrypted;
    manifest.files = new_files_map;
    if let Ok(m_bytes) = serde_json::to_vec_pretty(&manifest) {
        let _ = alipan_upload_bytes_to_folder(
            client,
            token,
            &drive_id,
            &meta_folder_id,
            "manifest.json",
            m_bytes,
        )
        .await;
    }
    write_local_base_manifest(workspace, &manifest);

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!("阿里云盘分类目录同步完成：上传 {uploaded} 个文件，跳过 {skipped} 个未改动文件 ({ws_remote_root})"),
    })
}

async fn alipan_pull_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    _categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("alipan", remote_dir, workspace, auto_workspace_subdir);
    let drive_id = alipan_get_drive_id(client, token).await?;
    let meta_folder_path = format!("{ws_remote_root}/{SYNC_META_DIR}");
    let meta_folder_id = alipan_ensure_folder(client, token, &drive_id, &meta_folder_path).await?;

    let m_bytes = alipan_download_bytes_from_folder(
        client,
        token,
        &drive_id,
        &meta_folder_id,
        "manifest.json",
    )
    .await?
    .ok_or_else(|| format!("阿里云盘专用目录 ({ws_remote_root}) 下未找到同步清单 manifest.json"))?;
    let manifest: SyncFolderManifest =
        serde_json::from_slice(&m_bytes).map_err(|e| format!("解析阿里云盘同步清单失败: {e}"))?;

    let dec_key: Option<[u8; 32]> = if manifest.encrypted || encrypted {
        let vc = manifest
            .vault_crypto
            .as_ref()
            .ok_or("云端文件已开启加密，但清单缺少加密元数据")?;
        Some(unlock_vault_manifest(vc, passphrase)?)
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;
    let mut folder_cache: BTreeMap<String, String> = BTreeMap::new();

    for (local_rel, entry) in &manifest.files {
        let target_local = workspace.join(local_rel);
        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(local_rel))
            .map(|e| e.sha256.as_str());

        if target_local.is_file() {
            if let Ok(existing) = std::fs::read(&target_local) {
                let local_sha = sha256_hex(&existing);
                if local_sha == entry.sha256 {
                    skipped += 1;
                    continue;
                }
                if base_sha == Some(entry.sha256.as_str()) {
                    skipped += 1;
                    continue;
                }
                let _ = save_local_version_snapshot(
                    workspace,
                    local_rel,
                    &existing,
                    "阿里云盘拉取前本地快照",
                    max_versions,
                );
                let is_conflict = match base_sha {
                    Some(b_sha) => local_sha != b_sha && entry.sha256 != b_sha,
                    None => true,
                };
                if is_conflict && write_conflict_copy_file(workspace, local_rel, &existing, "本地修改").is_some() {
                    conflicts += 1;
                }
            }
        }

        let full_remote = format!("{ws_remote_root}/{}", entry.remote_rel);
        let (parent_dir, fname) = match full_remote.rfind('/') {
            Some(slash_pos) => (&full_remote[..slash_pos], &full_remote[slash_pos + 1..]),
            None => (ws_remote_root.as_str(), full_remote.as_str()),
        };
        let parent_id = if let Some(cached) = folder_cache.get(parent_dir) {
            cached.clone()
        } else {
            let pid = alipan_ensure_folder(client, token, &drive_id, parent_dir).await?;
            folder_cache.insert(parent_dir.to_string(), pid.clone());
            pid
        };

        let Some(raw_bytes) =
            alipan_download_bytes_from_folder(client, token, &drive_id, &parent_id, fname).await?
        else {
            continue;
        };
        let plain_bytes = if entry.encrypted {
            let key = dec_key.as_ref().ok_or("需要加密口令以解密阿里云盘文件")?;
            super::crypto::decrypt_bytes(key, local_rel, &raw_bytes)?
        } else {
            raw_bytes
        };
        if let Some(parent) = target_local.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&target_local, &plain_bytes)
            .map_err(|e| format!("写入本地文件 {local_rel} 失败: {e}"))?;
        let _ = save_local_version_snapshot(
            workspace,
            local_rel,
            &plain_bytes,
            "从阿里云盘同步版本",
            max_versions,
        );
        downloaded += 1;
        emit_sync_progress(
            "cloud_api",
            "pull",
            downloaded + skipped,
            manifest.files.len().max(1),
            format!("已下载还原: {local_rel}"),
        );
    }

    write_local_base_manifest(workspace, &manifest);
    let conflict_note = if conflicts > 0 {
        format!("，检测到 {conflicts} 处多端并发修改并已生成冲突副本")
    } else {
        String::new()
    };
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!(
            "已从阿里云盘专用目录 ({ws_remote_root}) 同步更新 {downloaded} 个文件（跳过未改动 {skipped} 个{conflict_note}）"
        ),
    })
}

// ============================================================================
// Google Drive REST API v3 Direct Folder & Bundle Sync
// ============================================================================

async fn gdrive_find_child_id(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    name: &str,
    is_folder: bool,
) -> Result<Option<String>, String> {
    let escaped_name = name.replace('\\', "\\\\").replace('\'', "\\'");
    let mime_clause = if is_folder {
        " and mimeType = 'application/vnd.google-apps.folder'"
    } else {
        " and mimeType != 'application/vnd.google-apps.folder'"
    };
    let q = format!(
        "'{parent_id}' in parents and name = '{escaped_name}' and trashed = false{mime_clause}"
    );
    let url = format!(
        "https://www.googleapis.com/drive/v3/files?q={}&fields=files(id,name)&pageSize=5",
        percent_encode_segment(&q)
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("查询 Google Drive 目录失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Google Drive 查询返回 HTTP {status}: {text}"));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Google Drive 响应失败: {e}"))?;
    let id = json
        .get("files")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(id)
}

async fn gdrive_ensure_folder_path(
    client: &reqwest::Client,
    token: &str,
    folder_path: &str,
) -> Result<String, String> {
    let mut parent_id = "root".to_string();
    for seg in folder_path.split('/').filter(|s| !s.is_empty()) {
        if let Some(existing_id) = gdrive_find_child_id(client, token, &parent_id, seg, true).await? {
            parent_id = existing_id;
            continue;
        }
        let resp = client
            .post("https://www.googleapis.com/drive/v3/files?fields=id")
            .bearer_auth(token)
            .json(&serde_json::json!({
                "name": seg,
                "mimeType": "application/vnd.google-apps.folder",
                "parents": [parent_id]
            }))
            .send()
            .await
            .map_err(|e| format!("创建 Google Drive 目录 {seg} 失败: {e}"))?;
        if !resp.status().is_success() {
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("创建 Google Drive 目录 {seg} 失败: {t}"));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析 Google Drive 目录创建响应失败: {e}"))?;
        parent_id = json
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Google Drive 未返回目录 id: {json}"))?
            .to_string();
    }
    Ok(parent_id)
}

async fn gdrive_upload_bytes_in_folder(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    file_name: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let existing_id = gdrive_find_child_id(client, token, parent_id, file_name, false).await?;
    let file_id = if let Some(id) = existing_id {
        id
    } else {
        let create_resp = client
            .post("https://www.googleapis.com/drive/v3/files?fields=id")
            .bearer_auth(token)
            .json(&serde_json::json!({
                "name": file_name,
                "parents": [parent_id]
            }))
            .send()
            .await
            .map_err(|e| format!("Google Drive 创建文件元数据 {file_name} 失败: {e}"))?;
        if !create_resp.status().is_success() {
            let t = create_resp.text().await.unwrap_or_default();
            return Err(format!("Google Drive 创建文件 {file_name} 失败: {t}"));
        }
        let j: serde_json::Value = create_resp
            .json()
            .await
            .map_err(|e| format!("解析 Google Drive 创建文件响应失败: {e}"))?;
        j.get("id")
            .and_then(|v| v.as_str())
            .ok_or("Google Drive 未返回文件 id")?
            .to_string()
    };

    let upload_url = format!(
        "https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media",
        percent_encode_segment(&file_id)
    );
    let resp = client
        .patch(&upload_url)
        .bearer_auth(token)
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Google Drive 上传文件内容 {file_name} 失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Google Drive 上传 {file_name} 返回 HTTP {status}: {text}"));
    }
    Ok(())
}

async fn gdrive_download_bytes_in_folder(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    file_name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let Some(file_id) = gdrive_find_child_id(client, token, parent_id, file_name, false).await? else {
        return Ok(None);
    };
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?alt=media",
        percent_encode_segment(&file_id)
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("Google Drive 下载 {file_name} 失败: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let b = resp
        .bytes()
        .await
        .map_err(|e| format!("读取 Google Drive 文件字节失败: {e}"))?;
    Ok(Some(b.to_vec()))
}

async fn gdrive_upload_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
    bundle: Vec<u8>,
) -> Result<(), String> {
    let folder_id = gdrive_ensure_folder_path(client, token, remote_dir).await?;
    gdrive_upload_bytes_in_folder(client, token, &folder_id, BUNDLE_FILENAME, bundle).await
}

async fn gdrive_download_bundle(
    client: &reqwest::Client,
    token: &str,
    remote_dir: &str,
) -> Result<Vec<u8>, String> {
    let folder_id = gdrive_ensure_folder_path(client, token, remote_dir).await?;
    gdrive_download_bytes_in_folder(client, token, &folder_id, BUNDLE_FILENAME)
        .await?
        .ok_or_else(|| format!("Google Drive 目录 ({remote_dir}) 下未找到加密备份包 {BUNDLE_FILENAME}"))
}

async fn gdrive_push_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("gdrive", remote_dir, workspace, auto_workspace_subdir);
    let meta_folder_path = format!("{ws_remote_root}/{SYNC_META_DIR}");
    let meta_folder_id = gdrive_ensure_folder_path(client, token, &meta_folder_path).await?;

    let mut manifest: SyncFolderManifest = match gdrive_download_bytes_in_folder(
        client,
        token,
        &meta_folder_id,
        "manifest.json",
    )
    .await?
    {
        Some(b) => serde_json::from_slice(&b).unwrap_or_default(),
        None => SyncFolderManifest {
            version: 1,
            workspace_name: workspace_folder_name(workspace),
            updated_at: now_unix_secs(),
            encrypted,
            vault_crypto: None,
            files: BTreeMap::new(),
        },
    };

    let enc_key: Option<[u8; 32]> = if encrypted {
        if let Some(ref vc) = manifest.vault_crypto {
            Some(unlock_vault_manifest(vc, passphrase)?)
        } else {
            let (vc, k) = create_vault_manifest(passphrase)?;
            manifest.vault_crypto = Some(vc);
            Some(k)
        }
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut local_files = Vec::new();
    collect_local_files(workspace, workspace, &mut local_files);
    let total_files = local_files.len();
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut new_files_map = BTreeMap::new();
    let mut folder_cache: BTreeMap<String, String> = BTreeMap::new();

    for (idx, (rel, full_path)) in local_files.into_iter().enumerate() {
        let plain_bytes = std::fs::read(&full_path).map_err(|e| format!("读取 {rel} 失败: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, categorize_files);
        let remote_rel = if encrypted { format!("{cat_rel}.enc") } else { cat_rel };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        if let Some(prev) = manifest.files.get(&rel) {
            if prev.sha256 == sha && prev.remote_rel == remote_rel && prev.encrypted == encrypted {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel == remote_rel
                && prev.encrypted == encrypted
                && base_sha == Some(sha.as_str())
            {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            let _ = save_local_version_snapshot(workspace, &rel, &plain_bytes, "Google Drive 同步快照", max_versions);
        }

        let upload_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let full_remote = format!("{ws_remote_root}/{remote_rel}");
        let (parent_dir, fname) = match full_remote.rfind('/') {
            Some(slash_pos) => (&full_remote[..slash_pos], &full_remote[slash_pos + 1..]),
            None => (ws_remote_root.as_str(), full_remote.as_str()),
        };
        let parent_id = if let Some(cached) = folder_cache.get(parent_dir) {
            cached.clone()
        } else {
            let pid = gdrive_ensure_folder_path(client, token, parent_dir).await?;
            folder_cache.insert(parent_dir.to_string(), pid.clone());
            pid
        };

        gdrive_upload_bytes_in_folder(client, token, &parent_id, fname, upload_bytes).await?;
        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "cloud_api",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已上传: {rel}", idx + 1, total_files),
        );
    }

    manifest.updated_at = now_unix_secs();
    manifest.encrypted = encrypted;
    manifest.files = new_files_map;
    if let Ok(m_bytes) = serde_json::to_vec_pretty(&manifest) {
        let _ = gdrive_upload_bytes_in_folder(
            client,
            token,
            &meta_folder_id,
            "manifest.json",
            m_bytes,
        )
        .await;
    }
    write_local_base_manifest(workspace, &manifest);

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!("Google Drive 分类目录同步完成：上传 {uploaded} 个文件，跳过 {skipped} 个未改动文件 ({ws_remote_root})"),
    })
}

async fn gdrive_pull_folder(
    client: &reqwest::Client,
    token: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    _categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let ws_remote_root =
        resolve_remote_workspace_dir("gdrive", remote_dir, workspace, auto_workspace_subdir);
    let meta_folder_path = format!("{ws_remote_root}/{SYNC_META_DIR}");
    let meta_folder_id = gdrive_ensure_folder_path(client, token, &meta_folder_path).await?;

    let m_bytes = gdrive_download_bytes_in_folder(
        client,
        token,
        &meta_folder_id,
        "manifest.json",
    )
    .await?
    .ok_or_else(|| format!("Google Drive 专用目录 ({ws_remote_root}) 下未找到同步清单 manifest.json"))?;
    let manifest: SyncFolderManifest =
        serde_json::from_slice(&m_bytes).map_err(|e| format!("解析 Google Drive 同步清单失败: {e}"))?;

    let dec_key: Option<[u8; 32]> = if manifest.encrypted || encrypted {
        let vc = manifest
            .vault_crypto
            .as_ref()
            .ok_or("云端文件已开启加密，但清单缺少加密元数据")?;
        Some(unlock_vault_manifest(vc, passphrase)?)
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;
    let mut folder_cache: BTreeMap<String, String> = BTreeMap::new();

    for (local_rel, entry) in &manifest.files {
        let target_local = workspace.join(local_rel);
        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(local_rel))
            .map(|e| e.sha256.as_str());

        if target_local.is_file() {
            if let Ok(existing) = std::fs::read(&target_local) {
                let local_sha = sha256_hex(&existing);
                if local_sha == entry.sha256 {
                    skipped += 1;
                    continue;
                }
                if base_sha == Some(entry.sha256.as_str()) {
                    skipped += 1;
                    continue;
                }
                let _ = save_local_version_snapshot(
                    workspace,
                    local_rel,
                    &existing,
                    "Google Drive 拉取前本地快照",
                    max_versions,
                );
                let is_conflict = match base_sha {
                    Some(b_sha) => local_sha != b_sha && entry.sha256 != b_sha,
                    None => true,
                };
                if is_conflict && write_conflict_copy_file(workspace, local_rel, &existing, "本地修改").is_some() {
                    conflicts += 1;
                }
            }
        }

        let full_remote = format!("{ws_remote_root}/{}", entry.remote_rel);
        let (parent_dir, fname) = match full_remote.rfind('/') {
            Some(slash_pos) => (&full_remote[..slash_pos], &full_remote[slash_pos + 1..]),
            None => (ws_remote_root.as_str(), full_remote.as_str()),
        };
        let parent_id = if let Some(cached) = folder_cache.get(parent_dir) {
            cached.clone()
        } else {
            let pid = gdrive_ensure_folder_path(client, token, parent_dir).await?;
            folder_cache.insert(parent_dir.to_string(), pid.clone());
            pid
        };

        let Some(raw_bytes) =
            gdrive_download_bytes_in_folder(client, token, &parent_id, fname).await?
        else {
            continue;
        };
        let plain_bytes = if entry.encrypted {
            let key = dec_key.as_ref().ok_or("需要加密口令以解密 Google Drive 文件")?;
            super::crypto::decrypt_bytes(key, local_rel, &raw_bytes)?
        } else {
            raw_bytes
        };
        if let Some(parent) = target_local.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&target_local, &plain_bytes)
            .map_err(|e| format!("写入本地文件 {local_rel} 失败: {e}"))?;
        let _ = save_local_version_snapshot(
            workspace,
            local_rel,
            &plain_bytes,
            "从 Google Drive 同步版本",
            max_versions,
        );
        downloaded += 1;
        emit_sync_progress(
            "cloud_api",
            "pull",
            downloaded + skipped,
            manifest.files.len().max(1),
            format!("已下载还原: {local_rel}"),
        );
    }

    write_local_base_manifest(workspace, &manifest);
    let conflict_note = if conflicts > 0 {
        format!("，检测到 {conflicts} 处多端并发修改并已生成冲突副本")
    } else {
        String::new()
    };
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!(
            "已从 Google Drive 专用目录 ({ws_remote_root}) 同步更新 {downloaded} 个文件（跳过未改动 {skipped} 个{conflict_note}）"
        ),
    })
}

// ============================================================================
// Cloudflare R2 / S3-Compatible Object Storage (Pure-Rust AWS Signature V4)
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
struct R2Credentials {
    /// Either a full URL (`https://<account_id>.r2.cloudflarestorage.com`) or a Cloudflare Account ID.
    endpoint: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    region: String,
}

impl R2Credentials {
    fn parse(raw: &str) -> Result<Self, String> {
        let trimmed = raw.trim();
        let mut creds: R2Credentials = serde_json::from_str(trimmed).map_err(|_| {
            "请填写完整的 Cloudflare R2 / S3 配置（Endpoint 或 Account ID、Bucket、Access Key ID、Secret Access Key）".to_string()
        })?;
        creds.endpoint = creds.endpoint.trim().trim_end_matches('/').to_string();
        creds.bucket = creds.bucket.trim().trim_matches('/').to_string();
        creds.access_key_id = creds.access_key_id.trim().to_string();
        creds.secret_access_key = creds.secret_access_key.trim().to_string();
        if creds.endpoint.is_empty()
            || creds.bucket.is_empty()
            || creds.access_key_id.is_empty()
            || creds.secret_access_key.is_empty()
        {
            return Err("Cloudflare R2 的 Endpoint / Bucket / Access Key ID / Secret Access Key 均不能为空".into());
        }
        if !creds.endpoint.starts_with("http://") && !creds.endpoint.starts_with("https://") {
            if creds.endpoint.contains('.') {
                creds.endpoint = format!("https://{}", creds.endpoint);
            } else {
                // Treat bare string as Cloudflare Account ID
                creds.endpoint = format!("https://{}.r2.cloudflarestorage.com", creds.endpoint);
            }
        }
        if creds.region.trim().is_empty() {
            creds.region = "auto".to_string();
        }
        Ok(creds)
    }

    fn host(&self) -> String {
        let without_scheme = self
            .endpoint
            .strip_prefix("https://")
            .or_else(|| self.endpoint.strip_prefix("http://"))
            .unwrap_or(&self.endpoint);
        without_scheme
            .split('/')
            .next()
            .unwrap_or(without_scheme)
            .to_string()
    }
}

/// RFC 2104 HMAC-SHA256 implemented directly on top of `sha2::Sha256`.
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k_block = [0u8; 64];
    if key.len() > 64 {
        let digest = Sha256::digest(key);
        k_block[..32].copy_from_slice(&digest);
    } else {
        k_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k_block[i];
        opad[i] ^= k_block[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    let out = outer.finalize();
    let mut res = [0u8; 32];
    res.copy_from_slice(&out);
    res
}

/// Format Unix timestamp into `(YYYYMMDD, YYYYMMDDTHHMMSSZ)` in UTC for AWS Signature V4.
fn format_amz_date(unix_secs: u64) -> (String, String) {
    let days = (unix_secs / 86400) as i64;
    let secs_of_day = (unix_secs % 86400) as u32;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    // Howard Hinnant's civil_from_days algorithm
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    let date_stamp = format!("{year:04}{m:02}{d:02}");
    let amz_date = format!("{date_stamp}T{hour:02}{minute:02}{second:02}Z");
    (date_stamp, amz_date)
}

fn build_s3_sigv4_headers(
    creds: &R2Credentials,
    method: &str,
    canonical_uri: &str,
    payload: &[u8],
) -> (String, String, String) {
    let (date_stamp, amz_date) = format_amz_date(now_unix_secs().max(0) as u64);
    let payload_hash = sha256_hex(payload);
    let host = creds.host();

    let canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", creds.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_secret = format!("AWS4{}", creds.secret_access_key);
    let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, creds.region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let sig_bytes = hmac_sha256(&k_signing, string_to_sign.as_bytes());
    let signature: String = sig_bytes.iter().map(|b| format!("{b:02x}")).collect();

    let auth_header = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key_id
    );
    (auth_header, amz_date, payload_hash)
}

async fn r2_put_object(
    client: &reqwest::Client,
    creds: &R2Credentials,
    object_key: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let clean_key = object_key.trim_start_matches('/');
    let canonical_uri = format!(
        "/{}/{}",
        percent_encode_segment(&creds.bucket),
        encode_rel_segments(clean_key)
    );
    let url = format!("{}{}", creds.endpoint, canonical_uri);
    let (auth, amz_date, payload_hash) =
        build_s3_sigv4_headers(creds, "PUT", &canonical_uri, &bytes);

    let resp = client
        .put(&url)
        .header("Authorization", auth)
        .header("x-amz-date", amz_date)
        .header("x-amz-content-sha256", payload_hash)
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Cloudflare R2 上传 {clean_key} 失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Cloudflare R2 上传 {clean_key} 返回 HTTP {status}: {text}"));
    }
    Ok(())
}

async fn r2_get_object(
    client: &reqwest::Client,
    creds: &R2Credentials,
    object_key: &str,
) -> Result<Option<Vec<u8>>, String> {
    let clean_key = object_key.trim_start_matches('/');
    let canonical_uri = format!(
        "/{}/{}",
        percent_encode_segment(&creds.bucket),
        encode_rel_segments(clean_key)
    );
    let url = format!("{}{}", creds.endpoint, canonical_uri);
    let (auth, amz_date, payload_hash) = build_s3_sigv4_headers(creds, "GET", &canonical_uri, b"");

    let resp = client
        .get(&url)
        .header("Authorization", auth)
        .header("x-amz-date", amz_date)
        .header("x-amz-content-sha256", payload_hash)
        .send()
        .await
        .map_err(|e| format!("Cloudflare R2 下载 {clean_key} 失败: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Cloudflare R2 下载 {clean_key} 返回 HTTP {status}: {text}"));
    }
    let b = resp
        .bytes()
        .await
        .map_err(|e| format!("读取 Cloudflare R2 响应失败: {e}"))?;
    Ok(Some(b.to_vec()))
}

async fn r2_upload_bundle(
    client: &reqwest::Client,
    raw_creds: &str,
    remote_dir: &str,
    bundle: Vec<u8>,
) -> Result<(), String> {
    let creds = R2Credentials::parse(raw_creds)?;
    let key = format!("{}/{}", remote_dir.trim_matches('/'), BUNDLE_FILENAME);
    r2_put_object(client, &creds, &key, bundle).await
}

async fn r2_download_bundle(
    client: &reqwest::Client,
    raw_creds: &str,
    remote_dir: &str,
) -> Result<Vec<u8>, String> {
    let creds = R2Credentials::parse(raw_creds)?;
    let key = format!("{}/{}", remote_dir.trim_matches('/'), BUNDLE_FILENAME);
    r2_get_object(client, &creds, &key)
        .await?
        .ok_or_else(|| format!("Cloudflare R2 存储桶中未找到加密备份包 {key}"))
}

async fn r2_push_folder(
    client: &reqwest::Client,
    raw_creds: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let creds = R2Credentials::parse(raw_creds)?;
    let ws_remote_root =
        resolve_remote_workspace_dir("r2", remote_dir, workspace, auto_workspace_subdir);
    let prefix = ws_remote_root.trim_matches('/');
    let manifest_key = format!("{prefix}/{SYNC_MANIFEST_REL}");

    let mut manifest: SyncFolderManifest = match r2_get_object(client, &creds, &manifest_key).await? {
        Some(b) => serde_json::from_slice(&b).unwrap_or_default(),
        None => SyncFolderManifest {
            version: 1,
            workspace_name: workspace_folder_name(workspace),
            updated_at: now_unix_secs(),
            encrypted,
            vault_crypto: None,
            files: BTreeMap::new(),
        },
    };

    let enc_key: Option<[u8; 32]> = if encrypted {
        if let Some(ref vc) = manifest.vault_crypto {
            Some(unlock_vault_manifest(vc, passphrase)?)
        } else {
            let (vc, k) = create_vault_manifest(passphrase)?;
            manifest.vault_crypto = Some(vc);
            Some(k)
        }
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut local_files = Vec::new();
    collect_local_files(workspace, workspace, &mut local_files);
    let total_files = local_files.len();
    let mut uploaded = 0usize;
    let mut skipped = 0usize;
    let mut new_files_map = BTreeMap::new();

    for (idx, (rel, full_path)) in local_files.into_iter().enumerate() {
        let plain_bytes = std::fs::read(&full_path).map_err(|e| format!("读取 {rel} 失败: {e}"))?;
        let sha = sha256_hex(&plain_bytes);
        let cat_rel = map_categorized_rel_path(&rel, categorize_files);
        let remote_rel = if encrypted { format!("{cat_rel}.enc") } else { cat_rel };

        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(&rel))
            .map(|e| e.sha256.as_str());

        if let Some(prev) = manifest.files.get(&rel) {
            if prev.sha256 == sha && prev.remote_rel == remote_rel && prev.encrypted == encrypted {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            if prev.remote_rel == remote_rel
                && prev.encrypted == encrypted
                && base_sha == Some(sha.as_str())
            {
                new_files_map.insert(rel.clone(), prev.clone());
                skipped += 1;
                continue;
            }
            let _ = save_local_version_snapshot(
                workspace,
                &rel,
                &plain_bytes,
                "Cloudflare R2 同步快照",
                max_versions,
            );
        }

        let upload_bytes = if let Some(ref key) = enc_key {
            super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?
        } else {
            plain_bytes.clone()
        };

        let obj_key = format!("{prefix}/{remote_rel}");
        r2_put_object(client, &creds, &obj_key, upload_bytes).await?;

        new_files_map.insert(
            rel.clone(),
            SyncFileManifestEntry {
                local_rel: rel.clone(),
                remote_rel,
                sha256: sha,
                size: plain_bytes.len() as u64,
                updated_at: now_unix_secs(),
                encrypted,
            },
        );
        uploaded += 1;
        emit_sync_progress(
            "cloud_api",
            "push",
            idx + 1,
            total_files.max(1),
            format!("[{}/{}] 已上传: {rel}", idx + 1, total_files),
        );
    }

    manifest.updated_at = now_unix_secs();
    manifest.encrypted = encrypted;
    manifest.files = new_files_map;
    if let Ok(m_bytes) = serde_json::to_vec_pretty(&manifest) {
        let _ = r2_put_object(client, &creds, &manifest_key, m_bytes).await;
    }
    write_local_base_manifest(workspace, &manifest);

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!(
            "Cloudflare R2 分类目录同步完成：上传 {uploaded} 个文件，跳过 {skipped} 个未改动文件 ({}/{prefix})",
            creds.bucket
        ),
    })
}

async fn r2_pull_folder(
    client: &reqwest::Client,
    raw_creds: &str,
    workspace: &Path,
    remote_dir: &str,
    encrypted: bool,
    passphrase: &str,
    auto_workspace_subdir: bool,
    _categorize_files: bool,
    max_versions: usize,
) -> Result<WebdavSyncResult, String> {
    let creds = R2Credentials::parse(raw_creds)?;
    let ws_remote_root =
        resolve_remote_workspace_dir("r2", remote_dir, workspace, auto_workspace_subdir);
    let prefix = ws_remote_root.trim_matches('/');
    let manifest_key = format!("{prefix}/{SYNC_MANIFEST_REL}");

    let m_bytes = r2_get_object(client, &creds, &manifest_key)
        .await?
        .ok_or_else(|| format!("Cloudflare R2 存储桶 ({}/{prefix}) 下未找到同步清单 manifest.json", creds.bucket))?;
    let manifest: SyncFolderManifest =
        serde_json::from_slice(&m_bytes).map_err(|e| format!("解析 Cloudflare R2 同步清单失败: {e}"))?;

    let dec_key: Option<[u8; 32]> = if manifest.encrypted || encrypted {
        let vc = manifest
            .vault_crypto
            .as_ref()
            .ok_or("云端文件已开启加密，但清单缺少加密元数据")?;
        Some(unlock_vault_manifest(vc, passphrase)?)
    } else {
        None
    };

    let local_base = read_local_base_manifest(workspace);
    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;

    for (local_rel, entry) in &manifest.files {
        let target_local = workspace.join(local_rel);
        let base_sha = local_base
            .as_ref()
            .and_then(|m| m.files.get(local_rel))
            .map(|e| e.sha256.as_str());

        if target_local.is_file() {
            if let Ok(existing) = std::fs::read(&target_local) {
                let local_sha = sha256_hex(&existing);
                if local_sha == entry.sha256 {
                    skipped += 1;
                    continue;
                }
                if base_sha == Some(entry.sha256.as_str()) {
                    skipped += 1;
                    continue;
                }
                let _ = save_local_version_snapshot(
                    workspace,
                    local_rel,
                    &existing,
                    "Cloudflare R2 拉取前本地快照",
                    max_versions,
                );
                let is_conflict = match base_sha {
                    Some(b_sha) => local_sha != b_sha && entry.sha256 != b_sha,
                    None => true,
                };
                if is_conflict && write_conflict_copy_file(workspace, local_rel, &existing, "本地修改").is_some() {
                    conflicts += 1;
                }
            }
        }

        let obj_key = format!("{prefix}/{}", entry.remote_rel);
        let Some(raw_bytes) = r2_get_object(client, &creds, &obj_key).await? else {
            continue;
        };
        let plain_bytes = if entry.encrypted {
            let key = dec_key.as_ref().ok_or("需要加密口令以解密 Cloudflare R2 文件")?;
            super::crypto::decrypt_bytes(key, local_rel, &raw_bytes)?
        } else {
            raw_bytes
        };
        if let Some(parent) = target_local.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&target_local, &plain_bytes)
            .map_err(|e| format!("写入本地文件 {local_rel} 失败: {e}"))?;
        let _ = save_local_version_snapshot(
            workspace,
            local_rel,
            &plain_bytes,
            "从 Cloudflare R2 同步版本",
            max_versions,
        );
        downloaded += 1;
        emit_sync_progress(
            "cloud_api",
            "pull",
            downloaded + skipped,
            manifest.files.len().max(1),
            format!("已下载还原: {local_rel}"),
        );
    }

    write_local_base_manifest(workspace, &manifest);
    let conflict_note = if conflicts > 0 {
        format!("，检测到 {conflicts} 处多端并发修改并已生成冲突副本")
    } else {
        String::new()
    };
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!(
            "已从 Cloudflare R2 ({}/{prefix}) 同步更新 {downloaded} 个文件（跳过未改动 {skipped} 个{conflict_note}）",
            creds.bucket
        ),
    })
}

#[tauri::command]
pub async fn cloud_api_push_workspace(
    app: tauri::AppHandle,
    workspace: String,
    provider: String,
    access_token: String,
    remote_path: String,
    passphrase: String,
    sync_mode: Option<String>,
    encrypted: Option<bool>,
    auto_workspace_subdir: Option<bool>,
    categorize_files: Option<bool>,
    max_versions: Option<usize>,
) -> Result<WebdavSyncResult, String> {
    set_sync_app_handle(&app);
    let prov = provider.trim().to_ascii_lowercase();
    let token = if prov == "r2" {
        access_token.trim().to_string()
    } else {
        extract_access_token(&access_token)
    };
    if token.is_empty() {
        return Err("请先授权或填入网盘 Access Token / R2 密钥".into());
    }
    let ws = PathBuf::from(workspace.trim());
    if !ws.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    emit_sync_progress(
        "cloud_api",
        "push",
        2,
        100,
        format!("正在连接 {} 开放平台，准备扫描并上传文件…", prov),
    );
    let client = build_client()?;
    let mode = sync_mode.unwrap_or_else(|| "folder".to_string());
    let use_enc = encrypted.unwrap_or(false);
    let auto_sub = auto_workspace_subdir.unwrap_or(true);
    let cat_files = categorize_files.unwrap_or(true);
    let max_v = max_versions.unwrap_or(DEFAULT_MAX_VERSIONS);

    if mode != "bundle" {
        let res = match prov.as_str() {
            "baidu" => {
                baidu_push_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "alipan" => {
                alipan_push_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "onedrive" => {
                onedrive_push_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "dropbox" => {
                dropbox_push_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "gdrive" => {
                gdrive_push_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "r2" => {
                r2_push_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            other => Err(format!("不支持的网盘开放平台类型: {other}")),
        }?;
        emit_sync_progress("cloud_api", "push", 100, 100, &res.message);
        return Ok(res);
    }

    emit_sync_progress("cloud_api", "push", 25, 100, "正在打包并加密工作区文件…");
    let pass = passphrase.clone();
    let (bundle, count) =
        tauri::async_runtime::spawn_blocking(move || pack_encrypted_vault_bundle(&ws, &pass))
            .await
            .map_err(|e| format!("join: {e}"))??;

    emit_sync_progress(
        "cloud_api",
        "push",
        60,
        100,
        format!("正在上传加密归档包 ({count} 个文件)…"),
    );
    let target_remote = resolve_remote_workspace_dir(&prov, &remote_path, Path::new(workspace.trim()), auto_sub);
    match prov.as_str() {
        "baidu" => baidu_upload_bundle(&client, &token, &target_remote, bundle).await?,
        "alipan" => alipan_upload_bundle(&client, &token, &target_remote, bundle).await?,
        "onedrive" => onedrive_upload_bundle(&client, &token, &target_remote, bundle).await?,
        "dropbox" => dropbox_upload_bundle(&client, &token, &target_remote, bundle).await?,
        "gdrive" => gdrive_upload_bundle(&client, &token, &target_remote, bundle).await?,
        "r2" => r2_upload_bundle(&client, &token, &target_remote, bundle).await?,
        other => return Err(format!("不支持的网盘开放平台类型: {other}")),
    }

    let final_msg = format!(
        "已将 {count} 个文件打包并端到端加密上传到 {} ({target_remote}/{BUNDLE_FILENAME})",
        match prov.as_str() {
            "baidu" => "百度网盘",
            "alipan" => "阿里云盘",
            "onedrive" => "OneDrive",
            "dropbox" => "Dropbox",
            "gdrive" => "Google Drive",
            "r2" => "Cloudflare R2",
            _ => &prov,
        }
    );
    emit_sync_progress("cloud_api", "push", 100, 100, &final_msg);
    Ok(WebdavSyncResult {
        uploaded: count,
        downloaded: 0,
        message: final_msg,
    })
}

#[tauri::command]
pub async fn cloud_api_pull_workspace(
    app: tauri::AppHandle,
    workspace: String,
    provider: String,
    access_token: String,
    remote_path: String,
    passphrase: String,
    sync_mode: Option<String>,
    encrypted: Option<bool>,
    auto_workspace_subdir: Option<bool>,
    categorize_files: Option<bool>,
    max_versions: Option<usize>,
) -> Result<WebdavSyncResult, String> {
    set_sync_app_handle(&app);
    let prov = provider.trim().to_ascii_lowercase();
    let token = if prov == "r2" {
        access_token.trim().to_string()
    } else {
        extract_access_token(&access_token)
    };
    if token.is_empty() {
        return Err("请先授权或填入网盘 Access Token / R2 密钥".into());
    }
    let ws = PathBuf::from(workspace.trim());
    if !ws.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    emit_sync_progress(
        "cloud_api",
        "pull",
        5,
        100,
        format!("正在连接 {} 开放平台，读取远程同步清单…", prov),
    );
    let client = build_client()?;
    let mode = sync_mode.unwrap_or_else(|| "folder".to_string());
    let use_enc = encrypted.unwrap_or(false);
    let auto_sub = auto_workspace_subdir.unwrap_or(true);
    let cat_files = categorize_files.unwrap_or(true);
    let max_v = max_versions.unwrap_or(DEFAULT_MAX_VERSIONS);

    if mode != "bundle" {
        let res = match prov.as_str() {
            "baidu" => {
                baidu_pull_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "alipan" => {
                alipan_pull_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "onedrive" => {
                onedrive_pull_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "dropbox" => {
                dropbox_pull_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "gdrive" => {
                gdrive_pull_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            "r2" => {
                r2_pull_folder(
                    &client,
                    &token,
                    &ws,
                    &remote_path,
                    use_enc,
                    &passphrase,
                    auto_sub,
                    cat_files,
                    max_v,
                )
                .await
            }
            other => Err(format!("不支持的网盘开放平台类型: {other}")),
        }?;
        emit_sync_progress("cloud_api", "pull", 100, 100, &res.message);
        return Ok(res);
    }

    let target_remote = resolve_remote_workspace_dir(&prov, &remote_path, &ws, auto_sub);
    emit_sync_progress("cloud_api", "pull", 40, 100, "正在下载远程加密归档包…");
    let bundle = match prov.as_str() {
        "baidu" => baidu_download_bundle(&client, &token, &target_remote).await?,
        "alipan" => alipan_download_bundle(&client, &token, &target_remote).await?,
        "onedrive" => onedrive_download_bundle(&client, &token, &target_remote).await?,
        "dropbox" => dropbox_download_bundle(&client, &token, &target_remote).await?,
        "gdrive" => gdrive_download_bundle(&client, &token, &target_remote).await?,
        "r2" => r2_download_bundle(&client, &token, &target_remote).await?,
        other => return Err(format!("不支持的网盘开放平台类型: {other}")),
    };

    emit_sync_progress("cloud_api", "pull", 80, 100, "正在解密并解包还原本地文件…");
    let pass = passphrase.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || {
        unpack_encrypted_vault_bundle(&ws, &bundle, &pass)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    let final_msg = format!(
        "已从 {} 下载加密包并解密还原 {extracted} 个文件",
        match prov.as_str() {
            "baidu" => "百度网盘",
            "alipan" => "阿里云盘",
            "onedrive" => "OneDrive",
            "dropbox" => "Dropbox",
            "gdrive" => "Google Drive",
            "r2" => "Cloudflare R2",
            _ => &prov,
        }
    );
    emit_sync_progress("cloud_api", "pull", 100, 100, &final_msg);
    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded: extracted,
        message: final_msg,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_vault_encrypted_round_trip_and_wrong_passphrase_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let dev_a = tmp.path().join("device_a");
        let cloud_drive = tmp.path().join("baidu_netdisk_sync_vault");
        let dev_b = tmp.path().join("device_b");

        std::fs::create_dir_all(dev_a.join(" subfolder")).unwrap();
        std::fs::create_dir_all(&dev_b).unwrap();
        std::fs::write(dev_a.join("hello.md"), "# 太阳雨赞助加密网盘同步\n正文内容").unwrap();
        std::fs::write(dev_a.join(" subfolder/nested.md"), "子目录笔记 123").unwrap();

        // 1. Device A pushes encrypted backup to cloud drive folder
        let push_res = cloud_vault_push_inner(&dev_a, &cloud_drive, "solar-rain-secret").unwrap();
        assert_eq!(push_res.uploaded, 2);
        assert!(cloud_drive.join("solomd-vault.json").exists());
        assert!(cloud_drive.join("hello.md.enc").exists());
        assert!(cloud_drive.join(" subfolder/nested.md.enc").exists());

        // Verify ciphertext on cloud drive does NOT contain plaintext
        let ct = std::fs::read(cloud_drive.join("hello.md.enc")).unwrap();
        assert_eq!(&ct[..4], b"SLMD");
        assert!(!String::from_utf8_lossy(&ct).contains("太阳雨"));

        // 2. Wrong passphrase on Device B must be rejected
        let bad_pull = cloud_vault_pull_inner(&dev_b, &cloud_drive, "wrong-passphrase");
        assert!(bad_pull.is_err());

        // 3. Correct passphrase on Device B decrypts and restores all files
        let pull_res = cloud_vault_pull_inner(&dev_b, &cloud_drive, "solar-rain-secret").unwrap();
        assert_eq!(pull_res.downloaded, 2);
        assert_eq!(
            std::fs::read_to_string(dev_b.join("hello.md")).unwrap(),
            "# 太阳雨赞助加密网盘同步\n正文内容"
        );
        assert_eq!(
            std::fs::read_to_string(dev_b.join(" subfolder/nested.md")).unwrap(),
            "子目录笔记 123"
        );
    }

    #[test]
    fn encrypted_bundle_pack_unpack_round_trip_and_wrong_passphrase_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let dev_a = tmp.path().join("dev_a");
        let dev_b = tmp.path().join("dev_b");

        std::fs::create_dir_all(dev_a.join("notes")).unwrap();
        std::fs::create_dir_all(&dev_b).unwrap();
        std::fs::write(dev_a.join("index.md"), "# 开放平台直连加密包").unwrap();
        std::fs::write(dev_a.join("notes/secret.md"), "高度机密笔记内容").unwrap();

        let (bundle, count) = pack_encrypted_vault_bundle(&dev_a, "tyysoft-pass-300").unwrap();
        assert_eq!(count, 2);
        assert_eq!(&bundle[..5], b"SLMB\x01");
        // Neither filenames nor plaintext should appear in the encrypted bundle
        let lossy = String::from_utf8_lossy(&bundle);
        assert!(!lossy.contains("高度机密笔记内容"));
        assert!(!lossy.contains("secret.md"));

        assert!(unpack_encrypted_vault_bundle(&dev_b, &bundle, "wrong-pass").is_err());

        let extracted = unpack_encrypted_vault_bundle(&dev_b, &bundle, "tyysoft-pass-300").unwrap();
        assert_eq!(extracted, 2);
        assert_eq!(
            std::fs::read_to_string(dev_b.join("index.md")).unwrap(),
            "# 开放平台直连加密包"
        );
        assert_eq!(
            std::fs::read_to_string(dev_b.join("notes/secret.md")).unwrap(),
            "高度机密笔记内容"
        );
    }

    #[test]
    fn extract_access_token_from_url_json_and_raw() {
        assert_eq!(
            extract_access_token("https://openapi.baidu.com/oauth/2.0/login_success#expires_in=2592000&access_token=24.9a8b7c.2592000.123-456&session_secret=zzz"),
            "24.9a8b7c.2592000.123-456"
        );
        assert_eq!(
            extract_access_token(r#"{"access_token": "24.json_tok_123", "expires_in": 3600}"#),
            "24.json_tok_123"
        );
        assert_eq!(extract_access_token("  24.plain_token_xyz  "), "24.plain_token_xyz");
    }

    #[test]
    fn dedicated_workspace_dir_and_categorized_folder_sync_with_versioning() {
        let tmp = tempfile::tempdir().unwrap();
        let ws_a = tmp.path().join("dev_a").join("MyKnowledgeBase");
        let cloud_root = tmp.path().join("BaiduNetdisk");
        let ws_b = tmp.path().join("dev_b").join("MyKnowledgeBase");

        std::fs::create_dir_all(ws_a.join("后端架构")).unwrap();
        std::fs::create_dir_all(&ws_b).unwrap();
        std::fs::write(ws_a.join("loose.md"), "# 根目录笔记 v1").unwrap();
        std::fs::write(ws_a.join("cover.png"), b"\x89PNG-fake-image").unwrap();
        std::fs::write(ws_a.join("后端架构/微服务.md"), "# 微服务设计 v1").unwrap();

        // Push with dedicated workspace subdir (`BaiduNetdisk/MyKnowledgeBase`), plaintext mode, and loose file categorization
        let res1 = cloud_vault_push_options_inner(&ws_a, &cloud_root, "", false, true, true, 5).unwrap();
        assert_eq!(res1.uploaded, 3);
        let dedicated = cloud_root.join("MyKnowledgeBase");
        assert!(dedicated.join("笔记文档/loose.md").exists());
        assert!(dedicated.join("图片素材/cover.png").exists());
        assert!(dedicated.join("后端架构/微服务.md").exists());

        // Modify file and push again -> creates version snapshot
        std::fs::write(ws_a.join("loose.md"), "# 根目录笔记 v2\n新增第二行").unwrap();
        cloud_vault_push_options_inner(&ws_a, &cloud_root, "", false, true, true, 5).unwrap();

        let versions = list_local_version_snapshots(&ws_a, "loose.md").unwrap();
        assert_eq!(versions.len(), 2);

        // Diff between v1 snapshot and current v2 working copy
        let v1_bytes = read_local_version_snapshots_for_test(&ws_a, "loose.md", &versions[1].id);
        let diff = compute_snapshot_diff(
            &String::from_utf8_lossy(&v1_bytes),
            "# 根目录笔记 v2\n新增第二行",
            &versions[1].id,
        );
        assert!(diff.unified.contains("-# 根目录笔记 v1"));
        assert!(diff.unified.contains("+# 根目录笔记 v2"));

        // Pull into ws_b -> restores original paths (`loose.md` at root, `后端架构/微服务.md` in subfolder)
        let pull_res = cloud_vault_pull_options_inner(&ws_b, &cloud_root, "", false, true, true, 5).unwrap();
        assert_eq!(pull_res.downloaded, 3);
        assert_eq!(
            std::fs::read_to_string(ws_b.join("loose.md")).unwrap(),
            "# 根目录笔记 v2\n新增第二行"
        );
        assert_eq!(
            std::fs::read_to_string(ws_b.join("后端架构/微服务.md")).unwrap(),
            "# 微服务设计 v1"
        );
        // Version snapshots also synced to ws_b!
        let versions_b = list_local_version_snapshots(&ws_b, "loose.md").unwrap();
        assert_eq!(versions_b.len(), 2);
    }

    #[test]
    fn multi_device_concurrent_edits_never_lose_data_or_version_history() {
        let tmp = tempfile::tempdir().unwrap();
        let dev_a = tmp.path().join("dev_a").join("Notes");
        let dev_b = tmp.path().join("dev_b").join("Notes");
        let cloud = tmp.path().join("CloudVault");

        std::fs::create_dir_all(&dev_a).unwrap();
        std::fs::create_dir_all(&dev_b).unwrap();

        // 1. Initial baseline v1 on Device A -> Push to Cloud -> Pull on Device B
        std::fs::write(dev_a.join("shared.md"), "# 共享笔记 v1 (基线)").unwrap();
        std::fs::write(dev_a.join("only_a_updates.md"), "A 文件 v1").unwrap();
        std::fs::write(dev_a.join("only_b_updates.md"), "B 文件 v1").unwrap();
        cloud_vault_push_options_inner(&dev_a, &cloud, "", false, true, true, 10).unwrap();
        cloud_vault_pull_options_inner(&dev_b, &cloud, "", false, true, true, 10).unwrap();

        // 2. Device A updates `only_a_updates.md` -> v2 and `shared.md` -> v2_from_A, then pushes to Cloud
        std::fs::write(dev_a.join("only_a_updates.md"), "A 文件 v2 (设备A已更新)").unwrap();
        std::fs::write(dev_a.join("shared.md"), "# 共享笔记 v2_from_A (设备A修改)").unwrap();
        cloud_vault_push_options_inner(&dev_a, &cloud, "", false, true, true, 10).unwrap();

        // 3. Meanwhile, Device B (without pulling first!):
        //    - did NOT touch `only_a_updates.md` (still v1)
        //    - edited `only_b_updates.md` -> v2 (which A did NOT touch on Cloud!)
        //    - concurrently edited `shared.md` -> v2_from_B!
        std::fs::write(dev_b.join("only_b_updates.md"), "B 文件 v2 (设备B本地未同步修改)").unwrap();
        std::fs::write(dev_b.join("shared.md"), "# 共享笔记 v2_from_B (设备B并发修改)").unwrap();

        // When Device B pulls from Cloud:
        // - `only_a_updates.md` was untouched on B (matches B's base_sha), so it fast-forwards cleanly to v2 without conflict copy.
        // - `only_b_updates.md` was untouched on Cloud (matches B's base_sha), so B's newer local edit is preserved untouched!
        // - `shared.md` was modified on BOTH A and B since base v1 -> creates a side-by-side conflict copy for B's edit
        //   AND records B's edit in `.solomd-sync/versions/` before updating `shared.md` to A's cloud version!
        cloud_vault_pull_options_inner(&dev_b, &cloud, "", false, true, true, 10).unwrap();

        assert_eq!(
            std::fs::read_to_string(dev_b.join("only_a_updates.md")).unwrap(),
            "A 文件 v2 (设备A已更新)"
        );
        assert_eq!(
            std::fs::read_to_string(dev_b.join("only_b_updates.md")).unwrap(),
            "B 文件 v2 (设备B本地未同步修改)"
        );
        assert_eq!(
            std::fs::read_to_string(dev_b.join("shared.md")).unwrap(),
            "# 共享笔记 v2_from_A (设备A修改)"
        );

        // Verify a side-by-side conflict copy file `shared (冲突副本 ...).md` was created on Device B with B's content!
        let conflict_files: Vec<_> = std::fs::read_dir(&dev_b)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("shared (冲突副本 ")
            })
            .collect();
        assert_eq!(conflict_files.len(), 1);
        assert_eq!(
            std::fs::read_to_string(conflict_files[0].path()).unwrap(),
            "# 共享笔记 v2_from_B (设备B并发修改)"
        );

        // Verify `.solomd-sync/versions/` on Device B contains ALL 3 versions (v1, v2_from_A, v2_from_B)
        // with union-merged `index.json`!
        let versions_on_b = list_local_version_snapshots(&dev_b, "shared.md").unwrap();
        assert_eq!(versions_on_b.len(), 3);
    }

    fn read_local_version_snapshots_for_test(ws: &Path, rel: &str, id: &str) -> Vec<u8> {
        read_local_version_snapshot(ws, rel, id).unwrap()
    }

    #[test]
    fn cloudflare_r2_credentials_and_sigv4_signing_work() {
        // 1. Bare Cloudflare Account ID expands to `https://<account_id>.r2.cloudflarestorage.com`
        let creds = R2Credentials::parse(
            r#"{
                "endpoint": "acc1234567890abcdef",
                "bucket": "solomd-notes",
                "access_key_id": "AKIAIOSFODNN7EXAMPLE",
                "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
            }"#,
        )
        .unwrap();
        assert_eq!(creds.endpoint, "https://acc1234567890abcdef.r2.cloudflarestorage.com");
        assert_eq!(creds.host(), "acc1234567890abcdef.r2.cloudflarestorage.com");
        assert_eq!(creds.bucket, "solomd-notes");
        assert_eq!(creds.region, "auto");

        // 2. RFC 4231 Test Case 2 for HMAC-SHA256 ("Jefe", "what do ya want for nothing?")
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let mac_hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            mac_hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );

        // 3. Civil UTC date formatting for AWS SigV4 (2023-05-24T00:00:00Z = 1684886400)
        let (date_stamp, amz_date) = format_amz_date(1_684_886_400);
        assert_eq!(date_stamp, "20230524");
        assert_eq!(amz_date, "20230524T000000Z");

        // 4. SigV4 Authorization header format
        let (auth, _, payload_hash) =
            build_s3_sigv4_headers(&creds, "PUT", "/solomd-notes/Notes/hello.md", b"# Hello R2");
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/"));
        assert!(auth.contains("/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="));
        assert_eq!(payload_hash.len(), 64);
    }

    #[test]
    fn keyless_quick_auth_urls_built_for_all_oauth_providers() {
        for (prov, expected_host) in [
            ("baidu", "openapi.baidu.com"),
            ("alipan", "openapi.alipan.com"),
            ("onedrive", "login.microsoftonline.com"),
            ("dropbox", "www.dropbox.com"),
            ("gdrive", "accounts.google.com"),
        ] {
            let info = cloud_api_build_quick_auth_url(prov.to_string(), None).unwrap();
            assert!(
                info.auth_url.contains(expected_host),
                "provider {prov} url: {}",
                info.auth_url
            );
        }
    }

    #[test]
    fn toggling_encryption_and_deleting_remote_workspace_dir_reuploads_encrypted_files() {
        // RFC 1321 MD5 test vectors for Baidu xpan block_list
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");

        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("MyNotes");
        let cloud_root = tmp.path().join("apps").join("SoloMD");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&cloud_root).unwrap();
        std::fs::write(ws.join("secret.md"), "# 机密笔记\n不可明文外泄").unwrap();

        // 1. Initial sync without encryption -> writes plaintext `笔记文档/secret.md`
        let res_plain = cloud_vault_push_options_inner(&ws, &cloud_root, "", false, true, true, 5).unwrap();
        assert_eq!(res_plain.uploaded, 1);
        let ws_cloud = cloud_root.join("MyNotes");
        assert!(ws_cloud.join("笔记文档/secret.md").is_file());

        // 2. Enable encryption WITHOUT modifying local file -> MUST re-upload as `.md.enc` and remove plaintext `.md`!
        let res_enc = cloud_vault_push_options_inner(&ws, &cloud_root, "my-strong-pass", true, true, true, 5).unwrap();
        assert_eq!(res_enc.uploaded, 1);
        assert!(ws_cloud.join("笔记文档/secret.md.enc").is_file());
        assert!(!ws_cloud.join("笔记文档/secret.md").exists());

        // 3. User deletes the workspace folder on cloud drive (`apps/SoloMD/MyNotes`), keeping `apps/SoloMD`,
        //    and re-syncs with encryption enabled -> MUST recreate folder and upload `.md.enc` cleanly!
        std::fs::remove_dir_all(&ws_cloud).unwrap();
        assert!(cloud_root.is_dir());
        let res_resync = cloud_vault_push_options_inner(&ws, &cloud_root, "my-strong-pass", true, true, true, 5).unwrap();
        assert_eq!(res_resync.uploaded, 1);
        assert!(ws_cloud.join("笔记文档/secret.md.enc").is_file());
        let ct = std::fs::read(ws_cloud.join("笔记文档/secret.md.enc")).unwrap();
        assert_eq!(&ct[..4], b"SLMD");
    }
}
