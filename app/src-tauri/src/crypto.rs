//! v2.6.3 — workspace-level end-to-end encryption.
//!
//! Threat model: files at rest on the linked git remote (GitHub / GitLab /
//! Gitea) are encrypted; an adversary with read access to the remote
//! cannot recover plaintext without the user's passphrase. The local
//! working tree stays plaintext (so search / RAG / wikilinks / AI rewrite
//! continue to work).
//!
//! Architecture: the workspace owns a `.solomd-encrypted/` shadow
//! directory whose contents mirror the workspace structure but with
//! every text file encrypted via XChaCha20-Poly1305. The shadow dir is
//! the actual git repo; push / pull operate on it. Before push we
//! re-encrypt the workspace into the shadow; after pull we decrypt the
//! shadow back to the workspace.
//!
//! Key derivation: Argon2id (default params: 19MB / 2 iter / 1 lane) over
//! the passphrase + a per-vault 16-byte salt stored in
//! `.solomd/encryption.json`. The derived 32-byte key lives in the OS
//! keychain (`solomd-encryption-key`); the passphrase itself is never
//! persisted.
//!
//! Per-file format: ciphertext begins with a 4-byte magic ("SLMD"), 1-byte
//! version, 24-byte XChaCha20 nonce, then ciphertext + 16-byte
//! Poly1305 tag. AAD = relative path bytes, so a file moved in the
//! ciphertext directory cannot be silently substituted for another file.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use once_cell::sync::Lazy;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// v3.0 — process-local cache of derived encryption keys, keyed by
/// workspace path. Encrypt-for-push runs on every save (5s debounce);
/// without this every push would trigger a macOS keychain prompt for
/// the encryption key. Cleared on `clear_passphrase`; primed on a
/// successful `set_passphrase`.
static KEY_CACHE: Lazy<Mutex<HashMap<String, [u8; 32]>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Service name used for the OS keychain entry storing the derived key,
/// keyed per workspace path so users can have different keys per vault.
const KEYRING_SERVICE: &str = "solomd-encryption-key";
const ENCRYPTION_CONFIG_FILE: &str = ".solomd/encryption.json";
const SHADOW_DIR: &str = ".solomd-encrypted";
/// File committed inside the shadow holding the salt + KDF params, so a
/// second device that pulls the encrypted repo can derive the same key
/// from the user's passphrase. Salt is non-secret per Argon2id RFC9106.
const SHADOW_SALT_FILE: &str = ".solomd-vault.json";
const FILE_MAGIC: &[u8; 4] = b"SLMD";
const FILE_VERSION: u8 = 1;

/// Per-vault encryption metadata. Lives in the workspace, *gitignored*
/// (otherwise the salt + KDF params would leak via the encrypted repo,
/// which weakens nothing but makes the system harder to reason about).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EncryptionConfig {
    /// Hex-encoded 16-byte salt — the stable input alongside the user's
    /// passphrase to derive the same key on every device.
    pub salt: String,
    /// Argon2id parameters — captured so a future SoloMD with bumped
    /// defaults can still decrypt old vaults.
    pub kdf: KdfParams,
    /// File extensions that should be encrypted. Defaults: `md txt`.
    /// Binary files (images, PDFs) stay untouched in the shadow dir.
    pub encrypt_extensions: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KdfParams {
    pub mem_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            mem_kib: 19_456, // ~19 MB — Argon2id RFC9106 default
            iterations: 2,
            parallelism: 1,
        }
    }
}

fn config_path(workspace: &Path) -> PathBuf {
    workspace.join(ENCRYPTION_CONFIG_FILE)
}

fn shadow_path(workspace: &Path) -> PathBuf {
    workspace.join(SHADOW_DIR)
}

fn shadow_salt_path(workspace: &Path) -> PathBuf {
    shadow_path(workspace).join(SHADOW_SALT_FILE)
}

/// Read a salt + KDF params from the shadow if a sibling device has
/// already initialised the vault and pushed. None means this device is
/// the first one to encrypt this vault.
fn load_shadow_salt(workspace: &Path) -> Result<Option<(Vec<u8>, KdfParams)>, String> {
    let p = shadow_salt_path(workspace);
    if !p.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    #[derive(Deserialize)]
    struct Wire {
        salt: String,
        kdf: KdfParams,
    }
    let w: Wire = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some((hex_decode(&w.salt)?, w.kdf)))
}

