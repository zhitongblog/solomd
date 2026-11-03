//! #458 — WebDAV workspace sync (坚果云 Nutstore, Nextcloud, ownCloud, AList /
//! OpenList, Synology WebDAV, etc.).
//!
//! Uses pure HTTP/WebDAV (`PROPFIND`, `MKCOL`, `GET`, `PUT`) over `reqwest`
//! with Basic Auth so it works across macOS, Windows, Linux, iOS, and Android
//! without needing `libgit2`.

use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebdavSyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub message: String,
}

const VAULT_MANIFEST_NAME: &str = "solomd-vault.json";
const VAULT_PROBE_AAD: &str = "encryption.probe";
const VAULT_PROBE_PLAIN: &[u8] = b"SoloMD probe v1";

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
    workspace: String,
    url: String,
    username: String,
    password: String,
    remote_path: String,
    encrypted: Option<bool>,
    passphrase: Option<String>,
) -> Result<WebdavSyncResult, String> {
    let ws_path = PathBuf::from(workspace.trim());
    if !ws_path.is_dir() {
        return Err("Open a workspace folder before syncing".into());
    }
    if url.trim().is_empty() {
        return Err("Configure WebDAV server URL in Settings › Sync first".into());
    }

    let use_encryption = encrypted.unwrap_or(false);
    let pass_str = passphrase.unwrap_or_default();

    let mut files = Vec::new();
    collect_local_files(&ws_path, &ws_path, &mut files);

    let client = build_client()?;
    let mut created_dirs = HashSet::new();
    ensure_remote_dir(
        &client,
        &url,
        &remote_path,
        "",
        username.trim(),
        password.as_str(),
        &mut created_dirs,
    )
    .await?;

    let enc_key: Option<[u8; 32]> = if use_encryption {
        let manifest_url = build_target_url(&url, &remote_path, VAULT_MANIFEST_NAME);
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

    let mut uploaded = 0usize;
    for (rel, full_path) in files {
        if let Some((parent, _)) = rel.rsplit_once('/') {
            ensure_remote_dir(
                &client,
                &url,
                &remote_path,
                parent,
                username.trim(),
                password.as_str(),
                &mut created_dirs,
            )
            .await?;
        }
        let plain_bytes = std::fs::read(&full_path)
            .map_err(|e| format!("Failed to read {rel}: {e}"))?;
        let (remote_rel, upload_bytes) = if let Some(ref key) = enc_key {
            let cipher = super::crypto::encrypt_bytes(key, &rel, &plain_bytes)?;
            (format!("{rel}.enc"), cipher)
        } else {
            (rel.clone(), plain_bytes)
        };
        let file_url = build_target_url(&url, &remote_path, &remote_rel);
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
        uploaded += 1;
    }

    let msg = if use_encryption {
        format!("已端到端加密上传 {uploaded} 个文件到 WebDAV (Encrypted & uploaded {uploaded} files)")
    } else {
        format!("Uploaded {uploaded} files to WebDAV")
    };

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: msg,
    })
}

