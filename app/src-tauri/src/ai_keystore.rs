//! #102 — cross-platform AI key storage with an Android-safe fallback.
//!
//! BYOK provider keys (OpenAI, Anthropic, DeepSeek, …) used to live solely
//! in the OS-native credential store via the `keyring` crate. That works on
//! macOS (Keychain), Windows (Credential Manager) and Linux (libsecret),
//! but the `keyring` build we ship has **no Android backend** — on Android
//! it silently falls back to an in-process mock store that does NOT persist
//! across app restarts, so AI keys entered in Settings vanished the moment
//! the app closed.
//!
//! This module abstracts key storage behind a two-tiered fallback:
//!
//!   1. **Keyring (primary)** — used wherever a real backend exists
//!      (macOS / Windows / Linux). Tried first on every platform.
//!   2. **Encrypted file (fallback)** — when keyring has no usable backend
//!      (Android, or any platform whose secret service is unavailable), keys
//!      are persisted to `<app_config_dir>/solomd-ai-keys.json`, each value
//!      encrypted with XChaCha20-Poly1305 via the same `crypto::encrypt_bytes`
//!      / `crypto::decrypt_bytes` primitives the E2EE vault uses. The
//!      symmetric key is a per-install 32-byte secret kept next to the store
//!      in `solomd-ai-keys.key` — on Android the app-private config dir is
//!      already sandboxed per-app by the OS, so the file is only readable by
//!      SoloMD itself.
//!
//! The fallback decision is made per-call and **cached**: the first time a
//! keyring operation reports "no backend", we flip a process-wide flag and
//! every subsequent call goes straight to the encrypted file (no repeated
//! failing keyring probes). On a healthy desktop the flag never flips and
//! the file is never created.
//!
//! Config-dir resolution mirrors `cost_meter.rs`: a Tauri command primes the
//! resolved `app_config_dir` once, and the pure-Rust call sites (recipe
//! runner, ai_chat token paths) read from that stashed path, falling back to
//! an env-based probe if no command has run yet.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};

use super::crypto;

const KEYRING_SERVICE: &str = "solomd";
const KEY_STORE_FILE: &str = "solomd-ai-keys.json";
const KEY_SECRET_FILE: &str = "solomd-ai-keys.key";
/// AAD for the encrypted-file fallback. Binds each value to the keystore so
/// a value can't be lifted out and replayed as a different file's content.
const AAD: &str = "solomd-ai-keystore-v1";

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
//
// On Android the `keyring` crate we ship has NO platform backend compiled in,
// so it silently substitutes an in-process *mock* store. The mock never
// errors — it just loses everything on process exit (NoEntry after restart).
// Because the failure is silent we can't rely on a runtime error to detect
// it, so we make the call at compile time: on Android we go straight to the
// encrypted-file backend, always.
//
// On desktop (macOS / Windows / Linux) keyring is primary. `USE_FILE_FALLBACK`
// is a runtime safety net there too: the first time a keyring call reports a
// genuine no-backend error (e.g. a Linux box with no Secret Service / DBus
// session), we flip the flag and every subsequent call routes to the file.
// Once flipped it stays flipped for the process lifetime — backend
// availability doesn't change at runtime, so re-probing would just burn
// cycles on guaranteed failures.

static USE_FILE_FALLBACK: AtomicBool = AtomicBool::new(false);

/// Compile-time: platforms where keyring has no usable backend. Android is
/// the one that bit us (#102); list it explicitly rather than `!desktop` so
/// adding a future Android-like target is a deliberate edit.
const FORCE_FILE_BACKEND: bool = cfg!(target_os = "android");

/// True when a keyring error means "this platform has no working credential
/// backend" (vs. a transient/per-entry error like NoEntry). Surfaces as
/// `NoStorageAccess` (no Secret Service / DBus) or `PlatformFailure`.
fn is_no_backend(err: &keyring::Error) -> bool {
    matches!(
        err,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    )
}

fn fallback_active() -> bool {
    FORCE_FILE_BACKEND || USE_FILE_FALLBACK.load(Ordering::Relaxed)
}