fn save_shadow_salt(workspace: &Path, salt_hex: &str, kdf: &KdfParams) -> Result<(), String> {
    let dir = shadow_path(workspace);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "salt": salt_hex, "kdf": kdf });
    fs::write(
        shadow_salt_path(workspace),
        serde_json::to_string_pretty(&body).unwrap(),
    )
    .map_err(|e| e.to_string())
}

fn keyring_user_for(workspace: &Path) -> String {
    workspace.to_string_lossy().to_string()
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

#[cfg(test)]
fn _ensure_rng_used() {
    // Keep RngCore as an active dep — the salt generation path uses it.
    let _ = random_bytes(1);
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("hex string has odd length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn load_config(workspace: &Path) -> Result<Option<EncryptionConfig>, String> {
    let path = config_path(workspace);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string())
}

fn save_config(workspace: &Path, cfg: &EncryptionConfig) -> Result<(), String> {
    let path = config_path(workspace);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, body).map_err(|e| e.to_string())
}

fn derive_key(passphrase: &str, salt: &[u8], params: &KdfParams) -> Result<[u8; 32], String> {
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(params.mem_kib, params.iterations, params.parallelism, Some(32))
            .map_err(|e| e.to_string())?,
    );
    let mut out = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn read_key_from_keyring(workspace: &Path) -> Result<Option<[u8; 32]>, String> {
    let cache_key = workspace.to_string_lossy().to_string();
    if let Ok(guard) = KEY_CACHE.lock() {
        if let Some(k) = guard.get(&cache_key) {
            return Ok(Some(*k));
        }
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for(workspace))
        .map_err(|e| e.to_string())?;
    let key = match entry.get_password() {
        Ok(hex) => {
            let bytes = hex_decode(&hex)?;
            if bytes.len() != 32 {
                return Err("stored key is not 32 bytes".into());
            }
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            Some(out)
        }
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(e.to_string()),
    };
    if let (Ok(mut guard), Some(k)) = (KEY_CACHE.lock(), key.as_ref()) {
        guard.insert(cache_key, *k);
    }
    Ok(key)
}

fn write_key_to_keyring(workspace: &Path, key: &[u8; 32]) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for(workspace))
        .map_err(|e| e.to_string())?;
    entry
        .set_password(&hex_encode(key))
        .map_err(|e| e.to_string())?;
    // Prime the in-process cache so the very next encrypt/decrypt call
    // doesn't trigger another keychain prompt right after passphrase
    // was just set.
    if let Ok(mut guard) = KEY_CACHE.lock() {
        guard.insert(workspace.to_string_lossy().to_string(), *key);
    }
    Ok(())
}