#[tauri::command]
pub async fn webdav_pull_workspace(
    workspace: String,
    url: String,
    username: String,
    password: String,
    remote_path: String,
    encrypted: Option<bool>,
    passphrase: Option<String>,
) -> Result<WebdavSyncResult, String> {
    let ws_path = PathBuf::from(workspace.trim());
    if !ws_path.is_dir() {
        return Err("Open a workspace folder before syncing".into());
    }
    if url.trim().is_empty() {
        return Err("Configure WebDAV server URL in Settings › Sync first".into());
    }

    let client = build_client()?;
    let pass_str = passphrase.unwrap_or_default();

    // Check if the remote folder has a `solomd-vault.json` encrypted manifest.
    let manifest_url = build_target_url(&url, &remote_path, VAULT_MANIFEST_NAME);
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

    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;

    // Breadth-first `Depth: 1` traversal (works on all WebDAV servers including
    // 坚果云 Nutstore and Nextcloud, which reject `Depth: infinity`).
    let mut queue: Vec<String> = vec![String::new()];
    let mut visited_dirs: HashSet<String> = HashSet::new();
    let mut downloaded = 0usize;

    while let Some(rel_dir) = queue.pop() {
        if !visited_dirs.insert(rel_dir.clone()) {
            continue;
        }
        let dir_url = build_target_url(&url, &remote_path, &rel_dir);
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
            // The first entry in Depth:1 response is typically the directory itself.
            let decoded = percent_decode(&href);
            let trimmed_href = decoded.trim_end_matches('/');
            let Some(leaf) = trimmed_href.rsplit('/').next() else {
                continue;
            };
            if leaf.is_empty() || leaf.starts_with('.') || leaf == VAULT_MANIFEST_NAME {
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
            } else if let Some(plain_rel) = child_rel.strip_suffix(".enc") {
                let Some(ref key) = enc_key else {
                    continue;
                };
                let local_target = ws_path.join(plain_rel);
                if !should_sync_file(&local_target) {
                    continue;
                }
                let file_url = build_target_url(&url, &remote_path, &child_rel);
                let get_resp = client
                    .get(&file_url)
                    .basic_auth(username.trim(), Some(password.as_str()))
                    .send()
                    .await
                    .map_err(|e| format!("Failed to download {child_rel}: {e}"))?;
                if get_resp.status().is_success() {
                    let cipher_bytes = get_resp
                        .bytes()
                        .await
                        .map_err(|e| format!("Read error for {child_rel}: {e}"))?;
                    let plain_bytes = super::crypto::decrypt_bytes(key, plain_rel, &cipher_bytes)?;
                    if let Some(parent) = local_target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    std::fs::write(&local_target, &plain_bytes)
                        .map_err(|e| format!("Write error for {plain_rel}: {e}"))?;
                    downloaded += 1;
                }
            } else {
                let local_target = ws_path.join(&child_rel);
                if !should_sync_file(&local_target) {
                    continue;
                }
                let file_url = build_target_url(&url, &remote_path, &child_rel);
                let get_resp = client
                    .get(&file_url)
                    .basic_auth(username.trim(), Some(password.as_str()))
                    .send()
                    .await
                    .map_err(|e| format!("Failed to download {child_rel}: {e}"))?;
                if get_resp.status().is_success() {
                    if let Some(parent) = local_target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let bytes = get_resp
                        .bytes()
                        .await
                        .map_err(|e| format!("Read error for {child_rel}: {e}"))?;
                    std::fs::write(&local_target, &bytes)
                        .map_err(|e| format!("Write error for {child_rel}: {e}"))?;
                    downloaded += 1;
                }
            }
        }
    }

    let msg = if enc_key.is_some() {
        format!("已从 WebDAV 下载并解密 {downloaded} 个文件 (Downloaded & decrypted {downloaded} files)")
    } else {
        format!("Downloaded {downloaded} files from WebDAV")
    };

    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: msg,
    })
}

pub fn cloud_vault_push_inner(
    workspace: &Path,
    vault_dir: &Path,
    passphrase: &str,
) -> Result<WebdavSyncResult, String> {
    if !workspace.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    if vault_dir.as_os_str().is_empty() {
        return Err("请先选择个人网盘加密备份目录 (Select a cloud drive vault folder first)".into());
    }
    if workspace == vault_dir || vault_dir.starts_with(workspace) {
        return Err("加密备份目录不能与当前笔记目录相同或位于其内部 (Vault folder must be outside workspace)".into());
    }
    std::fs::create_dir_all(vault_dir)
        .map_err(|e| format!("无法创建网盘加密目录: {e}"))?;

    let manifest_path = vault_dir.join(VAULT_MANIFEST_NAME);
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

    let mut files = Vec::new();
    collect_local_files(workspace, workspace, &mut files);

    let mut uploaded = 0usize;
    for (rel, full_path) in files {
        let plain_bytes = std::fs::read(&full_path)
            .map_err(|e| format!("读取 {rel} 失败: {e}"))?;
        let cipher_bytes = super::crypto::encrypt_bytes(&key, &rel, &plain_bytes)?;
        let enc_target = vault_dir.join(format!("{rel}.enc"));
        if let Some(parent) = enc_target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {e}"))?;
        }
        // Convergent encryption: skip disk write if ciphertext is identical so
        // the cloud drive client doesn't re-upload unchanged files.
        let unchanged = enc_target.exists()
            && std::fs::read(&enc_target)
                .map(|existing| existing == cipher_bytes)
                .unwrap_or(false);
        if !unchanged {
            std::fs::write(&enc_target, &cipher_bytes)
                .map_err(|e| format!("写入加密文件 {rel}.enc 失败: {e}"))?;
        }
        uploaded += 1;
    }

    Ok(WebdavSyncResult {
        uploaded,
        downloaded: 0,
        message: format!(
            "已端到端加密备份 {uploaded} 个文件到网盘目录 (Encrypted {uploaded} files to cloud drive folder)"
        ),
    })
}

