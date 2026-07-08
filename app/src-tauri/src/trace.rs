//! v4.0 Pillar 3 — `trace.jsonl` emitter + reader.
//!
//! This is the **canonical** trace utility for SoloMD agent runs. P1 (panel
//! agent) and P2 (recipe runner) both adopt this module; the helper
//! signatures are intentionally typed (no raw `serde_json::Value` at call
//! sites) so trace lines are well-formed by construction.
//!
//! ### Scope of this module
//!
//! - Owns the `trace.jsonl` schema (see contracts C2).
//! - Owns the per-line truncation rule (`result` ≤ 2048 chars).
//! - Owns reading the file back, including malformed-line tolerance.
//! - Owns the replay-prefix slice used by "replay from step N".
//!
//! ### What this module does NOT own
//!
//! - **Run-directory layout** (`<workspace>/.solomd/agent-runs/<run_id>/`)
//!   — that's `agent_run.rs` (P1). This module takes the run dir as an input
//!   and only manipulates `trace.jsonl` inside it.
//! - **`meta.json` lifecycle** — also P1. The `Emitter` neither creates nor
//!   updates meta.json; it only appends lines. The caller (P1's `RunHandle`)
//!   keeps meta in sync separately.
//! - **`run.md`** — also P1.
//!
//! ### Concurrency posture
//!
//! Each run owns exactly one `Emitter`. Within a run, `append()` is safe to
//! call from multiple tasks because the file handle is wrapped in a `Mutex`
//! and `seq` is an `AtomicU32`. We do **not** support multiple `Emitter`
//! instances open against the same file — that's a programmer error, and
//! `BufWriter` flushes alone won't keep the lines from interleaving.
//!
//! ### Atomicity per line
//!
//! Each `append` builds the full line (including the trailing `\n`) in
//! memory, then performs **one** `write_all` while holding the mutex on the
//! `BufWriter`, then flushes. Linux/macOS guarantee atomicity for a single
//! `write()` ≤ PIPE_BUF for pipes; for regular files, a single
//! `write_all()` under our own mutex plus the buffered-writer's flush gives
//! us per-line atomicity. We test this with concurrent emitters under one
//! mutex (see `tests::concurrent_appends_do_not_interleave`).

// Several items here are intentional public API surface for downstream callers
// (the MCP server, future replay-from-step UI, the truncation contract). The
// binary build can't see those external uses, so allow dead_code module-wide
// rather than scatter attributes on every item.
#![allow(dead_code)]

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// --------------------------------------------------------------------------
// Schema — types that match contracts C2.
// --------------------------------------------------------------------------

/// 2048 char limit on the `result` payload of `tool_result` lines.
/// The full payload only lives in memory long enough to feed back to the
/// model; we never write it to disk.
pub const RESULT_TRUNCATE_CHARS: usize = 2048;

/// Hard cap on a single trace line (matches C2's "keep each line under 8 KB"
/// rule). We don't enforce this for arbitrary `payload` fields beyond the
/// `result` rule above — this constant is exposed so external callers can
/// pre-validate.
pub const LINE_SOFT_CAP_BYTES: usize = 8 * 1024;

/// Logical step kinds, 1:1 with the C2 table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceKind {
    RunStarted,
    Prompt,
    ModelCall,
    ModelChunk,
    ModelDone,
    ToolCall,
    ToolResult,
    GitCommit,
    Note,
    RunEnded,
}

impl TraceKind {
    /// Lower-snake_case name as it appears in the `kind` field on disk.
    pub fn as_str(self) -> &'static str {
        match self {
            TraceKind::RunStarted => "run_started",
            TraceKind::Prompt => "prompt",
            TraceKind::ModelCall => "model_call",
            TraceKind::ModelChunk => "model_chunk",
            TraceKind::ModelDone => "model_done",
            TraceKind::ToolCall => "tool_call",
            TraceKind::ToolResult => "tool_result",
            TraceKind::GitCommit => "git_commit",
            TraceKind::Note => "note",
            TraceKind::RunEnded => "run_ended",
        }
    }
}

