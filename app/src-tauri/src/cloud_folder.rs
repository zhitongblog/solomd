//! v2.6.1 — Cloud-folder detection + cross-device session restore.
//!
//! Two complementary primitives that together let SoloMD pick up where the
//! user left off across machines, without our v2.6.0 GitHub sync layer:
//!
//! 1. **Cloud-folder detection.** If the workspace path lives inside iCloud
//!    Drive, Dropbox, OneDrive, or Google Drive, the provider already runs
//!    background sync; SoloMD just needs to surface that fact in the UI
//!    ("your workspace is in iCloud — saves propagate automatically") and
//!    avoid showing GitHub-sync nudges that would feel redundant.
//!
//! 2. **Per-device session files.** `<folder>/.solomd/session.<deviceId>.json`
//!    holds open tabs + cursor positions. Each device writes its own; the
//!    cloud provider syncs them like any other file. On launch we check
//!    sibling sessions, and if one is newer than ours and from a different
//!    device, offer to restore from it.
//!
//! Crucially: session files are gitignored alongside `.solomd/sync.json` so
//! they don't end up in the GitHub-backed repo (which would conflict per-pull).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

const DEVICE_ID_FILE: &str = ".solomd-device-id";
const SESSIONS_DIR: &str = ".solomd";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CloudProvider {
    None,
    ICloud,
    Dropbox,
    OneDrive,
    GoogleDrive,
}

#[derive(Serialize, Debug)]
pub struct CloudFolderInfo {
    pub provider: CloudProvider,
    /// Human-readable label for the UI banner: "iCloud Drive", "Dropbox", etc.
    pub label: String,
}

/// Detect whether the given path is inside a known cloud-sync folder. Pure
/// path-string analysis — never opens the filesystem, so it's safe to run
/// on a path that doesn't exist yet.
fn detect_provider(path: &Path) -> CloudFolderInfo {
    let s = path.to_string_lossy().to_lowercase();

    // macOS iCloud Drive lives under
    // `~/Library/Mobile Documents/com~apple~CloudDocs/...`. The user's path
    // string contains this verbatim — symlink resolution is unnecessary
    // because Finder shows the user the canonical path via the "iCloud"
    // sidebar entry but the underlying path is always Mobile Documents.
    if s.contains("/library/mobile documents/")
        || s.contains("\\library\\mobile documents\\")
    {
        return CloudFolderInfo {
            provider: CloudProvider::ICloud,
            label: "iCloud Drive".into(),
        };
    }

    // Dropbox: ~/Dropbox/ on every platform; sometimes ~/Dropbox (Personal),
    // ~/Dropbox (Work) for multi-account installs.
    if s.contains("/dropbox/") || s.contains("/dropbox (")
        || s.contains("\\dropbox\\") || s.contains("\\dropbox (")
    {
        return CloudFolderInfo {
            provider: CloudProvider::Dropbox,
            label: "Dropbox".into(),
        };
    }

    // OneDrive: ~/OneDrive/ on macOS / Linux, %USERPROFILE%\OneDrive\ on
    // Windows. Personal vs. business shows up as "OneDrive - Foo Inc" so
    // we accept the prefix match.
    if s.contains("/onedrive/") || s.contains("/onedrive - ")
        || s.contains("\\onedrive\\") || s.contains("\\onedrive - ")
    {
        return CloudFolderInfo {
            provider: CloudProvider::OneDrive,
            label: "OneDrive".into(),
        };
    }

    // Google Drive (the new Drive for desktop client mounts at
    // ~/Library/CloudStorage/GoogleDrive-... on macOS, G:\My Drive on Win).
    if s.contains("/cloudstorage/googledrive-")
        || s.contains("\\cloudstorage\\googledrive-")
        || s.contains("/google drive/")
        || s.contains("\\google drive\\")
        || s.contains(":\\my drive\\")
    {
        return CloudFolderInfo {
            provider: CloudProvider::GoogleDrive,
            label: "Google Drive".into(),
        };
    }

    CloudFolderInfo {
        provider: CloudProvider::None,
        label: String::new(),
    }
}

#[tauri::command]
pub fn cloud_folder_detect(folder: String) -> CloudFolderInfo {
    detect_provider(Path::new(&folder))
}

// ---------------------------------------------------------------------------
// Device ID — stable across launches, unique per machine.
// ---------------------------------------------------------------------------

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn device_id_path() -> Option<PathBuf> {
    home().map(|h| h.join(DEVICE_ID_FILE))
}

fn random_uuid() -> String {
    // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (UUIDv4).
    use std::time::SystemTime;
    let mut bytes = [0u8; 16];
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    for (i, b) in bytes.iter_mut().enumerate() {
        // xorshift mixing — good enough for an opaque device ID, and avoids
        // adding the `uuid` / `rand` crates just for this one call.
        let v = (nanos.wrapping_mul(0x9E3779B97F4A7C15)
            ^ (nanos >> 32))
            >> ((i * 5) % 32);
        *b = (v ^ std::process::id() as u128 ^ i as u128) as u8;
    }
    bytes[6] = (bytes[6] & 0x0F) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3F) | 0x80; // variant 1
    let h = |b: &[u8]| {
        b.iter()
            .map(|x| format!("{:02x}", x))
            .collect::<String>()
    };
    format!(
        "{}-{}-{}-{}-{}",
        h(&bytes[0..4]),
        h(&bytes[4..6]),
        h(&bytes[6..8]),
        h(&bytes[8..10]),
        h(&bytes[10..16]),
    )
}