fn collect_encrypted_vault_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
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
            collect_encrypted_vault_files(root, &path, out);
        } else if path.is_file() && name.ends_with(".enc") && !name.starts_with('.') {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                if let Some(plain_rel) = rel_str.strip_suffix(".enc") {
                    if !plain_rel.is_empty() {
                        out.push((plain_rel.to_string(), path));
                    }
                }
            }
        }
    }
}

pub fn cloud_vault_pull_inner(
    workspace: &Path,
    vault_dir: &Path,
    passphrase: &str,
) -> Result<WebdavSyncResult, String> {
    if !workspace.is_dir() {
        return Err("请先打开一个笔记文件夹 (Open a workspace folder first)".into());
    }
    if !vault_dir.is_dir() {
        return Err("网盘加密目录不存在 (Cloud drive vault folder does not exist)".into());
    }
    let manifest_path = vault_dir.join(VAULT_MANIFEST_NAME);
    if !manifest_path.exists() {
        return Err("该网盘目录中未找到加密库元数据 solomd-vault.json，请先执行一次加密备份".into());
    }
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取 solomd-vault.json 失败: {e}"))?;
    let manifest: CloudVaultManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("解析 solomd-vault.json 失败: {e}"))?;
    let key = unlock_vault_manifest(&manifest, passphrase)?;

    let mut enc_files = Vec::new();
    collect_encrypted_vault_files(vault_dir, vault_dir, &mut enc_files);

    let mut downloaded = 0usize;
    for (plain_rel, enc_path) in enc_files {
        let local_target = workspace.join(&plain_rel);
        if !should_sync_file(&local_target) {
            continue;
        }
        let cipher_bytes = std::fs::read(&enc_path)
            .map_err(|e| format!("读取密文 {plain_rel}.enc 失败: {e}"))?;
        let plain_bytes = super::crypto::decrypt_bytes(&key, &plain_rel, &cipher_bytes)?;
        if let Some(parent) = local_target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建本地目录失败: {e}"))?;
        }
        let unchanged = local_target.exists()
            && std::fs::read(&local_target)
                .map(|existing| existing == plain_bytes)
                .unwrap_or(false);
        if !unchanged {
            std::fs::write(&local_target, &plain_bytes)
                .map_err(|e| format!("写入解密文件 {plain_rel} 失败: {e}"))?;
        }
        downloaded += 1;
    }

    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded,
        message: format!(
            "已从网盘目录解密还原 {downloaded} 个文件 (Decrypted & synced {downloaded} files from cloud drive)"
        ),
    })
}

