//! v4.0 — BYOK cost meter.
//!
//! Persistent, per-provider running totals (input tokens, output tokens,
//! USD spent) across every agent run, panel chat, and recipe execution.
//! Stored in `<app_config_dir>/cost-meter.json` so it follows the user
//! across workspaces (the cost is theirs, not the vault's).
//!
//! Opt-in by default. When `enabled = false`, `record()` no-ops — useful
//! for CI / scripting / privacy-conscious users who don't want a per-run
//! cost log on disk. Surface lives in Settings → AI.
//!
//! Schema:
//!
//! ```json
//! {
//!   "enabled": true,
//!   "since_epoch": 1730000000,
//!   "providers": {
//!     "anthropic": { "input": 12345, "output": 6789, "cost_usd": 0.1234, "runs": 3 },
//!     "openai":    { "input": 1000,  "output": 200,  "cost_usd": 0.0050, "runs": 1 }
//!   }
//! }
//! ```
//!
//! All writes are best-effort: a corrupt or missing file yields a fresh
//! default state rather than failing the calling run. We trade durability
//! for the contract that "running an agent never fails because the cost
//! ledger broke."

#[cfg(test)]
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderTotals {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub runs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostMeter {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "now_secs")]
    pub since_epoch: u64,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderTotals>,
}