/// One parsed line from `trace.jsonl`.
///
/// Loose-typed `payload` is intentional: each `kind` carries different
/// fields (per C2), and the canonical place to look up the field set is
/// the `Emitter::*` builders below or the contracts doc. UI / MCP code
/// reads what it needs out of `payload`. We keep `ts` / `run_id` / `seq`
/// / `kind` typed because every line has them and that's what indexing,
/// sorting, and matching tool_call_id pairs run on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceLine {
    /// Unix milliseconds, UTC.
    pub ts: u64,
    pub run_id: String,
    /// 1-based monotonic step index within the run.
    pub seq: u32,
    /// Lower-snake_case kind, e.g. `"tool_call"`.
    pub kind: String,
    /// All other fields (provider/model/text/result/...) live here.
    #[serde(flatten)]
    pub payload: serde_json::Value,
}

// --------------------------------------------------------------------------
// Emitter
// --------------------------------------------------------------------------

/// Append-only writer for `<run_dir>/trace.jsonl`.
///
/// Construct one per agent run. `seq` is monotonic from 1; the first line
/// emitted (typically `run_started`) gets `seq = 1`. The file is opened in
/// append mode so multiple short-lived `Emitter` lifetimes (e.g., resume
/// after a crash) keep their lines in chronological order on disk.
pub struct Emitter {
    run_dir: PathBuf,
    run_id: String,
    seq: AtomicU32,
    file: Mutex<BufWriter<File>>,
}

impl Emitter {
    /// Open or create `<run_dir>/trace.jsonl` for append.
    ///
    /// `run_dir` is expected to exist (created by P1's `agent_run.rs`).
    /// We don't create it here — keeping the run-directory invariant in
    /// one place avoids two modules racing on `mkdir`.
    pub fn open(run_dir: &Path, run_id: String) -> io::Result<Self> {
        let path = run_dir.join("trace.jsonl");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        // Existing line count → resume seq from there. This matters when
        // a recipe is retried after a crash and the partial trace is
        // already on disk; we want the next line to continue from the
        // saved sequence number, not restart at 1.
        let starting_seq = count_existing_lines(&path).unwrap_or(0);
        Ok(Self {
            run_dir: run_dir.to_path_buf(),
            run_id,
            seq: AtomicU32::new(starting_seq),
            file: Mutex::new(BufWriter::new(file)),
        })
    }

    /// The run id this emitter is bound to.
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The run directory this emitter is writing into.
    pub fn run_dir(&self) -> &Path {
        &self.run_dir
    }

    /// Append one line.
    ///
    /// Bumps `seq`, prepends `{ ts, run_id, seq, kind, ...payload }`, writes
    /// `<json>\n` in one `write_all` under a mutex, then flushes.
    pub fn append(&self, kind: TraceKind, payload: serde_json::Value) -> io::Result<()> {
        let next_seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let ts = now_unix_ms();
        let mut obj = serde_json::Map::new();
        obj.insert("ts".into(), serde_json::Value::from(ts));
        obj.insert("run_id".into(), serde_json::Value::from(self.run_id.clone()));
        obj.insert("seq".into(), serde_json::Value::from(next_seq));
        obj.insert("kind".into(), serde_json::Value::from(kind.as_str()));
        if let serde_json::Value::Object(map) = payload {
            for (k, v) in map {
                // Don't let payload accidentally clobber the canonical
                // header fields; that would make the line ambiguous on
                // read. Skip + log; never error mid-emit.
                if matches!(k.as_str(), "ts" | "run_id" | "seq" | "kind") {
                    tracing::warn!(
                        "trace: payload tried to override reserved field {k:?}; ignored"
                    );
                    continue;
                }
                obj.insert(k, v);
            }
        } else if !payload.is_null() {
            // Defensive: if a future caller passes a non-object payload,
            // stash it under "payload" rather than throwing.
            obj.insert("payload".into(), payload);
        }
        let mut line =
            serde_json::to_string(&serde_json::Value::Object(obj)).map_err(io_other)?;
        line.push('\n');
        let mut guard = self.file.lock().map_err(|_| io_poisoned())?;
        guard.write_all(line.as_bytes())?;
        guard.flush()?;
        Ok(())
    }

    // ---- Typed builders (one per kind) ------------------------------------
    //
    // These exist so call sites in P1 / P2 don't pass raw JSON. Adding a
    // new field to a kind's contract means changing the signature here,
    // which forces every call site to update — that's the point.

