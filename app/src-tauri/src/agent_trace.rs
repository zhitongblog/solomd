//! v4.0 Pillar 3 — Tauri command wrappers for the trace module.
//!
//! These commands give the Vue side (TraceView, agentTrace store, Recipes
//! Settings) read access to run traces and the ability to mint a "replay
//! from step N" run-dir prefix. The pure trace I/O lives in `trace.rs`;
//! this module just bridges to the Tauri command system, resolves the
//! workspace's `.solomd/agent-runs/<run_id>/` path, and serializes outputs.
//!
//! ### Boundary with P1
//!
//! `agent_trace_replay_from` prepares a NEW run directory with the trace
//! prefix and a fresh `run_started` line tagged `replayed_from`. It does
//! NOT re-issue the LLM call — that's `ai_proxy::ai_chat`'s job, which P1
//! owns. P3 returns the new `run_id` so the panel can then call `ai_chat`
//! against it in the existing way.
//!
//! ### Workspace path resolution
//!
//! `<workspace>/.solomd/agent-runs/<run_id>/`. We canonicalize `workspace`
//! to defend against `..` escapes; the run_id is validated as
//! `[A-Za-z0-9_-]+` only.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::trace::{self, Emitter, RunKind, TraceLine};

/// Per-run summary used by the panel's "recent runs" list and the Recipes
/// Settings page. Read from `<run_dir>/meta.json` (P1 writes it). For
/// runs missing a meta.json (e.g., a crash before P1's first write) we
/// synthesize a minimal entry from the directory name + first/last
/// trace lines so the user still sees the run.
#[derive(Debug, Serialize)]
pub struct RunSummary {
    pub run_id: String,
    pub kind: String,
    pub status: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tokens_in: u32,
    pub tokens_out: u32,
    pub cost_usd_estimate: f64,
    /// `meta.json` was present and parsed cleanly. False = synthesized.
    pub has_meta: bool,
}

// --------------------------------------------------------------------------
// agent_trace_read — wraps trace::read_trace
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn agent_trace_read(
    workspace: String,
    run_id: String,
) -> Result<Vec<TraceLine>, String> {
    let dir = resolve_run_dir(&workspace, &run_id).map_err(|e| e.to_string())?;
    trace::read_trace(&dir).map_err(|e| format!("read_trace: {e}"))
}