#[tauri::command]
pub fn device_id_get_or_create() -> Result<String, String> {
    let path = device_id_path().ok_or("no HOME directory")?;
    if let Ok(existing) = fs::read_to_string(&path) {
        let id = existing.trim().to_string();
        if !id.is_empty() {
            return Ok(id);
        }
    }
    let id = random_uuid();
    fs::write(&path, &id).map_err(|e| e.to_string())?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// Session files — per workspace × per device.
// ---------------------------------------------------------------------------

fn sessions_dir(workspace: &Path) -> PathBuf {
    workspace.join(SESSIONS_DIR)
}

fn session_path(workspace: &Path, device_id: &str) -> PathBuf {
    sessions_dir(workspace).join(format!("session.{}.json", device_id))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SessionTab {
    pub file_path: Option<String>,
    pub file_name: String,
    /// Cursor line (1-based) — optional because not every tab has been
    /// focused yet.
    pub cursor_line: Option<u32>,
    pub cursor_col: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SessionPayload {
    pub device_id: String,
    /// Hostname / Settings → device label, surfaced in the restore prompt.
    pub device_label: String,
    /// Unix epoch seconds — used to pick the freshest sibling session.
    pub saved_at: i64,
    pub active_index: usize,
    pub tabs: Vec<SessionTab>,
}

#[derive(Serialize)]
pub struct SiblingSession {
    pub device_id: String,
    pub device_label: String,
    pub saved_at: i64,
    pub tab_count: usize,
}

#[tauri::command]
pub fn session_save(folder: String, payload: SessionPayload) -> Result<(), String> {
    let path = sessions_dir(Path::new(&folder));
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let target = session_path(Path::new(&folder), &payload.device_id);
    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&target, body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_load(folder: String, device_id: String) -> Result<Option<SessionPayload>, String> {
    let target = session_path(Path::new(&folder), &device_id);
    if !target.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string())
}

/// List every device that has saved a session into this workspace, *except*
/// our own. Caller filters / sorts by `saved_at`.
#[tauri::command]
pub fn session_list_others(folder: String, our_device_id: String) -> Result<Vec<SiblingSession>, String> {
    let dir = sessions_dir(Path::new(&folder));
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let id = match name
            .strip_prefix("session.")
            .and_then(|rest| rest.strip_suffix(".json"))
        {
            Some(id) if id != our_device_id => id.to_string(),
            _ => continue,
        };
        let body = match fs::read_to_string(entry.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let session: SessionPayload = match serde_json::from_str(&body) {
            Ok(s) => s,
            Err(_) => continue,
        };
        out.push(SiblingSession {
            device_id: id,
            device_label: session.device_label,
            saved_at: session.saved_at,
            tab_count: session.tabs.len(),
        });
    }
    out.sort_by_key(|s| -s.saved_at);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icloud_path_detected() {
        let p = "/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Notes";
        assert_eq!(detect_provider(Path::new(p)).provider, CloudProvider::ICloud);
    }

    #[test]
    fn dropbox_path_detected() {
        let p = "/Users/alex/Dropbox/Notes";
        assert_eq!(detect_provider(Path::new(p)).provider, CloudProvider::Dropbox);
        let p2 = "/Users/alex/Dropbox (Personal)/Notes";
        assert_eq!(detect_provider(Path::new(p2)).provider, CloudProvider::Dropbox);
    }

    #[test]
    fn onedrive_path_detected() {
        let p = "/Users/alex/OneDrive/Notes";
        assert_eq!(detect_provider(Path::new(p)).provider, CloudProvider::OneDrive);
        let p2 = "/Users/alex/OneDrive - Acme Inc/Notes";
        assert_eq!(detect_provider(Path::new(p2)).provider, CloudProvider::OneDrive);
    }

    #[test]
    fn google_drive_path_detected() {
        let p = "/Users/alex/Library/CloudStorage/GoogleDrive-me@gmail.com/My Drive/Notes";
        assert_eq!(detect_provider(Path::new(p)).provider, CloudProvider::GoogleDrive);
    }

    #[test]
    fn plain_path_is_none() {
        let p = "/Users/alex/Documents/Notes";
        assert_eq!(detect_provider(Path::new(p)).provider, CloudProvider::None);
    }

    #[test]
    fn random_uuid_format() {
        let id = random_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(id.chars().nth(14), Some('4')); // version
        assert_eq!(id.chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn session_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "solomd-session-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let payload = SessionPayload {
            device_id: "dev-A".into(),
            device_label: "Mac mini".into(),
            saved_at: 1700000000,
            active_index: 0,
            tabs: vec![SessionTab {
                file_path: Some("notes/foo.md".into()),
                file_name: "foo.md".into(),
                cursor_line: Some(12),
                cursor_col: Some(3),
            }],
        };
        session_save(dir.to_string_lossy().into_owned(), payload).unwrap();

        let loaded = session_load(dir.to_string_lossy().into_owned(), "dev-A".into())
            .unwrap()
            .unwrap();
        assert_eq!(loaded.device_label, "Mac mini");
        assert_eq!(loaded.tabs.len(), 1);

        let others = session_list_others(
            dir.to_string_lossy().into_owned(),
            "dev-A".into(),
        )
        .unwrap();
        assert!(others.is_empty(), "should exclude our own device");

        // Add a sibling.
        let sibling = SessionPayload {
            device_id: "dev-B".into(),
            device_label: "iPad".into(),
            saved_at: 1700000500,
            active_index: 0,
            tabs: vec![],
        };
        session_save(dir.to_string_lossy().into_owned(), sibling).unwrap();
        let others = session_list_others(
            dir.to_string_lossy().into_owned(),
            "dev-A".into(),
        )
        .unwrap();
        assert_eq!(others.len(), 1);
        assert_eq!(others[0].device_id, "dev-B");
    }
}