fn delete_key_from_keyring(workspace: &Path) -> Result<(), String> {
    if let Ok(mut guard) = KEY_CACHE.lock() {
        guard.remove(&workspace.to_string_lossy().to_string());
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for(workspace))
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt one file
// ---------------------------------------------------------------------------

/// Encrypt `plaintext` for a file at relative path `aad_path`. The path is
/// authenticated as AAD so swapping `secret-2026.md` ciphertext into
/// `boring-meeting.md.enc` would fail verification at decrypt time.
///
/// Nonce derivation is **deterministic**: SHA-256(key ‖ plaintext ‖
/// aad_path), truncated to 24 bytes. This is convergent encryption — the
/// same plaintext at the same path under the same key produces the same
/// ciphertext, so re-encrypting an unchanged file produces zero git
/// diff (a precondition for clean push/pull semantics across devices).
/// The trade-off: an attacker with read access to the remote can detect
/// that two files have identical plaintext. For a single-user vault
/// this is acceptable; cross-vault leakage is impossible because the
/// nonce is keyed.
pub fn encrypt_bytes(key: &[u8; 32], aad_path: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(b"\x00solomd-nonce-v1\x00");
    hasher.update(aad_path.as_bytes());
    hasher.update(b"\x00");
    hasher.update(plaintext);
    let digest = hasher.finalize();
    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&digest[..24]);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad_path.as_bytes(),
            },
        )
        .map_err(|e| format!("encrypt: {}", e))?;
    let mut out = Vec::with_capacity(4 + 1 + 24 + ct.len());
    out.extend_from_slice(FILE_MAGIC);
    out.push(FILE_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt_bytes(key: &[u8; 32], aad_path: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < 4 + 1 + 24 + 16 {
        return Err("ciphertext too short".into());
    }
    if &blob[..4] != FILE_MAGIC {
        return Err("bad magic — not a SoloMD ciphertext".into());
    }
    if blob[4] != FILE_VERSION {
        return Err(format!("unsupported ciphertext version {}", blob[4]));
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(&blob[5..29]);
    let ct = &blob[29..];
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ct,
                aad: aad_path.as_bytes(),
            },
        )
        .map_err(|e| format!("decrypt (wrong passphrase?): {}", e))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
pub struct CryptoStatus {
    pub enabled: bool,
    pub has_key: bool,
}

/// Marker file flagging "encryption key is in the keychain". Not secret —
/// just a flag. Same reason as github_sync's marker: `read_key_from_keyring`
/// triggers a macOS password prompt on every read, and we'd hit it just
/// by opening Settings.
fn key_marker_path(workspace: &Path) -> PathBuf {
    workspace.join(".solomd/encryption.key-set")
}

#[tauri::command]
pub fn crypto_status(folder: String) -> Result<CryptoStatus, String> {
    let path = PathBuf::from(&folder);
    let enabled = config_path(&path).exists();
    // Marker-file check — no keychain access. The actual key is still
    // read from the keychain only at encrypt / decrypt time.
    let has_key = key_marker_path(&path).exists();
    Ok(CryptoStatus { enabled, has_key })
}

/// Initialize encryption for a workspace. Generates a fresh salt, derives
/// a key from the passphrase, stores both the salt-bearing config and
/// the key. Idempotent — re-running with the SAME passphrase succeeds
/// without rotating the salt; a DIFFERENT passphrase fails (we never
/// silently rotate).
#[tauri::command]
pub fn crypto_set_passphrase(folder: String, passphrase: String) -> Result<(), String> {
    if passphrase.is_empty() {
        return Err("passphrase cannot be empty".into());
    }
    let path = PathBuf::from(&folder);

    // Source of truth for the salt is the shadow, so a second device that
    // has already pulled gets the same key from the same passphrase.
    // Fall back to the workspace metadata for backwards compat with the
    // first-device case where the shadow doesn't exist yet.
    let synced = load_shadow_salt(&path)?;
    let local = load_config(&path)?;
    let (salt, kdf, fresh) = if let Some((s, k)) = synced {
        (s, k, false)
    } else if let Some(existing) = local.as_ref() {
        (hex_decode(&existing.salt)?, existing.kdf.clone(), false)
    } else {
        (random_bytes(16), KdfParams::default(), true)
    };

    let key = derive_key(&passphrase, &salt, &kdf)?;

    // Verify against an existing key by attempting to decrypt a probe
    // blob. The probe lives in `.solomd/encryption.probe.enc`; if it
    // round-trips we accept the passphrase, otherwise we refuse rather
    // than silently overwrite the keyring with a wrong key.
    let probe_path = path.join(".solomd/encryption.probe.enc");
    if probe_path.exists() {
        let blob = fs::read(&probe_path).map_err(|e| e.to_string())?;
        decrypt_bytes(&key, "encryption.probe", &blob)
            .map_err(|_| "passphrase does not match this vault".to_string())?;
    }

    let cfg = EncryptionConfig {
        salt: hex_encode(&salt),
        kdf: kdf.clone(),
        encrypt_extensions: local
            .map(|c| c.encrypt_extensions)
            .unwrap_or_else(|| vec!["md".into(), "txt".into(), "markdown".into()]),
    };
    save_config(&path, &cfg)?;
    save_shadow_salt(&path, &cfg.salt, &kdf)?;
    write_key_to_keyring(&path, &key)?;
    // Drop the marker so crypto_status can answer "key is set?" without
    // re-reading the keychain (= without re-prompting on macOS).
    let _ = fs::write(key_marker_path(&path), b"1");

    if fresh {
        let probe = encrypt_bytes(&key, "encryption.probe", b"SoloMD probe v1")?;
        fs::write(path.join(".solomd/encryption.probe.enc"), probe)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn crypto_clear_passphrase(folder: String) -> Result<(), String> {
    let path = PathBuf::from(&folder);
    let _ = fs::remove_file(key_marker_path(&path));
    delete_key_from_keyring(&path)
}

/// Walk the workspace, encrypt every file whose extension is in the
/// vault's `encrypt_extensions` list, and write to `<workspace>/.solomd-encrypted/`.
/// Files with other extensions are mirrored as-is so binary attachments
/// (images, PDFs) keep working through the cloud.
///
/// Returns the absolute path to the shadow dir so the caller can `git push`
/// from there.
#[tauri::command]
pub async fn crypto_encrypt_for_push(folder: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crypto_encrypt_for_push_inner(folder))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn crypto_encrypt_for_push_inner(folder: String) -> Result<String, String> {
    let path = PathBuf::from(&folder);
    let cfg = load_config(&path)?
        .ok_or_else(|| "encryption is not enabled for this workspace".to_string())?;
    let key = read_key_from_keyring(&path)?
        .ok_or_else(|| "encryption key missing — set passphrase again".to_string())?;
    let shadow = shadow_path(&path);
    fs::create_dir_all(&shadow).map_err(|e| e.to_string())?;

    let exts: Vec<String> = cfg.encrypt_extensions.iter().map(|s| s.to_lowercase()).collect();

    for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.starts_with(&shadow) {
            continue; // never re-encrypt the shadow
        }
        if p.starts_with(path.join(".solomd")) {
            continue; // metadata stays out of the shadow
        }
        if p.starts_with(path.join(".git")) {
            continue;
        }
        let rel = match p.strip_prefix(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let target = shadow.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if exts.contains(&ext) {
            let plaintext = fs::read(p).map_err(|e| e.to_string())?;
            let aad = rel.to_string_lossy().to_string();
            let blob = encrypt_bytes(&key, &aad, &plaintext)?;
            let enc_target = target.with_extension(format!("{}.enc", ext));
            if let Some(parent) = enc_target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&enc_target, blob).map_err(|e| e.to_string())?;
            // Remove a stale plaintext mirror if the user disabled then
            // re-enabled encryption between syncs.
            let _ = fs::remove_file(&target);
        } else {
            // Binary or non-encrypted file — copy as-is.
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            copy_if_changed(p, &target)?;
        }
    }
    Ok(shadow.to_string_lossy().to_string())
}

fn copy_if_changed(src: &Path, dst: &Path) -> Result<(), String> {
    // Skip the copy when bytes match — saves both push diff size and
    // file-watcher noise. Cheap because both files are small (the encrypt
    // path handles big text).
    if dst.exists() {
        match (fs::metadata(src), fs::metadata(dst)) {
            (Ok(a), Ok(b)) if a.len() == b.len() => {
                if let (Ok(av), Ok(bv)) = (fs::read(src), fs::read(dst)) {
                    if av == bv {
                        return Ok(());
                    }
                }
            }
            _ => {}
        }
    }
    fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
}

/// Inverse of `crypto_encrypt_for_push`. Walks `<workspace>/.solomd-encrypted/`,
/// decrypts every `*.<ext>.enc`, and writes the resulting plaintext back
/// into the workspace at the same relative path.
#[tauri::command]
pub async fn crypto_decrypt_after_pull(folder: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crypto_decrypt_after_pull_inner(folder))
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub fn crypto_decrypt_after_pull_inner(folder: String) -> Result<(), String> {
    let path = PathBuf::from(&folder);
    let cfg = load_config(&path)?
        .ok_or_else(|| "encryption is not enabled for this workspace".to_string())?;
    let key = read_key_from_keyring(&path)?
        .ok_or_else(|| "encryption key missing — set passphrase again".to_string())?;
    let shadow = shadow_path(&path);
    if !shadow.exists() {
        return Ok(());
    }
    let exts: Vec<String> = cfg
        .encrypt_extensions
        .iter()
        .map(|s| s.to_lowercase())
        .collect();
    for entry in WalkDir::new(&shadow).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.starts_with(shadow.join(".git")) {
            continue;
        }
        let rel = match p.strip_prefix(&shadow) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let target = path.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if let Some(stripped) = name.strip_suffix(".enc") {
            // Strip the .enc to get back to e.g. "note.md".
            let mut plain_target = target.clone();
            plain_target.set_file_name(stripped);
            let inner_ext = Path::new(stripped)
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            if !exts.contains(&inner_ext) {
                continue;
            }
            let blob = fs::read(p).map_err(|e| e.to_string())?;
            let aad_rel = match plain_target.strip_prefix(&path) {
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            let plaintext = decrypt_bytes(&key, &aad_rel, &blob)?;
            if let Some(parent) = plain_target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&plain_target, plaintext).map_err(|e| e.to_string())?;
        } else {
            // Mirrored binary — copy back.
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            copy_if_changed(p, &target)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests — round-trip + tamper detection.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fresh(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("solomd-crypto-{label}-{nanos}"));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn fixed_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = (i * 7) as u8;
        }
        k
    }

    #[test]
    fn round_trip_short() {
        let key = fixed_key();
        let blob = encrypt_bytes(&key, "notes/foo.md", b"hello world").unwrap();
        let back = decrypt_bytes(&key, "notes/foo.md", &blob).unwrap();
        assert_eq!(back, b"hello world");
    }

    #[test]
    fn round_trip_unicode_and_long() {
        let key = fixed_key();
        let pt: Vec<u8> = (0..4096).map(|i| (i % 251) as u8).collect();
        let blob = encrypt_bytes(&key, "deep/path/x.md", &pt).unwrap();
        let back = decrypt_bytes(&key, "deep/path/x.md", &blob).unwrap();
        assert_eq!(back, pt);

        let utf8 = "中文标题\n# Hello 🌏\n— em-dash";
        let blob2 = encrypt_bytes(&key, "中文/note.md", utf8.as_bytes()).unwrap();
        let back2 = decrypt_bytes(&key, "中文/note.md", &blob2).unwrap();
        assert_eq!(back2, utf8.as_bytes());
    }

    #[test]
    fn aad_path_swap_fails() {
        let key = fixed_key();
        let blob = encrypt_bytes(&key, "secret.md", b"top secret").unwrap();
        let res = decrypt_bytes(&key, "boring.md", &blob);
        assert!(res.is_err(), "AAD mismatch must reject");
    }

    #[test]
    fn wrong_key_fails() {
        let blob = encrypt_bytes(&fixed_key(), "x.md", b"abc").unwrap();
        let mut bad = fixed_key();
        bad[0] ^= 1;
        assert!(decrypt_bytes(&bad, "x.md", &blob).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = fixed_key();
        let mut blob = encrypt_bytes(&key, "x.md", b"abcdef").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert!(decrypt_bytes(&key, "x.md", &blob).is_err());
    }

    #[test]
    fn argon2_derives_deterministically() {
        let salt = vec![1u8; 16];
        let p = KdfParams::default();
        let k1 = derive_key("hunter2", &salt, &p).unwrap();
        let k2 = derive_key("hunter2", &salt, &p).unwrap();
        assert_eq!(k1, k2);
        let k3 = derive_key("hunter3", &salt, &p).unwrap();
        assert_ne!(k1, k3);
    }

    #[test]
    fn workspace_round_trip() {
        let ws = fresh("ws");
        // Layout: notes/a.md (encrypted), assets/img.png (mirrored as-is),
        // .solomd/sync.json (skipped — workspace metadata never enters
        // the shadow).
        fs::create_dir_all(ws.join("notes")).unwrap();
        fs::create_dir_all(ws.join("assets")).unwrap();
        fs::create_dir_all(ws.join(".solomd")).unwrap();
        fs::write(ws.join("notes/a.md"), b"# Hello").unwrap();
        fs::write(ws.join("assets/img.png"), b"\x89PNG fake").unwrap();
        fs::write(ws.join(".solomd/sync.json"), b"{}").unwrap();

        let folder = ws.to_string_lossy().to_string();
        crypto_set_passphrase(folder.clone(), "hunter2".into()).unwrap();
        let shadow = crypto_encrypt_for_push_inner(folder.clone()).unwrap();
        let shadow_dir = PathBuf::from(&shadow);
        assert!(shadow_dir.join("notes/a.md.enc").exists());
        assert!(shadow_dir.join("assets/img.png").exists());
        assert!(!shadow_dir.join(".solomd/sync.json").exists());

        // Wipe the plaintext to simulate a fresh device, then decrypt
        // back from the shadow.
        fs::remove_file(ws.join("notes/a.md")).unwrap();
        crypto_decrypt_after_pull_inner(folder.clone()).unwrap();
        let restored = fs::read(ws.join("notes/a.md")).unwrap();
        assert_eq!(restored, b"# Hello");
    }

    #[test]
    fn second_set_passphrase_with_wrong_word_fails() {
        let ws = fresh("ws-pp");
        let folder = ws.to_string_lossy().to_string();
        crypto_set_passphrase(folder.clone(), "correct".into()).unwrap();
        let bad = crypto_set_passphrase(folder, "guess".into());
        assert!(bad.is_err());
        let _ = crypto_clear_passphrase(ws.to_string_lossy().to_string());
    }
}