// --------------------------------------------------------------------------
// agent_trace_list — scans .solomd/agent-runs/*
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn agent_trace_list(workspace: String) -> Result<Vec<RunSummary>, String> {
    let runs_dir = resolve_runs_root(&workspace).map_err(|e| e.to_string())?;
    if !runs_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<RunSummary> = Vec::new();
    let entries =
        std::fs::read_dir(&runs_dir).map_err(|e| format!("read_dir agent-runs: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let run_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) if is_safe_run_id(s) => s.to_string(),
            _ => continue,
        };
        match summarize_run(&path, &run_id) {
            Ok(s) => out.push(s),
            Err(e) => {
                tracing::warn!(run = %run_id, err = %e, "agent_trace_list: skipping");
            }
        }
    }
    // Newest first by started_at. run_id format is YYYYMMDD-HHMMSS-... so
    // it sorts lexicographically too — but we use `started_at` from
    // meta.json when present in case a future run_id format breaks lex
    // ordering.
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

// --------------------------------------------------------------------------
// agent_trace_replay_from — mint a new run-dir with the prefix.
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn agent_trace_replay_from(
    workspace: String,
    run_id: String,
    seq: u32,
) -> Result<String, String> {
    let orig_dir = resolve_run_dir(&workspace, &run_id).map_err(|e| e.to_string())?;
    let prefix = trace::replay_prefix(&orig_dir, seq).map_err(|e| format!("replay_prefix: {e}"))?;
    if prefix.is_empty() {
        return Err(format!(
            "no replayable steps before seq={seq} in run {run_id}"
        ));
    }
    // Inherit provider/model from the original run_started line so the new
    // run starts on the same model. If absent we fall back to "?".
    let (provider, model, run_kind) = derive_replay_inputs(&prefix);

    let new_id = mint_run_id();
    let new_dir = resolve_runs_root(&workspace)
        .map_err(|e| e.to_string())?
        .join(&new_id);
    std::fs::create_dir_all(&new_dir).map_err(|e| format!("mkdir: {e}"))?;

    // Write an empty meta.json placeholder so listings can pick up the new
    // run before P1's `ai_chat` finalizes it. P1's RunHandle will overwrite
    // this on its first meta-write.
    let meta = serde_json::json!({
        "run_id": new_id,
        "kind": run_kind,
        "started_at": now_unix_seconds(),
        "ended_at": null,
        "status": "running",
        "workspace": workspace,
        "provider": provider,
        "model": model,
        "replayed_from": format!("{run_id}:{seq}"),
        "tokens": { "input": 0, "output": 0 },
        "cost_usd_estimate": 0.0,
        "error": null,
    });
    std::fs::write(
        new_dir.join("meta.json"),
        serde_json::to_string_pretty(&meta).unwrap_or_else(|_| "{}".into()),
    )
    .map_err(|e| format!("write meta.json: {e}"))?;

    // Copy the prefix lines verbatim — but rewrite each line's `run_id`
    // and `seq` so they're consistent with the new run. Then append the
    // `run_started` line that documents the replay origin.
    let em = Emitter::open(&new_dir, new_id.clone())
        .map_err(|e| format!("open emitter: {e}"))?;
    for line in &prefix {
        // Rebuild the payload sans the canonical fields, then re-emit
        // through `append` so the new line gets a fresh ts + new seq.
        let payload = strip_reserved_fields(&line.payload);
        let kind = match line.kind.as_str() {
            "run_started" => super::trace::TraceKind::RunStarted,
            "prompt" => super::trace::TraceKind::Prompt,
            "model_call" => super::trace::TraceKind::ModelCall,
            "model_chunk" => super::trace::TraceKind::ModelChunk,
            "model_done" => super::trace::TraceKind::ModelDone,
            "tool_call" => super::trace::TraceKind::ToolCall,
            "tool_result" => super::trace::TraceKind::ToolResult,
            "git_commit" => super::trace::TraceKind::GitCommit,
            "note" => super::trace::TraceKind::Note,
            "run_ended" => super::trace::TraceKind::RunEnded,
            _ => super::trace::TraceKind::Note, // unknown → keep as note
        };
        em.append(kind, payload).map_err(|e| format!("append: {e}"))?;
    }
    // Mark the replay origin. We over-write the last `run_started`-style
    // anchor by emitting a fresh `note` line that the UI can render as
    // the replay marker.
    em.note(&format!(
        "replayed from {run_id}:{seq} ({} prefix steps copied)",
        prefix.len()
    ))
    .map_err(|e| format!("append: {e}"))?;
    Ok(new_id)
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

fn resolve_runs_root(workspace: &str) -> Result<PathBuf, String> {
    let ws = Path::new(workspace);
    if !ws.is_absolute() {
        return Err(format!("workspace must be absolute: {workspace}"));
    }
    if !ws.exists() {
        return Err(format!("workspace does not exist: {workspace}"));
    }
    let canonical = ws
        .canonicalize()
        .map_err(|e| format!("canonicalize {workspace}: {e}"))?;
    Ok(canonical.join(".solomd").join("agent-runs"))
}

fn resolve_run_dir(workspace: &str, run_id: &str) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    let root = resolve_runs_root(workspace)?;
    Ok(root.join(run_id))
}

fn is_safe_run_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn mint_run_id() -> String {
    // Format per C1: YYYYMMDD-HHMMSS-<6 hex>. We avoid pulling in chrono
    // by building from SystemTime + some random hex from `rand`.
    use rand::RngCore;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Decompose unix seconds into a UTC date/time WITHOUT chrono. For a
    // throwaway human-readable label this is fine — accuracy-to-second is
    // all we need, and the 6-hex suffix prevents collisions.
    let (yyyy, mm, dd, hh, mi, ss) = unix_to_utc(secs);
    let mut buf = [0u8; 3];
    rand::thread_rng().fill_bytes(&mut buf);
    let hex = buf.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!("{yyyy:04}{mm:02}{dd:02}-{hh:02}{mi:02}{ss:02}-{hex}")
}

/// Plain Gregorian-calendar conversion. Good enough for run-id labels;
/// we don't need timezone or leap-second precision here.
fn unix_to_utc(mut secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let ss = secs % 60;
    secs /= 60;
    let mi = secs % 60;
    secs /= 60;
    let hh = secs % 24;
    let mut days = secs / 24;
    // Year/month/day from days-since-1970.
    let mut year: u64 = 1970;
    loop {
        let dy = if is_leap(year) { 366 } else { 365 };
        if days < dy {
            break;
        }
        days -= dy;
        year += 1;
    }
    let dim = days_in_month(year);
    let mut month = 1u64;
    for (i, dm) in dim.iter().enumerate() {
        if days < *dm {
            month = (i + 1) as u64;
            break;
        }
        days -= *dm;
    }
    let day = days + 1;
    (year, month, day, hh, mi, ss)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: u64) -> [u64; 12] {
    [
        31,
        if is_leap(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ]
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn strip_reserved_fields(payload: &serde_json::Value) -> serde_json::Value {
    let mut clone = payload.clone();
    if let Some(obj) = clone.as_object_mut() {
        for k in ["ts", "run_id", "seq", "kind"] {
            obj.remove(k);
        }
    }
    clone
}

fn derive_replay_inputs(prefix: &[TraceLine]) -> (String, String, String) {
    let started = prefix.iter().find(|l| l.kind == "run_started");
    let provider = started
        .and_then(|l| l.payload.get("provider").and_then(|v| v.as_str()))
        .unwrap_or("?")
        .to_string();
    let model = started
        .and_then(|l| l.payload.get("model").and_then(|v| v.as_str()))
        .unwrap_or("?")
        .to_string();
    let run_kind = started
        .and_then(|l| l.payload.get("run_kind").and_then(|v| v.as_str()))
        .unwrap_or(RunKind::Panel.as_str())
        .to_string();
    (provider, model, run_kind)
}

fn summarize_run(run_dir: &Path, run_id: &str) -> Result<RunSummary, String> {
    // Try meta.json first.
    let meta_path = run_dir.join("meta.json");
    if meta_path.exists() {
        let raw = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("meta.json: {e}"))?;
        return Ok(RunSummary {
            run_id: v
                .get("run_id")
                .and_then(|x| x.as_str())
                .unwrap_or(run_id)
                .to_string(),
            kind: v
                .get("kind")
                .and_then(|x| x.as_str())
                .unwrap_or("panel")
                .to_string(),
            status: v
                .get("status")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown")
                .to_string(),
            started_at: v.get("started_at").and_then(|x| x.as_u64()).unwrap_or(0),
            ended_at: v.get("ended_at").and_then(|x| x.as_u64()),
            provider: v
                .get("provider")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            model: v
                .get("model")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            tokens_in: v
                .pointer("/tokens/input")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            tokens_out: v
                .pointer("/tokens/output")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
            cost_usd_estimate: v
                .get("cost_usd_estimate")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0),
            has_meta: true,
        });
    }
    // Synthesize from trace.jsonl. Useful when a run crashed before P1
    // wrote meta — we don't want the panel's recent-runs list to skip it.
    let trace = trace::read_trace(run_dir).map_err(|e| format!("read_trace: {e}"))?;
    let started = trace.iter().find(|l| l.kind == "run_started");
    let ended = trace.iter().rfind(|l| l.kind == "run_ended");
    Ok(RunSummary {
        run_id: run_id.to_string(),
        kind: started
            .and_then(|l| l.payload.get("run_kind").and_then(|v| v.as_str()))
            .unwrap_or("panel")
            .to_string(),
        status: ended
            .and_then(|l| l.payload.get("status").and_then(|v| v.as_str()))
            .unwrap_or("running")
            .to_string(),
        started_at: started.map(|l| l.ts / 1000).unwrap_or(0),
        ended_at: ended.map(|l| l.ts / 1000),
        provider: started
            .and_then(|l| l.payload.get("provider").and_then(|v| v.as_str()))
            .map(|s| s.to_string()),
        model: started
            .and_then(|l| l.payload.get("model").and_then(|v| v.as_str()))
            .map(|s| s.to_string()),
        tokens_in: ended
            .and_then(|l| l.payload.get("tokens_in_total").and_then(|v| v.as_u64()))
            .unwrap_or(0) as u32,
        tokens_out: ended
            .and_then(|l| l.payload.get("tokens_out_total").and_then(|v| v.as_u64()))
            .unwrap_or(0) as u32,
        cost_usd_estimate: ended
            .and_then(|l| l.payload.get("cost_usd_estimate").and_then(|v| v.as_f64()))
            .unwrap_or(0.0),
        has_meta: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_id_validation_rejects_traversal() {
        assert!(!is_safe_run_id(""));
        assert!(!is_safe_run_id("../../etc/passwd"));
        assert!(!is_safe_run_id("a/b"));
        assert!(!is_safe_run_id(" leading-space"));
        assert!(is_safe_run_id("20260430-142307-a3f9c1"));
        assert!(is_safe_run_id("abc_def-123"));
    }

    #[test]
    fn unix_to_utc_known_dates() {
        // 2026-04-30 14:23:07 UTC = 1777558987 (verified via Python).
        let (y, mo, d, h, mi, s) = unix_to_utc(1777558987);
        assert_eq!((y, mo, d, h, mi, s), (2026, 4, 30, 14, 23, 7));
        // Leap-day check: 2024-02-29 12:00:00 UTC = 1709208000
        let (y, mo, d, _, _, _) = unix_to_utc(1709208000);
        assert_eq!((y, mo, d), (2024, 2, 29));
        // End-of-year check (catches month-loop edge cases).
        // 2025-12-31 23:59:59 UTC = 1767225599
        let (y, mo, d, _, _, _) = unix_to_utc(1767225599);
        assert_eq!((y, mo, d), (2025, 12, 31));
    }

    #[test]
    fn replay_inputs_default_when_no_run_started() {
        // Defensive: a torn trace with no run_started shouldn't blow up.
        let (p, m, k) = derive_replay_inputs(&[]);
        assert_eq!(p, "?");
        assert_eq!(m, "?");
        assert_eq!(k, "panel");
    }
}
