//! v4.0 Pillar 2 — agent run directory + trace writer.
//!
//! Implements the C1 layout:
//!
//! ```text
//! <workspace>/.solomd/agent-runs/<run-id>/
//! ├── meta.json
//! ├── trace.jsonl
//! └── run.md
//! ```
//!
//! Both Pillar 1 (Panel) and Pillar 2 (Recipes) write here. P1 hasn't
//! merged a canonical writer yet, so this minimal module is intentionally
//! small + dependency-free so it can be reconciled at merge with no
//! drama. If P1 ships a richer `RunHandle`, it should subsume this; the
//! TODO at the top of `recipe_runner.rs` flags the swap.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// meta.json (C1.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Ok,
    Error,
    Cancelled,
    Rejected,
    Accepted,
}

impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Ok => "ok",
            RunStatus::Error => "error",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Rejected => "rejected",
            RunStatus::Accepted => "accepted",
        }
    }
}

/// Recipe-specific block of `meta.json` (C1.1). Only populated when
/// `kind == "recipe"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeMeta {
    pub name: String,
    /// Workspace-relative path to the source `.yml`.
    pub path: String,
    /// One of: `schedule` / `on-save` / `on-commit` / `on-tag-add` /
    /// `manual`.
    pub trigger: String,
    /// AutoGit branch the run committed to.
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
}

impl Default for TokenCounts {
    fn default() -> Self {
        TokenCounts { input: 0, output: 0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunMeta {
    pub run_id: String,
    /// `panel` or `recipe`.
    pub kind: String,
    /// Unix seconds, UTC.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// String form to keep the JSON compatible with C1.1 (the schema
    /// uses bare strings, not enum tags).
    pub status: String,
    pub workspace: String,
    pub provider: String,
    pub model: String,
    pub recipe: Option<RecipeMeta>,
    #[serde(default)]
    pub tokens: TokenCounts,
    #[serde(default)]
    pub cost_usd_estimate: f64,
    #[serde(default)]
    pub error: Option<String>,
    /// User accept/reject decision — None until the user clicks one of
    /// the Settings → Recipes pending-run buttons. Persisted alongside
    /// `status`; UI uses `accepted == None` as the "needs review" cue.
    #[serde(default)]
    pub accepted: Option<bool>,
}

// ---------------------------------------------------------------------------
// Run handle
// ---------------------------------------------------------------------------

/// Owned writer for one run's directory. Cheap to construct and drop;
/// the only state held is a buffered append to `trace.jsonl` behind a
/// `Mutex` so multiple async tool-call branches can append without
/// stepping on each other.
///
/// `seq` is monotonic 1-based per C2; we increment under the same mutex
/// that guards the file append so it's always strictly ordered.
pub struct RunHandle {
    pub run_id: String,
    pub root: PathBuf,
    /// Workspace this run lives under. Currently only used by the
    /// Settings UI's display layer and the integration test; kept as a
    /// public field so external callers don't have to re-derive it from
    /// `root`.
    #[allow(dead_code)]
    pub workspace: PathBuf,
    seq: Mutex<u64>,
    trace_file: Mutex<File>,
    run_md: Mutex<File>,
}

impl RunHandle {
    /// Create a fresh run directory. Returns an open handle ready to
    /// take steps. Writes an initial `meta.json` with `status: running`
    /// — `finalize` rewrites it on completion.
    pub fn create(workspace: &Path, run_id: &str, meta: RunMeta) -> Result<Self, String> {
        let root = workspace
            .join(".solomd")
            .join("agent-runs")
            .join(run_id);
        fs::create_dir_all(&root).map_err(|e| format!("mkdir run dir: {e}"))?;

        // meta.json
        let meta_path = root.join("meta.json");
        let json = serde_json::to_string_pretty(&meta)
            .map_err(|e| format!("serialise meta: {e}"))?;
        fs::write(&meta_path, json).map_err(|e| format!("write meta: {e}"))?;

        // trace.jsonl — append-only.
        let trace = OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("trace.jsonl"))
            .map_err(|e| format!("open trace.jsonl: {e}"))?;

        // run.md — start with the YAML front-matter from C1.2.
        let run_md_path = root.join("run.md");
        let mut run_md = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&run_md_path)
            .map_err(|e| format!("open run.md: {e}"))?;
        let started = chrono::DateTime::<Utc>::from_timestamp(meta.started_at, 0)
            .unwrap_or_else(Utc::now)
            .format("%Y-%m-%dT%H:%M:%SZ");
        let header = if meta.kind == "recipe" {
            let name = meta
                .recipe
                .as_ref()
                .map(|r| r.name.as_str())
                .unwrap_or("Recipe");
            format!(
                "---\nrun_id: {}\nkind: recipe\nprovider: {}\nmodel: {}\nstarted_at: {}\n---\n\n# Recipe run · {} · {}\n\n",
                meta.run_id, meta.provider, meta.model, started, name, meta.run_id
            )
        } else {
            format!(
                "---\nrun_id: {}\nkind: panel\nprovider: {}\nmodel: {}\nstarted_at: {}\n---\n\n# Panel chat · {}\n\n",
                meta.run_id, meta.provider, meta.model, started, meta.run_id
            )
        };
        run_md
            .write_all(header.as_bytes())
            .map_err(|e| format!("write run.md header: {e}"))?;
        run_md.flush().ok();

        Ok(RunHandle {
            run_id: run_id.to_string(),
            root,
            workspace: workspace.to_path_buf(),
            seq: Mutex::new(0),
            trace_file: Mutex::new(trace),
            run_md: Mutex::new(run_md),
        })
    }

    /// Append one C2 trace step to `trace.jsonl`. The caller passes a
    /// `serde_json::Value` describing the step; we inject `ts`, `seq`,
    /// `run_id` here so callers can't forget them.
    pub fn append_step(&self, mut step: serde_json::Value) -> Result<(), String> {
        let now = chrono::Utc::now();
        let mut seq = self.seq.lock().map_err(|_| "seq lock".to_string())?;
        *seq += 1;
        if let serde_json::Value::Object(map) = &mut step {
            map.insert("ts".into(), serde_json::json!(now.timestamp_millis()));
            map.insert("seq".into(), serde_json::json!(*seq));
            map.insert("run_id".into(), serde_json::json!(self.run_id.clone()));
        }
        let line = serde_json::to_string(&step)
            .map_err(|e| format!("serialise step: {e}"))?;
        let mut f = self.trace_file.lock().map_err(|_| "trace lock".to_string())?;
        writeln!(f, "{line}").map_err(|e| format!("trace write: {e}"))?;
        f.flush().ok();
        Ok(())
    }

    /// Append a chunk of markdown to `run.md`. Used by the runner to
    /// keep a human-readable transcript in lockstep with `trace.jsonl`
    /// so partial runs are still inspectable per C1.2.
    pub fn append_markdown(&self, text: &str) -> Result<(), String> {
        let mut f = self.run_md.lock().map_err(|_| "run.md lock".to_string())?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("run.md write: {e}"))?;
        if !text.ends_with('\n') {
            f.write_all(b"\n").ok();
        }
        f.flush().ok();
        Ok(())
    }