    /// `run_started` — must be the first line written for the run.
    pub fn run_started(
        &self,
        run_kind: RunKind,
        provider: &str,
        model: &str,
        recipe: Option<RecipeRef>,
        replayed_from: Option<&str>,
    ) -> io::Result<()> {
        let mut payload = serde_json::json!({
            "kind": run_kind.as_str(),
            "provider": provider,
            "model": model,
        });
        if let Some(r) = recipe {
            payload["recipe"] = serde_json::to_value(r).map_err(io_other)?;
        }
        if let Some(orig) = replayed_from {
            payload["replayed_from"] = serde_json::Value::from(orig);
        }
        // We rebuild as an object map so `kind` here (run_started's *run*
        // kind: panel|recipe) doesn't collide with the line-level kind.
        // Move it under a distinct key.
        let payload = match payload {
            serde_json::Value::Object(mut m) => {
                if let Some(rk) = m.remove("kind") {
                    m.insert("run_kind".into(), rk);
                }
                serde_json::Value::Object(m)
            }
            other => other,
        };
        self.append(TraceKind::RunStarted, payload)
    }

    /// `prompt` — a user turn or system seed.
    pub fn prompt(&self, role: &str, content: &str) -> io::Result<()> {
        self.append(
            TraceKind::Prompt,
            serde_json::json!({ "role": role, "content": content }),
        )
    }

    /// `model_call` — pre-flight before each LLM request.
    pub fn model_call(
        &self,
        provider: &str,
        model: &str,
        messages_n: usize,
        tools_n: usize,
    ) -> io::Result<()> {
        self.append(
            TraceKind::ModelCall,
            serde_json::json!({
                "provider": provider,
                "model": model,
                "messages_n": messages_n,
                "tools_n": tools_n,
            }),
        )
    }

    /// `model_chunk` — streaming chunk. Optional / verbose only; production
    /// default is OFF.
    pub fn model_chunk(&self, text: &str) -> io::Result<()> {
        self.append(
            TraceKind::ModelChunk,
            serde_json::json!({ "text": text }),
        )
    }

    /// `model_done` — LLM turn ended.
    pub fn model_done(
        &self,
        text: &str,
        tokens_in: u32,
        tokens_out: u32,
        finish_reason: &str,
    ) -> io::Result<()> {
        self.append(
            TraceKind::ModelDone,
            serde_json::json!({
                "text": text,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "finish_reason": finish_reason,
            }),
        )
    }

    /// `tool_call` — agent invoked a tool.
    pub fn tool_call(
        &self,
        tool: &str,
        tool_call_id: &str,
        args: &serde_json::Value,
    ) -> io::Result<()> {
        self.append(
            TraceKind::ToolCall,
            serde_json::json!({
                "tool": tool,
                "tool_call_id": tool_call_id,
                "args": args,
            }),
        )
    }

    /// `tool_result` — pair of `tool_call`. Truncates `result` per C2.
    pub fn tool_result(
        &self,
        tool_call_id: &str,
        result: &str,
        error: Option<&str>,
    ) -> io::Result<()> {
        let original_chars = result.chars().count();
        let original_bytes = result.len();
        let (truncated_text, truncated) = truncate_result(result);
        let mut payload = serde_json::json!({
            "tool_call_id": tool_call_id,
            "result": truncated_text,
            "result_bytes": original_bytes,
            "result_chars": original_chars,
        });
        if truncated {
            payload["truncated"] = serde_json::Value::from(true);
        }
        if let Some(err) = error {
            payload["error"] = serde_json::Value::from(err);
        }
        self.append(TraceKind::ToolResult, payload)
    }

    /// `git_commit` — AutoGit commit during a recipe write.
    pub fn git_commit(
        &self,
        branch: &str,
        sha: &str,
        summary: &str,
        files: &[String],
    ) -> io::Result<()> {
        self.append(
            TraceKind::GitCommit,
            serde_json::json!({
                "branch": branch,
                "sha": sha,
                "summary": summary,
                "files": files,
            }),
        )
    }

    /// `note` — free-form annotation.
    pub fn note(&self, text: &str) -> io::Result<()> {
        self.append(TraceKind::Note, serde_json::json!({ "text": text }))
    }

    /// `run_ended` — last line. After this the emitter should be dropped.
    pub fn run_ended(
        &self,
        status: &str,
        tokens_in_total: u32,
        tokens_out_total: u32,
        cost_usd_estimate: f64,
        error: Option<&str>,
    ) -> io::Result<()> {
        let mut payload = serde_json::json!({
            "status": status,
            "tokens_in_total": tokens_in_total,
            "tokens_out_total": tokens_out_total,
            "cost_usd_estimate": cost_usd_estimate,
        });
        if let Some(err) = error {
            payload["error"] = serde_json::Value::from(err);
        }
        self.append(TraceKind::RunEnded, payload)
    }
}