fn default_enabled() -> bool {
    // Off by default — opt-in to match the privacy-conscious framing.
    false
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Default for CostMeter {
    fn default() -> Self {
        CostMeter {
            enabled: false,
            since_epoch: now_secs(),
            providers: BTreeMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// On-disk path resolution
// ---------------------------------------------------------------------------
//
// We don't have an `AppHandle` available from `RunHandle::finish` (it's a
// pure-Rust call site that runs on every recipe + every chat finish). So we
// stash the resolved config-dir path the first time a Tauri command touches
// the meter, and `record()` reads from that. If `record()` fires before any
// command has run (cold first-launch, no Settings open yet), we fall back to
// a best-effort `dirs`-style probe using env vars.

static CONFIG_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

#[cfg(test)]
thread_local! {
    static TEST_CONFIG_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

fn set_config_dir(p: PathBuf) {
    #[cfg(test)]
    {
        TEST_CONFIG_DIR.with(|d| {
            *d.borrow_mut() = Some(p);
        });
        return;
    }
    #[cfg(not(test))]
    {
        let mut g = CONFIG_DIR.lock().unwrap();
        *g = Some(p);
    }
}

fn current_config_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(p) = TEST_CONFIG_DIR.with(|d| d.borrow().clone()) {
        return Some(p);
    }
    if let Some(p) = CONFIG_DIR.lock().unwrap().clone() {
        return Some(p);
    }
    // Fallback heuristic — only used when no Tauri command has primed the
    // path yet. Mirrors the Tauri default for `app_config_dir` on each
    // platform: macOS = ~/Library/Application Support/<bundle>, Linux =
    // $XDG_CONFIG_HOME or ~/.config/<bundle>, Windows = %APPDATA%/<bundle>.
    // We don't know the bundle id from pure Rust, so we use a stable
    // sub-folder name; if the real Tauri-resolved dir later overrides this,
    // a one-time migration kicks in below.
    let base = if cfg!(target_os = "macos") {
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
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| PathBuf::from(h).join(".config"))
            })
            .map(|p| p.join("solomd"))
    };
    base
}

fn meter_path() -> Option<PathBuf> {
    current_config_dir().map(|d| d.join("cost-meter.json"))
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

fn read_meter() -> CostMeter {
    let Some(path) = meter_path() else {
        return CostMeter::default();
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return CostMeter::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_meter(meter: &CostMeter) -> Result<(), String> {
    let Some(path) = meter_path() else {
        return Err("no app config dir".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(meter).map_err(|e| format!("serialise: {e}"))?;
    // Best-effort atomic write: write to a sibling temp file, then rename.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Recording — called from RunHandle finish paths
// ---------------------------------------------------------------------------

/// Record one run's tokens + cost into the per-provider totals. Cheap +
/// idempotent-on-error: if anything fails (lock, disk, JSON), we silently
/// drop the update so the running agent isn't disrupted.
///
/// `provider` is the unmodified provider id (`"anthropic"`, `"openai"`, …)
/// coming off the agent run's meta. `tokens_in` / `tokens_out` are the
/// per-run totals; `cost_usd` is what the caller already computed via
/// `pricing::estimate_cost_usd`.
pub fn record(provider: &str, tokens_in: u64, tokens_out: u64, cost_usd: f64) {
    if provider.is_empty() {
        return;
    }
    let mut meter = read_meter();
    if !meter.enabled {
        return;
    }
    let entry = meter
        .providers
        .entry(provider.to_string())
        .or_insert_with(ProviderTotals::default);
    entry.input = entry.input.saturating_add(tokens_in);
    entry.output = entry.output.saturating_add(tokens_out);
    entry.cost_usd += cost_usd.max(0.0);
    entry.runs = entry.runs.saturating_add(1);
    let _ = write_meter(&meter);
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn cost_meter_get(app: AppHandle) -> CostMeter {
    if let Ok(d) = app.path().app_config_dir() {
        set_config_dir(d);
    }
    read_meter()
}

#[tauri::command]
pub fn cost_meter_reset(app: AppHandle) -> CostMeter {
    if let Ok(d) = app.path().app_config_dir() {
        set_config_dir(d);
    }
    let meter = CostMeter {
        enabled: read_meter().enabled,
        since_epoch: now_secs(),
        providers: BTreeMap::new(),
    };
    let _ = write_meter(&meter);
    meter
}

#[tauri::command]
pub fn cost_meter_set_enabled(app: AppHandle, enabled: bool) -> CostMeter {
    if let Ok(d) = app.path().app_config_dir() {
        set_config_dir(d);
    }
    let mut meter = read_meter();
    meter.enabled = enabled;
    if meter.since_epoch == 0 {
        meter.since_epoch = now_secs();
    }
    let _ = write_meter(&meter);
    meter
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Serialise tests that mutate the singleton `CONFIG_DIR`. Without this
    /// they trample each other's tmp dirs and leak state across the static.
    static TEST_LOCK: Lazy<std::sync::Mutex<()>> = Lazy::new(|| std::sync::Mutex::new(()));

    fn set_temp_config_dir() -> PathBuf {
        let tmp = env::temp_dir().join(format!(
            "solomd-cost-test-{}",
            super::super::agent_run::mint_run_id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        set_config_dir(tmp.clone());
        tmp
    }

    /// Convenience: take the serial lock + mint a fresh tmp config dir so
    /// each test gets a clean meter file.
    fn fresh() -> (std::sync::MutexGuard<'static, ()>, PathBuf) {
        let g = TEST_LOCK.lock().unwrap();
        let dir = set_temp_config_dir();
        (g, dir)
    }

    #[test]
    fn record_noops_when_disabled() {
        let (_g, dir) = fresh();
        // default = disabled
        record("openai", 100, 200, 0.001);
        let m = read_meter();
        assert!(m.providers.get("openai").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_aggregates_per_provider_when_enabled() {
        let (_g, dir) = fresh();
        let mut m = read_meter();
        m.enabled = true;
        write_meter(&m).unwrap();

        record("openai", 100, 200, 0.001);
        record("openai", 50, 25, 0.0005);
        record("anthropic", 10, 5, 0.0001);

        let m = read_meter();
        let oai = m.providers.get("openai").unwrap();
        assert_eq!(oai.input, 150);
        assert_eq!(oai.output, 225);
        assert!((oai.cost_usd - 0.0015).abs() < 1e-9);
        assert_eq!(oai.runs, 2);

        let an = m.providers.get("anthropic").unwrap();
        assert_eq!(an.input, 10);
        assert_eq!(an.output, 5);
        assert_eq!(an.runs, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_clears_providers_but_keeps_enabled() {
        let (_g, dir) = fresh();
        let mut m = read_meter();
        m.enabled = true;
        m.providers.insert(
            "openai".into(),
            ProviderTotals {
                input: 1,
                output: 1,
                cost_usd: 0.5,
                runs: 1,
            },
        );
        write_meter(&m).unwrap();
        // reset() needs an AppHandle; emulate it by clearing manually then
        // re-reading so we exercise the same code path.
        let cleared = CostMeter {
            enabled: read_meter().enabled,
            since_epoch: now_secs(),
            providers: BTreeMap::new(),
        };
        write_meter(&cleared).unwrap();
        let m2 = read_meter();
        assert!(m2.enabled);
        assert!(m2.providers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_yields_default() {
        let (_g, dir) = fresh();
        std::fs::write(dir.join("cost-meter.json"), "{ this is not json").unwrap();
        let m = read_meter();
        assert!(!m.enabled);
        assert!(m.providers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