/// Encrypt all notes & attachments in `workspace` with XChaCha20-Poly1305
/// (Argon2id key derivation) and write them into a local personal cloud drive
/// sync directory (`vault_dir`, e.g. 百度网盘 / 阿里云盘 / 夸克网盘 / 坚果云 / OneDrive / iCloud).
#[tauri::command]
pub async fn cloud_vault_push_workspace(
    workspace: String,
    vault_dir: String,
    passphrase: String,
) -> Result<WebdavSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cloud_vault_push_inner(
            Path::new(workspace.trim()),
            Path::new(vault_dir.trim()),
            &passphrase,
        )
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Decrypt and sync notes & attachments from a local personal cloud drive
/// encrypted directory (`vault_dir`) back into `workspace`.
#[tauri::command]
pub async fn cloud_vault_pull_workspace(
    workspace: String,
    vault_dir: String,
    passphrase: String,
) -> Result<WebdavSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cloud_vault_pull_inner(
            Path::new(workspace.trim()),
            Path::new(vault_dir.trim()),
            &passphrase,
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
    let cid = client_id.trim();
    if cid.is_empty() {
        return Err("请先填写开放平台 AppKey / Client ID，或直接在下方粘贴 Access Token".into());
    }
    let client = build_client()?;
    match provider.trim().to_ascii_lowercase().as_str() {
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
        other => Err(format!(
            "当前网盘 ({other}) 请直接粘贴开放平台 Access Token"
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
    match provider.trim().to_ascii_lowercase().as_str() {
        "baidu" => {
            let url = format!(
                "https://openapi.baidu.com/oauth/2.0/token?grant_type=device_token&code={}&client_id={}&client_secret={}",
                percent_encode_segment(device_code.trim()),
                percent_encode_segment(client_id.trim()),
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
                    ("client_id", client_id.trim()),
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
    let url = format!(
        "https://d.pcs.baidu.com/rest/2.0/pcs/file?method=upload&access_token={}&path={}&ondup=overwrite",
        percent_encode_segment(token),
        percent_encode_segment(&full_path)
    );
    let part = reqwest::multipart::Part::bytes(bundle).file_name(BUNDLE_FILENAME);
    let form = reqwest::multipart::Form::new().part("file", part);
    let resp = client
        .post(&url)
        .header("User-Agent", "pan.baidu.com")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("百度网盘上传请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() || text.contains("\"error_code\"") {
        return Err(format!("百度网盘上传失败 (HTTP {status}): {text}"));
    }
    Ok(())
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

#[tauri::command]
pub async fn cloud_api_push_workspace(
    workspace: String,
    provider: String,
    access_token: String,
    remote_path: String,
    passphrase: String,
) -> Result<WebdavSyncResult, String> {
    let token = access_token.trim().to_string();
    if token.is_empty() {
        return Err("请先授权或填入网盘 Access Token".into());
    }
    let ws = PathBuf::from(workspace.trim());
    let pass = passphrase.clone();
    let (bundle, count) =
        tauri::async_runtime::spawn_blocking(move || pack_encrypted_vault_bundle(&ws, &pass))
            .await
            .map_err(|e| format!("join: {e}"))??;

    let client = build_client()?;
    let prov = provider.trim().to_ascii_lowercase();
    match prov.as_str() {
        "baidu" => baidu_upload_bundle(&client, &token, &remote_path, bundle).await?,
        "alipan" => alipan_upload_bundle(&client, &token, &remote_path, bundle).await?,
        "onedrive" => onedrive_upload_bundle(&client, &token, &remote_path, bundle).await?,
        "dropbox" => dropbox_upload_bundle(&client, &token, &remote_path, bundle).await?,
        other => return Err(format!("不支持的网盘开放平台类型: {other}")),
    }

    Ok(WebdavSyncResult {
        uploaded: count,
        downloaded: 0,
        message: format!(
            "已将 {count} 个文件打包并端到端加密上传到 {} ({BUNDLE_FILENAME})",
            match prov.as_str() {
                "baidu" => "百度网盘",
                "alipan" => "阿里云盘",
                "onedrive" => "OneDrive",
                "dropbox" => "Dropbox",
                _ => &prov,
            }
        ),
    })
}

#[tauri::command]
pub async fn cloud_api_pull_workspace(
    workspace: String,
    provider: String,
    access_token: String,
    remote_path: String,
    passphrase: String,
) -> Result<WebdavSyncResult, String> {
    let token = access_token.trim().to_string();
    if token.is_empty() {
        return Err("请先授权或填入网盘 Access Token".into());
    }
    let client = build_client()?;
    let prov = provider.trim().to_ascii_lowercase();
    let bundle = match prov.as_str() {
        "baidu" => baidu_download_bundle(&client, &token, &remote_path).await?,
        "alipan" => alipan_download_bundle(&client, &token, &remote_path).await?,
        "onedrive" => onedrive_download_bundle(&client, &token, &remote_path).await?,
        "dropbox" => dropbox_download_bundle(&client, &token, &remote_path).await?,
        other => return Err(format!("不支持的网盘开放平台类型: {other}")),
    };

    let ws = PathBuf::from(workspace.trim());
    let pass = passphrase.clone();
    let extracted = tauri::async_runtime::spawn_blocking(move || {
        unpack_encrypted_vault_bundle(&ws, &bundle, &pass)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    Ok(WebdavSyncResult {
        uploaded: 0,
        downloaded: extracted,
        message: format!(
            "已从 {} 下载加密包并解密还原 {extracted} 个文件",
            match prov.as_str() {
                "baidu" => "百度网盘",
                "alipan" => "阿里云盘",
                "onedrive" => "OneDrive",
                "dropbox" => "Dropbox",
                _ => &prov,
            }
        ),
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
}