/// `run_started.run_kind` — per C1.1 / C2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKind {
    Panel,
    Recipe,
}

impl RunKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RunKind::Panel => "panel",
            RunKind::Recipe => "recipe",
        }
    }
}

/// `run_started.recipe` — per C1.1.
#[derive(Debug, Clone, Serialize)]
pub struct RecipeRef {
    pub name: String,
    pub path: String,
    pub trigger: String,
    pub branch: String,
}

// --------------------------------------------------------------------------
// Reader API
// --------------------------------------------------------------------------

/// Parse `<run_dir>/trace.jsonl` into a vector of `TraceLine`.
///
/// Tolerates malformed lines by skipping them with a `tracing::warn!`
/// rather than erroring the whole read. This matters because:
/// 1. A crashed run can leave a half-written final line.
/// 2. A future schema bump may introduce a kind a stale binary doesn't
///    understand; we still want the rest of the trace to render.
pub fn read_trace(run_dir: &Path) -> io::Result<Vec<TraceLine>> {
    let path = run_dir.join("trace.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(parse_trace_str(&raw))
}

/// Parse a `trace.jsonl` blob (string form). Public for tests and the MCP
/// reader (which duplicates this one function — see C2 / mcp-server tools).
pub fn parse_trace_str(raw: &str) -> Vec<TraceLine> {
    let mut out: Vec<TraceLine> = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<TraceLine>(trimmed) {
            Ok(parsed) => out.push(parsed),
            Err(e) => {
                tracing::warn!(
                    line_no = i + 1,
                    err = %e,
                    "trace: skipping malformed line"
                );
            }
        }
    }
    out
}