fn mark_fallback() {
    USE_FILE_FALLBACK.store(true, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Config-dir resolution (mirrors cost_meter.rs)
// ---------------------------------------------------------------------------

static CONFIG_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// Prime the resolved `app_config_dir` from a Tauri command. Cheap + safe to
/// call on every command entry; the first non-None value wins for fallbacks
/// that run later without an `AppHandle`.
pub fn prime_config_dir(app: &AppHandle) {
    if let Ok(d) = app.path().app_config_dir() {
        if let Ok(mut g) = CONFIG_DIR.lock() {
            *g = Some(d);
        }
    }
}

fn current_config_dir() -> Option<PathBuf> {
    if let Ok(g) = CONFIG_DIR.lock() {
        if let Some(p) = g.clone() {
            return Some(p);
        }
    }
    // Fallback heuristic — only used if no Tauri command has primed the path
    // yet. Mirrors the Tauri default for `app_config_dir` per platform.
    if cfg!(target_os = "android") {
        // Android: the OS hands the app a private files dir; Tauri maps
        // `app_config_dir` under it. Without an AppHandle we can't resolve
        // the exact path from pure Rust, so probe the conventional env the
        // Android runtime exports, then a stable in-app-data subfolder.
        std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join("solomd"))
    } else if cfg!(target_os = "macos") {
        std::env::var("HOME").ok().map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Application Support")
                .join("solomd")
        })
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .ok()
            .map(|h| PathBuf::from(h).join("solomd"))
    } else {
        std::env::var("XDG_CONFIG_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".config")))
            .map(|p| p.join("solomd"))
    }
}

fn store_path() -> Option<PathBuf> {
    current_config_dir().map(|d| d.join(KEY_STORE_FILE))
}

fn secret_path() -> Option<PathBuf> {
    current_config_dir().map(|d| d.join(KEY_SECRET_FILE))
}

// ---------------------------------------------------------------------------
// Encrypted-file fallback
// ---------------------------------------------------------------------------

/// Load (or lazily create) the per-install 32-byte secret used to encrypt
/// the AI key store. Stored next to the store in the app-private config dir.
/// Generated once with the OS CSPRNG; never leaves the device.
fn load_or_create_secret() -> Result<[u8; 32], String> {
    let path = secret_path().ok_or_else(|| "no app config dir".to_string())?;
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            return Ok(out);
        }
        // Wrong length → treat as corrupt and regenerate (existing encrypted
        // values become unrecoverable, but a 32-byte file should never be
        // the wrong size unless tampered with).
    }
    use rand::RngCore;
    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(&path, secret).map_err(|e| format!("write secret: {e}"))?;
    Ok(secret)
}