    /// Re-write `meta.json` after the run finishes (or errors). Reads
    /// the on-disk meta, applies the patch, and writes it back. We do a
    /// read-then-rewrite (rather than just dumping the in-memory copy)
    /// because the runner mutates token counts incrementally and the
    /// owner of those numbers is the runner, not this handle.
    pub fn finalize(&self, meta: &RunMeta) -> Result<(), String> {
        let path = self.root.join("meta.json");
        let json = serde_json::to_string_pretty(meta)
            .map_err(|e| format!("serialise meta: {e}"))?;
        fs::write(&path, json).map_err(|e| format!("write meta: {e}"))
    }

    /// Convenience — builds a `run_started` step and appends it.
    pub fn emit_run_started(&self, meta: &RunMeta) -> Result<(), String> {
        let mut step = serde_json::json!({
            "kind": "run_started",
            "provider": meta.provider,
            "model": meta.model,
        });
        // For recipe runs include the recipe name so the trace is
        // self-describing without needing meta.json.
        if let serde_json::Value::Object(map) = &mut step {
            map.insert("run_kind".into(), serde_json::json!(meta.kind));
            if let Some(r) = &meta.recipe {
                map.insert("recipe".into(), serde_json::json!(r));
            }
        }
        self.append_step(step)
    }

    /// Convenience — builds a `run_ended` step and appends it. `meta`
    /// should already contain the final status / token counts / error.
    pub fn emit_run_ended(&self, meta: &RunMeta) -> Result<(), String> {
        let step = serde_json::json!({
            "kind": "run_ended",
            "status": meta.status,
            "tokens_in_total": meta.tokens.input,
            "tokens_out_total": meta.tokens.output,
            "cost_usd_estimate": meta.cost_usd_estimate,
            "error": meta.error,
        });
        self.append_step(step)
    }
}

// ---------------------------------------------------------------------------
// Helpers — read meta.json + trace.jsonl back for the History UI.
// ---------------------------------------------------------------------------

/// Read every run's `meta.json` under `<workspace>/.solomd/agent-runs/`.
/// Returns runs sorted by `started_at` descending (newest first).
pub fn list_runs(workspace: &Path) -> Vec<RunMeta> {
    let dir = workspace.join(".solomd").join("agent-runs");
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let meta_path = p.join("meta.json");
        let raw = match fs::read_to_string(&meta_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        match serde_json::from_str::<RunMeta>(&raw) {
            Ok(m) => out.push(m),
            Err(_) => continue,
        }
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

/// Read meta.json for a single run.
pub fn read_run_meta(workspace: &Path, run_id: &str) -> Result<RunMeta, String> {
    let path = workspace
        .join(".solomd")
        .join("agent-runs")
        .join(run_id)
        .join("meta.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("read meta: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse meta: {e}"))
}

pub fn write_run_meta(workspace: &Path, run_id: &str, meta: &RunMeta) -> Result<(), String> {
    let path = workspace
        .join(".solomd")
        .join("agent-runs")
        .join(run_id)
        .join("meta.json");
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("serialise meta: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write meta: {e}"))
}

pub fn read_trace(workspace: &Path, run_id: &str) -> Result<String, String> {
    let path = workspace
        .join(".solomd")
        .join("agent-runs")
        .join(run_id)
        .join("trace.jsonl");
    fs::read_to_string(&path).map_err(|e| format!("read trace: {e}"))
}

pub fn read_run_md(workspace: &Path, run_id: &str) -> Result<String, String> {
    let path = workspace
        .join(".solomd")
        .join("agent-runs")
        .join(run_id)
        .join("run.md");
    fs::read_to_string(&path).map_err(|e| format!("read run.md: {e}"))
}

#[allow(dead_code)]
fn _silence_unused() {
    let _: Option<DateTime<Utc>> = None;
}