/// Slice of the trace needed to reconstruct messages for "replay from step
/// N". Returns every line with `seq < up_to_seq`. The caller is expected
/// to feed the prefix back to the model with the same provider/model.
///
/// Why "less than" not "less than or equal": replay-from-step-N means
/// **re-run** step N's `model_call`, so the prefix must end *before*
/// that line. Step N's `model_done` and downstream entries are
/// discarded — they're being replaced.
pub fn replay_prefix(run_dir: &Path, up_to_seq: u32) -> io::Result<Vec<TraceLine>> {
    let all = read_trace(run_dir)?;
    Ok(all.into_iter().filter(|l| l.seq < up_to_seq).collect())
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/// Truncate a tool result to `RESULT_TRUNCATE_CHARS` chars (UTF-8 safe —
/// uses `chars()` count, not bytes — so we don't split a multi-byte
/// codepoint mid-character on CJK text). Returns `(truncated_text,
/// was_truncated)`.
fn truncate_result(result: &str) -> (String, bool) {
    let count = result.chars().count();
    if count <= RESULT_TRUNCATE_CHARS {
        return (result.to_string(), false);
    }
    let mut out: String = result.chars().take(RESULT_TRUNCATE_CHARS).collect();
    out.push_str("…(truncated)");
    (out, true)
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Count how many lines are already in `trace.jsonl`. Used so a re-opened
/// emitter resumes `seq` at the right position.
fn count_existing_lines(path: &Path) -> io::Result<u32> {
    if !path.exists() {
        return Ok(0);
    }
    let raw = std::fs::read_to_string(path)?;
    let n = raw.lines().filter(|l| !l.trim().is_empty()).count();
    Ok(n as u32)
}

fn io_other<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::new(io::ErrorKind::Other, e.to_string())
}

fn io_poisoned() -> io::Error {
    io::Error::new(io::ErrorKind::Other, "trace mutex poisoned")
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fresh_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("solomd-trace-{label}-{nanos}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_basic_kinds() {
        let dir = fresh_dir("rt");
        let em = Emitter::open(&dir, "run-rt".into()).unwrap();
        em.run_started(RunKind::Panel, "anthropic", "claude-sonnet-4-6", None, None)
            .unwrap();
        em.prompt("user", "hello").unwrap();
        em.model_call("anthropic", "claude-sonnet-4-6", 1, 0).unwrap();
        em.model_done("hi there", 12, 7, "stop").unwrap();
        em.run_ended("ok", 12, 7, 0.0001, None).unwrap();
        drop(em);

        let lines = read_trace(&dir).unwrap();
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0].kind, "run_started");
        assert_eq!(lines[0].seq, 1);
        assert_eq!(lines[0].run_id, "run-rt");
        assert_eq!(lines[0].payload.get("provider").and_then(|v| v.as_str()), Some("anthropic"));
        // Renamed key — `run_kind` not `kind`, so the run-level kind doesn't
        // collide with the line-level kind.
        assert_eq!(lines[0].payload.get("run_kind").and_then(|v| v.as_str()), Some("panel"));

        assert_eq!(lines[1].kind, "prompt");
        assert_eq!(lines[1].seq, 2);
        assert_eq!(lines[2].kind, "model_call");
        assert_eq!(lines[3].kind, "model_done");
        assert_eq!(lines[3].payload.get("tokens_in").and_then(|v| v.as_u64()), Some(12));
        assert_eq!(lines[4].kind, "run_ended");
        // ts is monotonic-ish — at least non-decreasing.
        for w in lines.windows(2) {
            assert!(w[1].ts >= w[0].ts);
            assert_eq!(w[1].seq, w[0].seq + 1);
        }
    }

    #[test]
    fn tool_result_truncation_at_2048_chars() {
        let dir = fresh_dir("trunc");
        let em = Emitter::open(&dir, "run-tr".into()).unwrap();
        em.run_started(RunKind::Panel, "anthropic", "claude-sonnet-4-6", None, None)
            .unwrap();
        em.tool_call("read_note", "tc_abc", &serde_json::json!({"path": "x.md"}))
            .unwrap();
        // 3000-char ASCII payload — must clamp to 2048 chars + "…(truncated)".
        let big = "x".repeat(3000);
        em.tool_result("tc_abc", &big, None).unwrap();
        drop(em);

        let lines = read_trace(&dir).unwrap();
        let res = lines.iter().find(|l| l.kind == "tool_result").unwrap();
        assert_eq!(res.payload.get("truncated").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(res.payload.get("result_bytes").and_then(|v| v.as_u64()), Some(3000));
        let written = res.payload.get("result").and_then(|v| v.as_str()).unwrap();
        // 2048 chars of payload + the 12-char "…(truncated)" marker.
        assert!(written.starts_with("xxxxxxxxxxx"));
        assert!(written.ends_with("…(truncated)"));
        let payload_chars = written.chars().count();
        assert_eq!(
            payload_chars,
            RESULT_TRUNCATE_CHARS + "…(truncated)".chars().count()
        );
    }

    #[test]
    fn tool_result_no_truncation_when_under_limit() {
        let dir = fresh_dir("nottrunc");
        let em = Emitter::open(&dir, "run-no".into()).unwrap();
        em.tool_result("tc_short", "short body", None).unwrap();
        drop(em);
        let lines = read_trace(&dir).unwrap();
        let res = &lines[0];
        // truncated is omitted (or false); we use `is_none`-or-`false`.
        let trunc = res.payload.get("truncated").and_then(|v| v.as_bool()).unwrap_or(false);
        assert!(!trunc);
        assert_eq!(res.payload.get("result").and_then(|v| v.as_str()), Some("short body"));
    }

    #[test]
    fn tool_result_truncation_is_utf8_safe_on_cjk() {
        // Each CJK char is 3 UTF-8 bytes. 3000 chars → 9000 bytes. We clamp
        // by char-count, so the boundary must not split a codepoint.
        let dir = fresh_dir("cjk");
        let em = Emitter::open(&dir, "run-cjk".into()).unwrap();
        let big: String = "中".repeat(3000);
        em.tool_result("tc_cjk", &big, None).unwrap();
        drop(em);
        let lines = read_trace(&dir).unwrap();
        let res = &lines[0];
        let written = res.payload.get("result").and_then(|v| v.as_str()).unwrap();
        // 2048 "中" + the marker. No replacement char, no split codepoints.
        assert!(!written.contains('\u{FFFD}'));
        assert!(written.starts_with("中中中"));
        assert!(written.ends_with("…(truncated)"));
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let dir = fresh_dir("malformed");
        // Hand-write a file with mixed valid/invalid lines.
        let path = dir.join("trace.jsonl");
        let body = r#"{"ts":1,"run_id":"r","seq":1,"kind":"prompt","role":"user","content":"hi"}
{not a real json line}
{"ts":2,"run_id":"r","seq":2,"kind":"note","text":"after garbage"}
"#;
        fs::write(&path, body).unwrap();
        let lines = read_trace(&dir).unwrap();
        // The garbage line is skipped; the surrounding two survive.
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].seq, 1);
        assert_eq!(lines[1].seq, 2);
        assert_eq!(lines[1].kind, "note");
    }

    #[test]
    fn replay_prefix_returns_lines_strictly_before_seq() {
        let dir = fresh_dir("replay");
        let em = Emitter::open(&dir, "run-rp".into()).unwrap();
        em.run_started(RunKind::Panel, "anthropic", "claude-sonnet-4-6", None, None)
            .unwrap(); // seq 1
        em.prompt("user", "first").unwrap(); // seq 2
        em.model_call("anthropic", "claude-sonnet-4-6", 1, 0).unwrap(); // seq 3
        em.model_done("a1", 5, 5, "stop").unwrap(); // seq 4
        em.prompt("user", "second").unwrap(); // seq 5
        em.model_call("anthropic", "claude-sonnet-4-6", 3, 0).unwrap(); // seq 6
        drop(em);

        // Replay from seq=6 (the second model_call). Prefix should be 1..=5.
        let prefix = replay_prefix(&dir, 6).unwrap();
        assert_eq!(prefix.len(), 5);
        assert_eq!(prefix.last().unwrap().seq, 5);
        assert_eq!(prefix.last().unwrap().kind, "prompt");
    }

    #[test]
    fn reopen_resumes_seq_from_existing_count() {
        let dir = fresh_dir("resume");
        let em = Emitter::open(&dir, "run-resume".into()).unwrap();
        em.note("first").unwrap(); // seq 1
        em.note("second").unwrap(); // seq 2
        drop(em);
        // Reopen; next note should be seq 3, not seq 1.
        let em = Emitter::open(&dir, "run-resume".into()).unwrap();
        em.note("third").unwrap();
        drop(em);
        let lines = read_trace(&dir).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2].seq, 3);
        assert_eq!(lines[2].payload.get("text").and_then(|v| v.as_str()), Some("third"));
    }

    #[test]
    fn payload_cannot_override_reserved_fields() {
        let dir = fresh_dir("reserved");
        let em = Emitter::open(&dir, "real-run".into()).unwrap();
        // Caller tries to spoof run_id / seq / kind. These must be ignored.
        em.append(
            TraceKind::Note,
            serde_json::json!({
                "ts": 1,
                "run_id": "EVIL",
                "seq": 999,
                "kind": "EVIL",
                "text": "hi",
            }),
        )
        .unwrap();
        drop(em);
        let lines = read_trace(&dir).unwrap();
        assert_eq!(lines[0].run_id, "real-run");
        assert_eq!(lines[0].seq, 1);
        assert_eq!(lines[0].kind, "note");
        assert_eq!(lines[0].payload.get("text").and_then(|v| v.as_str()), Some("hi"));
    }

    #[test]
    fn concurrent_appends_do_not_interleave() {
        // A single Emitter shared across threads — the supported pattern.
        // Each line must remain a complete JSON object on disk even with
        // 8 threads × 50 lines each.
        let dir = fresh_dir("concurrent");
        let em = Arc::new(Emitter::open(&dir, "run-c".into()).unwrap());
        let mut handles = Vec::new();
        for t in 0..8 {
            let em = em.clone();
            handles.push(thread::spawn(move || {
                for i in 0..50 {
                    em.note(&format!("t{t}-i{i}")).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        drop(em);
        let lines = read_trace(&dir).unwrap();
        assert_eq!(lines.len(), 8 * 50);
        // seq is unique 1..=400 with no duplicates.
        let mut seqs: Vec<u32> = lines.iter().map(|l| l.seq).collect();
        seqs.sort_unstable();
        seqs.dedup();
        assert_eq!(seqs.len(), 8 * 50);
        assert_eq!(seqs[0], 1);
        assert_eq!(*seqs.last().unwrap(), 8 * 50);
    }

    #[test]
    fn parses_fixture_under_tests_dir() {
        // Reads the hand-written fixture shipped with the crate. Mirrors
        // what the MCP server will do over the same parser.
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("trace_sample");
        let lines = read_trace(&fixture).unwrap();
        // Fixture contains: run_started, prompt, model_call, tool_call,
        // tool_result, model_done, run_ended. Plus one intentionally
        // malformed line that must be skipped.
        assert_eq!(lines.len(), 7);
        assert_eq!(lines[0].kind, "run_started");
        assert_eq!(lines.last().unwrap().kind, "run_ended");
        let tool_call = lines.iter().find(|l| l.kind == "tool_call").unwrap();
        assert_eq!(
            tool_call.payload.get("tool").and_then(|v| v.as_str()),
            Some("read_note"),
        );
    }
}