/// Read the on-disk provider→ciphertext(hex) map. Missing / corrupt file
/// yields an empty map rather than failing.
fn read_store() -> BTreeMap<String, String> {
    let Some(path) = store_path() else {
        return BTreeMap::new();
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return BTreeMap::new(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_store(map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = store_path().ok_or_else(|| "no app config dir".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| format!("serialise: {e}"))?;
    // Atomic-ish write: temp + rename, same as cost_meter.rs.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
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

fn file_set_key(provider: &str, key: &str) -> Result<(), String> {
    let secret = load_or_create_secret()?;
    let blob = crypto::encrypt_bytes(&secret, AAD, key.as_bytes())?;
    let mut map = read_store();
    map.insert(provider.to_string(), hex_encode(&blob));
    write_store(&map)
}

fn file_has_key(provider: &str) -> bool {
    read_store().contains_key(provider)
}

fn file_clear_key(provider: &str) -> Result<(), String> {
    let mut map = read_store();
    if map.remove(provider).is_some() {
        write_store(&map)?;
    }
    Ok(())
}

fn file_read_key(provider: &str) -> Result<String, String> {
    let map = read_store();
    let hex = map
        .get(provider)
        .ok_or_else(|| "no API key set for provider".to_string())?;
    let secret = load_or_create_secret()?;
    let blob = hex_decode(hex)?;
    let plain = crypto::decrypt_bytes(&secret, AAD, &blob)?;
    String::from_utf8(plain).map_err(|e| format!("stored key is not valid UTF-8: {e}"))
}

// ---------------------------------------------------------------------------
// Keyring helpers
// ---------------------------------------------------------------------------

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ai-{provider}"))
        .map_err(|e| format!("keychain entry failed: {e}"))
}

// ---------------------------------------------------------------------------
// Public API — used by ai_proxy.rs
// ---------------------------------------------------------------------------

/// Store `key` for `provider`. Tries the OS keyring first; on a no-backend
/// platform (Android) it transparently persists to the encrypted file.
pub fn set_key(provider: &str, key: &str) -> Result<(), String> {
    if fallback_active() {
        return file_set_key(provider, key);
    }
    let entry = match keyring::Entry::new(KEYRING_SERVICE, &format!("ai-{provider}")) {
        Ok(e) => e,
        Err(e) if is_no_backend(&e) => {
            mark_fallback();
            return file_set_key(provider, key);
        }
        Err(e) => return Err(format!("keychain entry failed: {e}")),
    };
    match entry.set_password(key) {
        Ok(()) => Ok(()),
        Err(e) if is_no_backend(&e) => {
            mark_fallback();
            file_set_key(provider, key)
        }
        Err(e) => Err(format!("failed to store key: {e}")),
    }
}

/// True if a key is stored for `provider` (in whichever backend is active).
pub fn has_key(provider: &str) -> Result<bool, String> {
    if fallback_active() {
        return Ok(file_has_key(provider));
    }
    let entry = match keyring_entry(provider) {
        Ok(e) => e,
        Err(_) => {
            // Entry construction failing this early is itself a backend
            // problem on Android; route to the file and remember it.
            mark_fallback();
            return Ok(file_has_key(provider));
        }
    };
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) if is_no_backend(&e) => {
            mark_fallback();
            Ok(file_has_key(provider))
        }
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

/// Delete the stored key for `provider`. No-ops cleanly if none is set.
pub fn clear_key(provider: &str) -> Result<(), String> {
    if fallback_active() {
        return file_clear_key(provider);
    }
    let entry = match keyring_entry(provider) {
        Ok(e) => e,
        Err(_) => {
            mark_fallback();
            return file_clear_key(provider);
        }
    };
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) if is_no_backend(&e) => {
            mark_fallback();
            file_clear_key(provider)
        }
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

/// Read the stored key for `provider`. Errors with a user-facing message if
/// none is set.
pub fn read_key(provider: &str) -> Result<String, String> {
    if fallback_active() {
        return file_read_key(provider);
    }
    let entry = match keyring_entry(provider) {
        Ok(e) => e,
        Err(_) => {
            mark_fallback();
            return file_read_key(provider);
        }
    };
    match entry.get_password() {
        Ok(k) => Ok(k),
        Err(keyring::Error::NoEntry) => {
            // On a healthy keyring this is a genuine "not set". But the very
            // first read on Android also reports NoEntry from the mock store;
            // to be safe, if the encrypted file has the provider, prefer it.
            if file_has_key(provider) {
                mark_fallback();
                return file_read_key(provider);
            }
            Err("no API key set for provider".to_string())
        }
        Err(e) if is_no_backend(&e) => {
            mark_fallback();
            file_read_key(provider)
        }
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialise tests that mutate the singleton CONFIG_DIR + fallback flag.
    static TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn fresh_dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("solomd-aikeys-test-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        if let Ok(mut g) = CONFIG_DIR.lock() {
            *g = Some(dir.clone());
        }
        dir
    }

    /// The encrypted-file fallback must round-trip a key set → has → read →
    /// clear cycle independent of any OS keyring.
    #[test]
    fn file_fallback_round_trips() {
        let _g = TEST_LOCK.lock().unwrap();
        let dir = fresh_dir();

        assert!(!file_has_key("openai"));
        file_set_key("openai", "sk-secret-123").unwrap();
        assert!(file_has_key("openai"));
        assert_eq!(file_read_key("openai").unwrap(), "sk-secret-123");

        // A second provider is independent.
        file_set_key("anthropic", "anthropic-key-xyz").unwrap();
        assert_eq!(file_read_key("anthropic").unwrap(), "anthropic-key-xyz");
        assert_eq!(file_read_key("openai").unwrap(), "sk-secret-123");

        file_clear_key("openai").unwrap();
        assert!(!file_has_key("openai"));
        assert!(file_read_key("openai").is_err());
        // anthropic survives openai's removal
        assert_eq!(file_read_key("anthropic").unwrap(), "anthropic-key-xyz");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The on-disk store must NOT contain the plaintext key — it's encrypted.
    #[test]
    fn file_store_is_encrypted_at_rest() {
        let _g = TEST_LOCK.lock().unwrap();
        let dir = fresh_dir();

        file_set_key("deepseek", "PLAINTEXT-CANARY-9000").unwrap();
        let raw = std::fs::read_to_string(dir.join(KEY_STORE_FILE)).unwrap();
        assert!(
            !raw.contains("PLAINTEXT-CANARY-9000"),
            "key store must not hold the plaintext key"
        );
        // And it still decrypts back.
        assert_eq!(file_read_key("deepseek").unwrap(), "PLAINTEXT-CANARY-9000");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Persistence across "restarts" — a fresh read with the same config dir
    /// (the simulated next launch) still finds the key. This is the exact
    /// behaviour Android lacked with the mock keyring store.
    #[test]
    fn file_fallback_persists_across_reload() {
        let _g = TEST_LOCK.lock().unwrap();
        let dir = fresh_dir();
        file_set_key("qwen", "persist-me").unwrap();

        // Simulate a restart: re-point CONFIG_DIR at the same dir (the secret
        // + store files are already on disk) and read again.
        if let Ok(mut g) = CONFIG_DIR.lock() {
            *g = Some(dir.clone());
        }
        assert!(file_has_key("qwen"));
        assert_eq!(file_read_key("qwen").unwrap(), "persist-me");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
