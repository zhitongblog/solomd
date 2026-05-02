//! v4.0 Pillar 2 — recipe runner + trigger dispatcher.
//!
//! Responsibilities:
//!   1. Loading recipes for the active workspace and watching
//!      `.solomd/agents/` for changes (`State::reload`).
//!   2. Hooking save / commit / cron / manual triggers and dispatching to
//!      `run_recipe`.
//!   3. Driving one recipe: mint a run id, create the AutoGit branch,
//!      check it out, hand off to the canonical `ai_chat` tool-call loop
//!      in `ai_proxy.rs`, then commit any working-tree changes onto the
//!      agent branch and restore HEAD to main.
//!
//! ## Integration with `ai_proxy::ai_chat`
//!
//! The chat machinery lives in `ai_proxy`: `run_chat_anthropic_loop`,
//! `run_chat_openai_loop`, and `run_chat_ollama` each own a multi-turn
//! tool-call loop that emits the same `solomd://ai-*` events the panel
//! listens for and writes the same `trace.jsonl`/`run.md` artifacts the
//! recipes UI consumes. We pass our own `RunHandle` into the loop so
//! every model_call / tool_call / tool_result lands in the recipe's run
//! directory, and we mint a `request-id` namespaced as `recipe-<run-id>`
//! so the panel's listeners ignore our chunks.
//!
//! Recipes enforce a per-run write cap via the registry exposed by
//! `agent_tools::install_recipe_write_cap`; the chat loop's calls into
//! `dispatch_tool` consult that registry on every `write_note` /
//! `append_to_note` invocation and refuse cleanly once the recipe has
//! used its allotment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use git2::{BranchType, Repository, ResetType, StatusOptions};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::agent_run::{self, RecipeMeta, RunHandle, RunMeta, RunStatus, TokenCounts};
use super::agent_tools;
use super::ai_proxy::{
    self, resolve_provider, run_chat_anthropic_loop, run_chat_ollama, run_chat_openai_loop,
    ChatMessage, ChatRequest,
};
use super::recipes::{
    self, Recipe, TriggerCtx, TriggerKind, WRITE_CAP_MAX,
};

// ---------------------------------------------------------------------------
// Run-id validation — Tauri commands that accept a `run_id` join it onto
// a path (`.solomd/agent-runs/<run_id>/...`) and so MUST refuse anything
// that could escape the run directory. The REST API in `rest_api.rs` does
// the same check for the same reason; we keep the rules consistent.
// ---------------------------------------------------------------------------

/// Accept only run ids matching `YYYYMMDD-HHMMSS-<6 hex>` (the canonical
/// shape minted by `recipes::mint_run_id`). Rejects empty input, any path
/// separator, `..`, and anything outside the alphabet `[0-9a-f-]`.
///
/// Public so the integration test in `tests/recipes_e2e_test.rs` can
/// exercise it without a Tauri runtime.
pub fn validate_run_id(run_id: &str) -> Result<&str, String> {
    if run_id.is_empty() {
        return Err("bad run id: empty".to_string());
    }
    // Cheap substring guards first — same as rest_api.rs uses.
    if run_id.contains('/') || run_id.contains('\\') || run_id.contains("..") {
        return Err("bad run id: path traversal".to_string());
    }
    // Canonical shape: 8 digits "-" 6 digits "-" 6 hex (lowercase).
    let bytes = run_id.as_bytes();
    if bytes.len() != 8 + 1 + 6 + 1 + 6 {
        return Err("bad run id: wrong length".to_string());
    }
    if bytes[8] != b'-' || bytes[15] != b'-' {
        return Err("bad run id: missing separators".to_string());
    }
    for (i, b) in bytes.iter().enumerate() {
        let ok = match i {
            0..=7 | 9..=14 => b.is_ascii_digit(),
            16..=21 => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
            _ => *b == b'-',
        };
        if !ok {
            return Err("bad run id: invalid character".to_string());
        }
    }
    Ok(run_id)
}

// ---------------------------------------------------------------------------
// Shared state — one instance per app.
// ---------------------------------------------------------------------------

/// Per-workspace runtime state. Tracks the loaded recipes, the in-flight
/// runs (for the cooldown rule in C4.3), and a baseline of file→tags
/// observed at last save (used by the on-tag-add trigger).
#[derive(Default)]
pub struct RecipesState {
    pub workspace: Mutex<Option<PathBuf>>,
    pub recipes: Mutex<Vec<Recipe>>,
    pub recipe_errors: Mutex<Vec<String>>,
    /// recipe slug → run_id of the currently executing run. Used to drop
    /// overlapping triggers (C4.3 cooldown).
    pub running: Mutex<HashMap<String, String>>,
    /// abs path → tags last observed. Populated lazily by the on-save
    /// hook so the on-tag-add trigger can compute "newly added" without
    /// a second read.
    pub last_tags: Mutex<HashMap<String, Vec<String>>>,
    /// Cron loop's wakeup channel. Set to true by `reload` to nudge the
    /// loop into recomputing the next-fire time. Currently unused — the
    /// loop polls every 60s — but reserved for future signalling so the
    /// field shows up in the public state shape.
    #[allow(dead_code)]
    pub cron_kick: Mutex<bool>,
}

impl RecipesState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — recipes_list / recipes_save / recipes_delete / etc.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RecipeSummary {
    pub name: String,
    pub slug: String,
    pub path: String,
    pub trigger: String,
    pub schedule: Option<String>,
    pub match_glob: Option<String>,
    pub tag: Option<String>,
    pub allow_write: bool,
    pub write_cap: u32,
    pub provider: String,
    pub model: String,
    /// Last run status string for display. None when no run yet.
    pub last_run_status: Option<String>,
    pub last_run_id: Option<String>,
    pub last_run_started_at: Option<i64>,
}

fn summarise(recipe: &Recipe, last: Option<&RunMeta>) -> RecipeSummary {
    RecipeSummary {
        name: recipe.name.clone(),
        slug: recipe.slug.clone(),
        path: recipe
            .path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        trigger: recipe.trigger.as_str().to_string(),
        schedule: recipe.schedule.clone(),
        match_glob: recipe.match_glob.clone(),
        tag: recipe.tag.clone(),
        allow_write: recipe.allow_write,
        write_cap: recipe.write_cap,
        provider: recipe.provider.clone(),
        model: recipe.model.clone(),
        last_run_status: last.map(|m| m.status.clone()),
        last_run_id: last.map(|m| m.run_id.clone()),
        last_run_started_at: last.map(|m| m.started_at),
    }
}

#[tauri::command]
pub async fn recipes_list(
    app: AppHandle,
    workspace: String,
) -> Result<Vec<RecipeSummary>, String> {
    let state = app.state::<RecipesState>();
    let ws_path = PathBuf::from(&workspace);
    let (recipes, errors) = recipes::load_recipes(&ws_path);
    *state.recipe_errors.lock().unwrap() = errors;
    *state.workspace.lock().unwrap() = Some(ws_path.clone());
    let runs = agent_run::list_runs(&ws_path);
    let last_per_recipe: HashMap<String, &RunMeta> = {
        let mut m: HashMap<String, &RunMeta> = HashMap::new();
        for r in &runs {
            if let Some(rec) = &r.recipe {
                m.entry(rec.name.clone()).or_insert(r);
            }
        }
        m
    };
    let summaries: Vec<RecipeSummary> = recipes
        .iter()
        .map(|r| summarise(r, last_per_recipe.get(&r.name).copied()))
        .collect();
    *state.recipes.lock().unwrap() = recipes;
    Ok(summaries)
}

#[tauri::command]
pub async fn recipes_get(workspace: String, slug: String) -> Result<String, String> {
    let dir = recipes::agents_dir(Path::new(&workspace));
    for ext in ["yml", "yaml"] {
        let p = dir.join(format!("{slug}.{ext}"));
        if p.exists() {
            return std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))
        }
    }
    Err(format!("recipe not found: {slug}"))
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveRecipeRequest {
    pub workspace: String,
    /// Raw YAML — written verbatim. The parser still validates it.
    pub yaml: String,
    /// Optional override: when not provided, slug is derived from
    /// `name:` inside the YAML.
    #[serde(default)]
    pub slug: Option<String>,
}

#[tauri::command]
pub async fn recipes_save(req: SaveRecipeRequest) -> Result<String, String> {
    let recipe = recipes::parse_recipe(&req.yaml, None)?;
    let dir = recipes::agents_dir(Path::new(&req.workspace));
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let slug = req.slug.unwrap_or(recipe.slug);
    let path = dir.join(format!("{slug}.yml"));
    std::fs::write(&path, &req.yaml).map_err(|e| format!("write: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn recipes_delete(workspace: String, slug: String) -> Result<(), String> {
    recipes::delete_recipe(Path::new(&workspace), &slug)
}

// ---------------------------------------------------------------------------
// Manual run-now
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn recipes_run_now(
    app: AppHandle,
    workspace: String,
    slug: String,
) -> Result<String, String> {
    let ws = PathBuf::from(&workspace);
    let (recipes, _errs) = recipes::load_recipes(&ws);
    let recipe = recipes
        .into_iter()
        .find(|r| r.slug == slug)
        .ok_or_else(|| format!("recipe not found: {slug}"))?;
    let ctx = TriggerCtx {
        workspace: ws.clone(),
        ..Default::default()
    };
    let result = run_recipe(&app, &ws, &recipe, ctx).await?;
    Ok(result.run_id)
}

// ---------------------------------------------------------------------------
// Pending-run accept / reject
// ---------------------------------------------------------------------------

/// List recipe runs whose status is `ok` and `accepted == None` — these
/// are the pending-review entries pinned to the top of the Recipes panel.
/// Panel chat runs (kind == "panel") never need accept/reject because they
/// don't write to an AutoGit branch — they're filtered out here.
#[tauri::command]
pub async fn recipes_pending_runs(workspace: String) -> Result<Vec<RunMeta>, String> {
    let runs = agent_run::list_runs(Path::new(&workspace));
    Ok(runs
        .into_iter()
        .filter(|r| r.kind == "recipe" && r.status == "ok" && r.accepted.is_none())
        .collect())
}

/// History tab in the Recipes panel — only shows recipe runs (panel chats
/// have their own listing under AI settings).
#[tauri::command]
pub async fn recipes_history(workspace: String) -> Result<Vec<RunMeta>, String> {
    Ok(agent_run::list_runs(Path::new(&workspace))
        .into_iter()
        .filter(|r| r.kind == "recipe")
        .collect())
}

#[tauri::command]
pub async fn recipes_read_trace(workspace: String, run_id: String) -> Result<String, String> {
    validate_run_id(&run_id)?;
    agent_run::read_trace(Path::new(&workspace), &run_id)
}

#[tauri::command]
pub async fn recipes_read_run_md(workspace: String, run_id: String) -> Result<String, String> {
    validate_run_id(&run_id)?;
    agent_run::read_run_md(Path::new(&workspace), &run_id)
}

/// Diff between the agent branch and `main`. Returns the unified diff
/// text — the UI renders it in a `<pre>` block. Implementation re-uses
/// libgit2 directly rather than shelling out to `git diff`.
#[tauri::command]
pub async fn recipes_run_diff(workspace: String, run_id: String) -> Result<String, String> {
    validate_run_id(&run_id)?;
    let ws = PathBuf::from(&workspace);
    let meta = agent_run::read_run_meta(&ws, &run_id)?;
    let recipe = meta
        .recipe
        .as_ref()
        .ok_or_else(|| "run is not a recipe run".to_string())?;
    let branch = recipe.branch.clone();
    tauri::async_runtime::spawn_blocking(move || diff_branch_against_main(&ws, &branch))
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn diff_branch_against_main(workspace: &Path, branch: &str) -> Result<String, String> {
    let repo = Repository::open(workspace).map_err(|e| format!("git open: {e}"))?;
    let main_ref = match repo.find_branch("main", BranchType::Local) {
        Ok(b) => b.into_reference(),
        Err(_) => repo
            .find_branch("master", BranchType::Local)
            .map_err(|e| format!("no main/master branch: {e}"))?
            .into_reference(),
    };
    let main_commit = main_ref
        .peel_to_commit()
        .map_err(|e| format!("peel main: {e}"))?;
    let main_tree = main_commit.tree().map_err(|e| format!("main tree: {e}"))?;

    let agent_ref = repo
        .find_branch(branch, BranchType::Local)
        .map_err(|e| format!("agent branch not found: {e}"))?
        .into_reference();
    let agent_commit = agent_ref
        .peel_to_commit()
        .map_err(|e| format!("peel agent: {e}"))?;
    let agent_tree = agent_commit.tree().map_err(|e| format!("agent tree: {e}"))?;

    let diff = repo
        .diff_tree_to_tree(Some(&main_tree), Some(&agent_tree), None)
        .map_err(|e| format!("diff: {e}"))?;

    let mut buf = String::new();
    diff.print(git2::DiffFormat::Patch, |_d, _h, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            buf.push(origin);
        }
        if let Ok(s) = std::str::from_utf8(line.content()) {
            buf.push_str(s);
        }
        true
    })
    .map_err(|e| format!("diff print: {e}"))?;
    Ok(buf)
}

#[tauri::command]
pub async fn recipes_accept_run(
    workspace: String,
    run_id: String,
) -> Result<(), String> {
    validate_run_id(&run_id)?;
    let ws = PathBuf::from(&workspace);
    let mut meta = agent_run::read_run_meta(&ws, &run_id)?;
    let branch = meta
        .recipe
        .as_ref()
        .map(|r| r.branch.clone())
        .ok_or_else(|| "run is not a recipe run".to_string())?;
    tauri::async_runtime::spawn_blocking({
        let ws = ws.clone();
        move || merge_branch_into_main(&ws, &branch)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    meta.accepted = Some(true);
    meta.status = "accepted".to_string();
    agent_run::write_run_meta(&ws, &run_id, &meta)?;
    Ok(())
}

#[tauri::command]
pub async fn recipes_reject_run(
    workspace: String,
    run_id: String,
) -> Result<(), String> {
    validate_run_id(&run_id)?;
    let ws = PathBuf::from(&workspace);
    let mut meta = agent_run::read_run_meta(&ws, &run_id)?;
    let branch = meta
        .recipe
        .as_ref()
        .map(|r| r.branch.clone())
        .ok_or_else(|| "run is not a recipe run".to_string())?;
    tauri::async_runtime::spawn_blocking({
        let ws = ws.clone();
        move || delete_branch(&ws, &branch)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    meta.accepted = Some(false);
    meta.status = "rejected".to_string();
    agent_run::write_run_meta(&ws, &run_id, &meta)?;
    Ok(())
}

fn merge_branch_into_main(workspace: &Path, branch: &str) -> Result<(), String> {
    let repo = Repository::open(workspace).map_err(|e| format!("git open: {e}"))?;
    // Locate target ("main" first, "master" as fallback).
    let main_name = if repo.find_branch("main", BranchType::Local).is_ok() {
        "main"
    } else {
        "master"
    };
    // Fetch the target commits.
    let agent_commit = repo
        .find_branch(branch, BranchType::Local)
        .map_err(|e| format!("agent branch missing: {e}"))?
        .get()
        .peel_to_commit()
        .map_err(|e| format!("peel agent: {e}"))?;
    let main_commit = repo
        .find_branch(main_name, BranchType::Local)
        .map_err(|e| format!("main branch missing: {e}"))?
        .get()
        .peel_to_commit()
        .map_err(|e| format!("peel main: {e}"))?;

    let merge_base = repo
        .merge_base(main_commit.id(), agent_commit.id())
        .map_err(|e| format!("merge_base: {e}"))?;

    if merge_base == agent_commit.id() {
        // Already up-to-date — nothing to do.
        return delete_branch(workspace, branch);
    }
    if merge_base == main_commit.id() {
        // Fast-forward main to agent_commit.
        let mut main_ref = repo
            .find_reference(&format!("refs/heads/{main_name}"))
            .map_err(|e| format!("main ref: {e}"))?;
        main_ref
            .set_target(agent_commit.id(), "agent run accepted")
            .map_err(|e| format!("ff main: {e}"))?;
        // Update the working tree to match main if main is currently
        // checked out. We don't switch HEAD branches here — if the user
        // is on the agent branch we leave them there.
        let head = repo.head().ok();
        let on_main = head
            .as_ref()
            .and_then(|h| h.shorthand())
            .map(|s| s == main_name)
            .unwrap_or(false);
        if on_main {
            repo.reset(agent_commit.as_object(), ResetType::Hard, None)
                .map_err(|e| format!("reset hard: {e}"))?;
        }
        return delete_branch(workspace, branch);
    }
    // Diverged — surface a clear error so the user can resolve manually.
    Err(format!(
        "branch {branch} has diverged from {main_name}; resolve manually with `git merge {branch}`"
    ))
}

fn delete_branch(workspace: &Path, branch: &str) -> Result<(), String> {
    let repo = Repository::open(workspace).map_err(|e| format!("git open: {e}"))?;
    let mut b = repo
        .find_branch(branch, BranchType::Local)
        .map_err(|e| format!("branch lookup: {e}"))?;
    // -D semantics: force-delete even if not merged. Same as
    // `git branch -D` per C4.2 (rejected runs hard-delete).
    b.delete().map_err(|e| format!("delete branch: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Trigger dispatch
// ---------------------------------------------------------------------------

/// Public entry point used by `commands::write_file` (P2 hooked via
/// `notify_save` — see the wrapper in `commands.rs`).
pub async fn dispatch_on_save(
    app: AppHandle,
    workspace: PathBuf,
    file_abs: String,
    new_tags: Vec<String>,
) {
    let state = app.state::<RecipesState>();
    let recipes = state.recipes.lock().unwrap().clone();
    let rel = relativize(&workspace, &file_abs).unwrap_or(file_abs.clone());
    // Compute newly-added tags by diffing against last_tags.
    let added_tags = {
        let mut last = state.last_tags.lock().unwrap();
        let prev = last.get(&file_abs).cloned().unwrap_or_default();
        last.insert(file_abs.clone(), new_tags.clone());
        recipes::newly_added_tags(&prev, &new_tags)
    };
    for recipe in recipes {
        match recipe.trigger {
            TriggerKind::OnSave => {
                if path_matches(&recipe, &rel) {
                    fire(&app, &workspace, &recipe, save_ctx(&workspace, &rel)).await;
                }
            }
            TriggerKind::OnTagAdd => {
                if let Some(target) = &recipe.tag {
                    if added_tags.iter().any(|t| t == target) {
                        // Honour optional `match:` filter on tag triggers too.
                        if recipe.match_glob.is_some() && !path_matches(&recipe, &rel) {
                            continue;
                        }
                        let mut ctx = save_ctx(&workspace, &rel);
                        ctx.trigger_tag = Some(target.clone());
                        fire(&app, &workspace, &recipe, ctx).await;
                    }
                }
            }
            _ => {}
        }
    }
}

/// Public entry — called by `git_history::git_auto_commit` after a
/// successful AutoGit commit. We don't have an exact list of touched
/// files in the Tauri command surface, so the contract here is
/// approximate: we fire any `on-commit` recipe whose glob matches the
/// (single-file) save path that just happened. Multi-file commits
/// trigger once per recipe, which is fine — recipes are idempotent.
pub async fn dispatch_on_commit(
    app: AppHandle,
    workspace: PathBuf,
    file_abs: Option<String>,
    sha: String,
) {
    let state = app.state::<RecipesState>();
    let recipes = state.recipes.lock().unwrap().clone();
    let rel = file_abs
        .as_ref()
        .and_then(|p| relativize(&workspace, p));
    for recipe in recipes {
        if recipe.trigger != TriggerKind::OnCommit {
            continue;
        }
        // If a glob is set, require a match (and a known file path).
        let allowed = match (&recipe.match_glob, &rel) {
            (Some(_), Some(r)) => path_matches(&recipe, r),
            (Some(_), None) => false,
            (None, _) => true,
        };
        if !allowed {
            continue;
        }
        let mut ctx = TriggerCtx {
            workspace: workspace.clone(),
            trigger_path: rel.clone(),
            trigger_sha: Some(sha.clone()),
            ..Default::default()
        };
        ctx.workspace = workspace.clone();
        fire(&app, &workspace, &recipe, ctx).await;
    }
}

fn save_ctx(workspace: &Path, rel: &str) -> TriggerCtx {
    TriggerCtx {
        workspace: workspace.to_path_buf(),
        trigger_path: Some(rel.to_string()),
        ..Default::default()
    }
}

fn path_matches(recipe: &Recipe, rel: &str) -> bool {
    match recipe.compiled_match() {
        Some(m) => m.is_match(rel),
        None => false,
    }
}

fn relativize(workspace: &Path, file_abs: &str) -> Option<String> {
    let abs = Path::new(file_abs);
    abs.strip_prefix(workspace)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

async fn fire(app: &AppHandle, workspace: &Path, recipe: &Recipe, ctx: TriggerCtx) {
    let app_clone = app.clone();
    let ws = workspace.to_path_buf();
    let recipe = recipe.clone();
    // Detach so the trigger source returns immediately.
    tauri::async_runtime::spawn(async move {
        let _ = run_recipe(&app_clone, &ws, &recipe, ctx).await;
    });
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub run_id: String,
    pub branch: String,
    pub status: String,
}

/// RAII guard for the per-recipe cooldown slot in `RecipesState::running`.
/// Any panic between insertion and removal would otherwise leak the slot
/// — that recipe would then be permanently blocked by cooldown until the
/// daemon restarted, with no UI feedback. The guard's `Drop` impl runs on
/// every exit path (including panic unwind) and frees the slot.
struct CooldownGuard<'a> {
    state: &'a RecipesState,
    slug: String,
}

impl Drop for CooldownGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.state.running.lock() {
            running.remove(&self.slug);
        }
    }
}

/// Detect any uncommitted changes in the workspace (dirty WIP). We
/// exclude IGNORED paths but include both tracked-modified and untracked.
/// Used at recipe start to refuse running while the user has WIP — the
/// AutoGit branch sandbox would otherwise migrate that WIP onto the agent
/// branch and a force-restore at the end would silently destroy it.
///
/// Public so the integration test in `tests/recipes_e2e_test.rs` can
/// exercise the dirty-detection logic without a Tauri runtime.
pub fn workspace_has_dirty_changes(workspace: &Path) -> Result<bool, String> {
    let repo = Repository::open(workspace).map_err(|e| format!("git open: {e}"))?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("git statuses: {e}"))?;
    for entry in statuses.iter() {
        let st = entry.status();
        if !st.is_empty() && !st.contains(git2::Status::IGNORED) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Drive a single recipe end-to-end:
///   1. cooldown check
///   2. mint run id + create AutoGit branch
///   3. `RunHandle::create` writes meta.json + run.md header
///   4. resolve prompt + emit `prompt` step
///   5. hand off to `ai_proxy`'s tool-call loop with the recipe's
///      provider / model / tools / write-cap installed, pre-checking out
///      the agent branch so writes land in its working tree
///   6. sweep working-tree changes into a single commit on the agent
///      branch and emit `git_commit` trace step
///   7. restore HEAD to main and finalize meta.json
pub async fn run_recipe(
    app: &AppHandle,
    workspace: &Path,
    recipe: &Recipe,
    mut ctx: TriggerCtx,
) -> Result<RunResult, String> {
    let state = app.state::<RecipesState>();

    // Cooldown — drop overlapping runs of the same recipe (C4.3). We
    // also leave a `note` step in the still-running trace so the user
    // sees we noticed the trigger.
    let dropped = {
        let mut running = state.running.lock().unwrap();
        if let Some(active_id) = running.get(&recipe.slug).cloned() {
            Some(active_id)
        } else {
            // Reserve our slot before creating files so a second trigger
            // can't slip past us.
            running.insert(recipe.slug.clone(), String::new());
            None
        }
    };
    if let Some(active_id) = dropped {
        // Append a note step to the active run's trace if it still
        // exists. Best-effort; if the file's gone we silently drop.
        if let Ok(meta) = agent_run::read_run_meta(workspace, &active_id) {
            let _ = (meta,);
        }
        let trace_path = workspace
            .join(".solomd")
            .join("agent-runs")
            .join(&active_id)
            .join("trace.jsonl");
        if trace_path.exists() {
            let line = serde_json::json!({
                "ts": chrono::Utc::now().timestamp_millis(),
                "run_id": active_id,
                "kind": "note",
                "text": format!("trigger fired for {} but cooldown active; dropped", recipe.slug),
            })
            .to_string();
            let _ = std::fs::OpenOptions::new()
                .append(true)
                .open(&trace_path)
                .and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "{line}")
                });
        }
        return Err(format!(
            "recipe '{}' is already running; trigger dropped (cooldown)",
            recipe.slug
        ));
    }

    // From this point on the slot is reserved. The guard's Drop ensures
    // we release it on every exit path — including panic unwind — so a
    // panicking task can never permanently lock the recipe out.
    let _cooldown_guard = CooldownGuard {
        state: &*state,
        slug: recipe.slug.clone(),
    };

    // Refuse to start when the user has uncommitted WIP. The AutoGit
    // branch sandbox migrates uncommitted edits onto the agent branch
    // (CheckoutBuilder::safe), the commit_branch_changes sweep would
    // then add_all("*") them into the agent's commit, and restore_head's
    // force checkout would silently destroy any surviving WIP. Refusing
    // up-front closes that data-loss window cleanly.
    match workspace_has_dirty_changes(workspace) {
        Ok(true) => {
            let err = "workspace has uncommitted changes; commit or stash before running recipes".to_string();
            // Surface a stub run-finished event so the UI history shows
            // the refusal — there's no run dir yet, but the listener only
            // re-fetches state so the payload shape is best-effort.
            let stub = serde_json::json!({
                "kind": "recipe",
                "status": "error",
                "error": err,
                "recipe": { "name": recipe.name, "slug": recipe.slug },
            });
            let _ = app.emit("solomd://recipes-run-finished", &stub);
            return Err(err);
        }
        Ok(false) => {}
        Err(e) => {
            // Repo missing / unreadable — surfaces later in
            // create_agent_branch with a clearer message; let it through.
            let _ = e;
        }
    }

    let run_id = recipes::mint_run_id(Utc::now());
    // Replace our placeholder slot now that we have the real run id.
    {
        let mut running = state.running.lock().unwrap();
        running.insert(recipe.slug.clone(), run_id.clone());
    }
    ctx.workspace = workspace.to_path_buf();

    let branch_name = format!("agent/{}/{}", recipe.slug, run_id);

    // Create the agent branch off HEAD. If this fails we abort early —
    // no run dir is created. The cooldown slot is freed automatically by
    // `_cooldown_guard` going out of scope on return.
    create_agent_branch(workspace, &branch_name)?;

    // Build initial meta.
    let now = Utc::now().timestamp();
    let meta = RunMeta {
        run_id: run_id.clone(),
        kind: "recipe".to_string(),
        started_at: now,
        ended_at: None,
        status: RunStatus::Running.as_str().to_string(),
        workspace: workspace.to_string_lossy().to_string(),
        provider: provider_for(recipe),
        model: recipe.model.clone(),
        recipe: Some(RecipeMeta {
            name: recipe.name.clone(),
            path: recipe
                .path
                .as_ref()
                .and_then(|p| p.strip_prefix(workspace).ok().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_else(|| format!(".solomd/agents/{}.yml", recipe.slug)),
            trigger: recipe.trigger.as_str().to_string(),
            branch: branch_name.clone(),
        }),
        tokens: TokenCounts::default(),
        cost_usd_estimate: 0.0,
        error: None,
        accepted: None,
    };

    // Cooldown slot is freed automatically by `_cooldown_guard` if we
    // bail here.
    let handle = Arc::new(RunHandle::create(workspace, &run_id, meta.clone())?);

    // Emit run_started + prompt steps.
    let _ = handle.emit_run_started(&meta);
    let prompt_resolved = recipe.resolved_prompt(&ctx);
    let _ = handle.append_step(serde_json::json!({
        "kind": "prompt",
        "role": "user",
        "content": prompt_resolved,
    }));
    let _ = handle.append_markdown(&format!("## Prompt\n\n{prompt_resolved}\n\n"));

    // Hand off to the canonical chat loop in `ai_proxy`. The loop is
    // responsible for emitting `model_call` / `model_done` / `tool_call`
    // / `tool_result` lines onto the run handle's trace; we don't write
    // those here.
    let final_meta_arc = Arc::new(Mutex::new(meta));
    let exec = run_recipe_chat_loop(
        app,
        workspace,
        recipe,
        &prompt_resolved,
        Arc::clone(&handle),
        Arc::clone(&final_meta_arc),
        &branch_name,
        &run_id,
    )
    .await;

    let mut final_meta = final_meta_arc.lock().unwrap().clone();
    final_meta.ended_at = Some(Utc::now().timestamp());
    match exec {
        Ok(()) => {
            final_meta.status = RunStatus::Ok.as_str().to_string();
        }
        Err(e) => {
            final_meta.status = RunStatus::Error.as_str().to_string();
            final_meta.error = Some(e.clone());
        }
    }
    let _ = handle.emit_run_ended(&final_meta);
    let _ = handle.finalize(&final_meta);

    // Emit a UI event so the Recipes panel can refresh without polling.
    let _ = app.emit("solomd://recipes-run-finished", &final_meta);

    // Cooldown slot is released by `_cooldown_guard`'s Drop on return.

    Ok(RunResult {
        run_id: run_id.clone(),
        branch: branch_name,
        status: final_meta.status,
    })
}

fn provider_for(recipe: &Recipe) -> String {
    let p = recipe.provider.trim();
    // C6 — `provider: local` is an alias for `ollama`.
    if p == "local" {
        return "ollama".to_string();
    }
    if p.is_empty() {
        // Default: keep blank so the consumer's fallback path picks the
        // user's default. We surface `unknown` in UI sorting; the actual
        // call below resolves a real provider via `chat_request`.
        "".to_string()
    } else {
        p.to_string()
    }
}

/// Test-friendly skeleton: do everything `run_recipe` does *up to* the
/// LLM call — mint id, create branch, open a `RunHandle`, emit
/// `run_started` + `prompt`. Returns the handle and the meta so the
/// caller (a test, or the full runner) can decide what to do next.
/// Public so the integration test in `tests/recipes_e2e_test.rs` can
/// reach in without needing a Tauri runtime.
#[allow(dead_code)]
pub fn prepare_run(
    workspace: &Path,
    recipe: &Recipe,
    ctx: &TriggerCtx,
) -> Result<(RunHandle, RunMeta, String), String> {
    let run_id = recipes::mint_run_id(Utc::now());
    let branch_name = format!("agent/{}/{}", recipe.slug, run_id);
    create_agent_branch(workspace, &branch_name)?;
    let meta = RunMeta {
        run_id: run_id.clone(),
        kind: "recipe".to_string(),
        started_at: Utc::now().timestamp(),
        ended_at: None,
        status: RunStatus::Running.as_str().to_string(),
        workspace: workspace.to_string_lossy().to_string(),
        provider: provider_for(recipe),
        model: recipe.model.clone(),
        recipe: Some(RecipeMeta {
            name: recipe.name.clone(),
            path: recipe
                .path
                .as_ref()
                .and_then(|p| p.strip_prefix(workspace).ok().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_else(|| format!(".solomd/agents/{}.yml", recipe.slug)),
            trigger: recipe.trigger.as_str().to_string(),
            branch: branch_name.clone(),
        }),
        tokens: TokenCounts::default(),
        cost_usd_estimate: 0.0,
        error: None,
        accepted: None,
    };
    let handle = RunHandle::create(workspace, &run_id, meta.clone())?;
    handle.emit_run_started(&meta)?;
    let prompt = recipe.resolved_prompt(ctx);
    handle.append_step(serde_json::json!({
        "kind": "prompt",
        "role": "user",
        "content": prompt,
    }))?;
    handle.append_markdown(&format!("## Prompt\n\n{prompt}\n\n"))?;
    Ok((handle, meta, branch_name))
}

/// Test-friendly counterpart to `run_recipe`'s tail: emit a `run_ended`
/// step + finalize meta.json. Public for the same reason as `prepare_run`.
#[allow(dead_code)]
pub fn finalize_run(handle: &RunHandle, mut meta: RunMeta, status: RunStatus, error: Option<String>) -> Result<RunMeta, String> {
    meta.ended_at = Some(Utc::now().timestamp());
    meta.status = status.as_str().to_string();
    meta.error = error;
    handle.emit_run_ended(&meta)?;
    handle.finalize(&meta)?;
    Ok(meta)
}

/// Test-friendly write helper: enforce write-cap, write the file,
/// commit on the agent branch, and emit a `git_commit` trace step. Used
/// by the integration test to exercise the AutoGit branch sandbox
/// without spinning up a real LLM.
#[allow(dead_code)]
pub fn agent_write_note(
    workspace: &Path,
    branch: &str,
    handle: &RunHandle,
    rel_path: &str,
    content: &str,
    write_count: &mut u32,
    cap: u32,
) -> Result<String, String> {
    if *write_count >= cap.min(WRITE_CAP_MAX) {
        let _ = handle.append_step(serde_json::json!({
            "kind": "tool_result",
            "tool_call_id": format!("tc_{write_count}"),
            "result": "",
            "error": "write-cap exceeded",
        }));
        return Err("write-cap exceeded".to_string());
    }
    *write_count += 1;
    let abs = workspace.join(rel_path);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(&abs, content).map_err(|e| format!("write: {e}"))?;
    let sha = commit_on_branch(workspace, branch, rel_path, &format!("agent: write_note {rel_path}"))?;
    let _ = handle.append_step(serde_json::json!({
        "kind": "git_commit",
        "branch": branch,
        "sha": sha,
        "summary": format!("agent: write_note {rel_path}"),
        "files": [rel_path],
    }));
    Ok(sha)
}

/// Create branch `agent/<slug>/<run-id>` off the current HEAD. Refuses
/// if the workspace isn't a git repo (AutoGit not initialised).
fn create_agent_branch(workspace: &Path, branch: &str) -> Result<(), String> {
    let repo = Repository::open(workspace).map_err(|e| {
        format!(
            "agent runs require AutoGit — git_init_workspace this folder first ({e})"
        )
    })?;
    let head = repo
        .head()
        .map_err(|e| format!("HEAD missing — workspace has no commits yet: {e}"))?;
    let oid = head.target().ok_or_else(|| "HEAD has no target".to_string())?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("find HEAD commit: {e}"))?;
    repo.branch(branch, &commit, false)
        .map_err(|e| format!("create branch {branch}: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Recipe chat loop — bridges to `ai_proxy`'s canonical tool-call loop.
// ---------------------------------------------------------------------------
//
// The recipe runner does NOT own a chat implementation. It assembles a
// `ChatRequest` from the recipe's `provider` / `model` / `tools` /
// `allow-write` / `write-cap` / `base_url`, picks the right
// `run_chat_*_loop` based on `api_format`, and hands our `RunHandle` in
// so the trace + run.md keep accumulating into the recipe's run dir.
//
// AutoGit branch sandbox: per the architecture decision, we pre-checkout
// the agent branch BEFORE the chat loop. Tool calls (write_note /
// append_to_note) write directly into the working tree; after the loop
// returns we sweep up any working-tree changes into a single commit on
// the agent branch and then restore HEAD to main. The trade-off is that
// while a recipe is running the user's tabs may briefly see writes via
// the file watcher — the cure (a per-run branch override pushed through
// `dispatch_tool`) is much more invasive and was deferred. See:
//   TODO(v4-recipe-watcher): suppress watcher reloads on recipe writes.

#[allow(clippy::too_many_arguments)]
async fn run_recipe_chat_loop(
    app: &AppHandle,
    workspace: &Path,
    recipe: &Recipe,
    prompt: &str,
    handle: Arc<RunHandle>,
    meta_arc: Arc<Mutex<RunMeta>>,
    branch: &str,
    run_id: &str,
) -> Result<(), String> {
    // ----- 1. Resolve provider / api_format / model / api_key -----
    let provider = {
        let m = meta_arc.lock().unwrap();
        if m.provider.is_empty() {
            // No provider on the recipe and none in the meta — fall back
            // to anthropic so the call surfaces a clear "no key" error
            // rather than silently picking a default the user didn't ask
            // for. Same heuristic the shim used pre-merge.
            "anthropic".to_string()
        } else {
            m.provider.clone()
        }
    };
    let canonical_provider = resolve_provider(&provider).to_string();

    let api_format = if canonical_provider == "ollama" {
        "ollama".to_string()
    } else if canonical_provider == "claude" || canonical_provider == "anthropic" {
        "anthropic".to_string()
    } else {
        "openai".to_string()
    };

    let model = {
        let m = meta_arc.lock().unwrap();
        if m.model.is_empty() {
            match canonical_provider.as_str() {
                "anthropic" | "claude" => "claude-sonnet-4-6".to_string(),
                "ollama" => "qwen2.5:7b".to_string(),
                _ => "gpt-4.1-mini".to_string(),
            }
        } else {
            m.model.clone()
        }
    };

    // Reflect the resolved canonical names back into the run meta so the
    // history/trace UI sees the actual values dispatched.
    {
        let mut m = meta_arc.lock().unwrap();
        m.provider = canonical_provider.clone();
        m.model = model.clone();
    }

    let api_key = if api_format == "ollama" {
        String::new()
    } else {
        match ai_proxy::get_api_key(&canonical_provider) {
            Ok(k) => k,
            Err(e) => return Err(format!("recipe '{}' provider '{}': {e}", recipe.slug, canonical_provider)),
        }
    };

    // ----- 2. Build ChatRequest -----
    // System prompt mirrors the panel's contract for tool-enabled chats:
    // tell the model the tool registry it has and the write cap. The loop
    // itself materialises the tool schema array via `agent_tools`.
    let tools_list = recipe.tools.join(", ");
    let system_text = format!(
        "You are a SoloMD agent running a recipe ({}).\n\
         Allowed tools: {tools_list}.\n\
         Write-cap: {} (writes beyond this will be refused).\n\
         Use the tools to gather information and (when allow-write is set) save results.\n",
        recipe.name, recipe.write_cap
    );

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_text,
            tool_call_id: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
            tool_call_id: None,
        },
    ];

    let req = ChatRequest {
        provider: canonical_provider.clone(),
        api_format: Some(api_format.clone()),
        model: model.clone(),
        messages,
        base_url: recipe.base_url.clone(),
        tools: Some(recipe.tools.clone()),
        allow_write: Some(recipe.allow_write),
        run_id: Some(run_id.to_string()),
        workspace: Some(workspace.to_string_lossy().to_string()),
        // Bound the tool-loop independently of the write-cap. ai_proxy
        // already clamps to [1, 20]; pick a value that lets the model
        // recover from a few read tools before its writes.
        tool_loop_cap: Some(8),
        // Recipe runner doesn't pre-allocate a request id — let ai_proxy
        // mint one. The Agent Panel (frontend) is the consumer of this
        // field; recipes invoke ai_chat in-process and don't race events.
        request_id: None,
    };

    // ----- 3. Pre-checkout agent branch + install write-cap -----
    let prev_head = checkout_branch(workspace, branch)?;
    let cap = recipe.write_cap.min(WRITE_CAP_MAX);
    agent_tools::install_recipe_write_cap(workspace, cap);

    // ----- 4. Drive the loop -----
    // request_id: we namespace it under `recipe-` so panel listeners
    // ignore our chunk events. Cancellation is wired via Arc<AtomicBool>
    // (always false today; future cancel command will flip it). Token
    // counts are deliberately left at 0 — the sister worktree
    // `v4-fix/tokens` is rebasing in the real per-turn outcome accounting.
    let request_id = format!("recipe-{run_id}");
    let cancel = Arc::new(AtomicBool::new(false));

    let chat_result = match api_format.as_str() {
        "anthropic" => {
            run_chat_anthropic_loop(
                app,
                &request_id,
                &req,
                &api_key,
                cancel.clone(),
                Some(Arc::clone(&handle)),
            )
            .await
        }
        "openai" => {
            run_chat_openai_loop(
                app,
                &request_id,
                &req,
                &api_key,
                cancel.clone(),
                Some(Arc::clone(&handle)),
            )
            .await
        }
        "ollama" => {
            // Ollama path doesn't support tool-use today (see ai_proxy
            // comment) — degrades to a streaming text-only chat. Recipes
            // that need writes against Ollama will end up with status=ok
            // and zero commits. Surface this in run.md so the user sees
            // why nothing was committed.
            let _ = handle.append_markdown(
                "> note: ollama path is text-only — tool calls are not dispatched.\n\n",
            );
            run_chat_ollama(app, &request_id, &req, cancel.clone()).await
        }
        other => Err(format!("unknown api_format: {other}")),
    };

    // Final assistant text → append to run.md regardless of error so a
    // partial run is inspectable. Loop returns `(text, tokens_in, tokens_out)`
    // post-P9; we only need the text here, recipes don't surface per-run
    // tokens yet (panel chat does via meta.json's tokens block).
    let chat_result_text: Result<String, String> = match &chat_result {
        Ok((text, _ti, _to)) => Ok(text.clone()),
        Err(e) => Err(e.clone()),
    };
    if let Ok(text) = &chat_result_text {
        if !text.is_empty() {
            let _ = handle.append_markdown(&format!("## Assistant\n\n{text}\n\n"));
        }
    }

    // ----- 5. Commit any working-tree changes onto the agent branch -----
    // Even when the chat returned an error we still try to capture the
    // partial state — losing the trail is worse than a half-complete
    // commit. Committing happens BEFORE we pop the cap registry so the
    // commit message can mention how much of the cap was used.
    let writes_consumed = agent_tools::current_recipe_write_cap(workspace)
        .map(|(used, _cap)| used)
        .unwrap_or(0);

    if let Err(e) = commit_branch_changes(workspace, branch, &handle, recipe, writes_consumed) {
        // Log + continue — the chat result is the important signal.
        let _ = handle.append_step(serde_json::json!({
            "kind": "note",
            "text": format!("commit_branch_changes failed: {e}"),
        }));
    }

    // ----- 6. Cleanup: clear write-cap registry, restore HEAD to main -----
    agent_tools::clear_recipe_write_cap(workspace);
    if let Err(e) = restore_head(workspace, &prev_head) {
        let _ = handle.append_step(serde_json::json!({
            "kind": "note",
            "text": format!("restore_head failed: {e}"),
        }));
    }

    chat_result.map(|_| ())
}

/// Check out the given branch — assume it already exists (the caller
/// just minted it). Returns the previous HEAD's branch name (so we can
/// switch back at the end). When HEAD wasn't a branch (detached), we
/// return the bare ref name.
fn checkout_branch(workspace: &Path, branch: &str) -> Result<String, String> {
    let repo = Repository::open(workspace).map_err(|e| format!("git open: {e}"))?;
    let prev = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "main".to_string());

    let branch_ref = format!("refs/heads/{branch}");
    let obj = repo
        .revparse_single(&branch_ref)
        .map_err(|e| format!("revparse {branch_ref}: {e}"))?;
    let mut opts = git2::build::CheckoutBuilder::new();
    opts.safe();
    repo.checkout_tree(&obj, Some(&mut opts))
        .map_err(|e| format!("checkout_tree: {e}"))?;
    repo.set_head(&branch_ref)
        .map_err(|e| format!("set_head: {e}"))?;
    Ok(prev)
}

/// Restore HEAD to the named branch. Best-effort — if the branch is
/// gone (user deleted it during the run), fall back to "main" / "master".
///
/// Always prefers a `safe()` checkout first. The previous implementation
/// went straight to `force()`, which silently hard-resets and destroys
/// anything in the working tree — including edits the user typed during
/// the recipe run. We only fall back to `force()` after re-checking that
/// the workspace has no dirty paths (i.e. the only edits in flight were
/// already swept into our commit by `commit_branch_changes`).
fn restore_head(workspace: &Path, branch: &str) -> Result<(), String> {
    let repo = Repository::open(workspace).map_err(|e| format!("git open: {e}"))?;
    let target = if repo.find_branch(branch, BranchType::Local).is_ok() {
        branch.to_string()
    } else if repo.find_branch("main", BranchType::Local).is_ok() {
        "main".to_string()
    } else if repo.find_branch("master", BranchType::Local).is_ok() {
        "master".to_string()
    } else {
        return Err(format!("no branch to restore HEAD to (tried {branch}/main/master)"));
    };
    let target_ref = format!("refs/heads/{target}");
    let obj = repo
        .revparse_single(&target_ref)
        .map_err(|e| format!("revparse {target_ref}: {e}"))?;

    // Try safe() first — preserves any user edits that landed in the
    // working tree mid-run.
    let mut safe_opts = git2::build::CheckoutBuilder::new();
    safe_opts.safe();
    let safe_res = repo.checkout_tree(&obj, Some(&mut safe_opts));
    match safe_res {
        Ok(()) => {
            repo.set_head(&target_ref)
                .map_err(|e| format!("set_head restore: {e}"))?;
            return Ok(());
        }
        Err(e) => {
            // safe() refuses when there are dirty paths that would
            // collide with the target tree. Re-check via the standard
            // statuses path: if every dirty entry is one we already
            // committed on the agent branch (i.e. nothing the user typed
            // mid-run), force() is safe; otherwise propagate the error.
            let mut opts = StatusOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .include_ignored(false);
            let statuses = repo
                .statuses(Some(&mut opts))
                .map_err(|se| format!("git statuses: {se}"))?;
            let any_user_dirty = statuses.iter().any(|entry| {
                let st = entry.status();
                !st.is_empty() && !st.contains(git2::Status::IGNORED)
            });
            if any_user_dirty {
                // Refuse to clobber. Caller logs this; the agent branch
                // still holds the recipe's commits, so nothing is lost.
                return Err(format!(
                    "checkout_tree restore (safe): {e}; refusing force() — user-visible WIP detected"
                ));
            }
            // No user-visible WIP — force() is now safe.
            let mut force_opts = git2::build::CheckoutBuilder::new();
            force_opts.force();
            repo.checkout_tree(&obj, Some(&mut force_opts))
                .map_err(|fe| format!("checkout_tree restore (force): {fe}"))?;
            repo.set_head(&target_ref)
                .map_err(|e| format!("set_head restore: {e}"))?;
            Ok(())
        }
    }
}

/// Sweep up the working tree's changes (relative to the agent branch's
/// tip) into a single commit on the agent branch. Emits a `git_commit`
/// trace step listing the touched files. No-op when nothing changed.
fn commit_branch_changes(
    workspace: &Path,
    branch: &str,
    handle: &RunHandle,
    recipe: &Recipe,
    writes_consumed: u32,
) -> Result<(), String> {
    let repo = Repository::open(workspace).map_err(|e| format!("git open: {e}"))?;
    let mut index = repo.index().map_err(|e| format!("index: {e}"))?;
    // Stage everything (new + modified + deleted) under the workspace
    // root. We don't honour `.gitignore` exclusions explicitly — the
    // existing repo config already covers that.
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("index add_all: {e}"))?;
    index.write().map_err(|e| format!("index write: {e}"))?;
    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("write_tree: {e}"))?;

    // Look up the agent branch's current tip so we can:
    //   a) skip the commit when the tree is unchanged, and
    //   b) supply it as the parent.
    let parent_commit = repo
        .find_branch(branch, BranchType::Local)
        .map_err(|e| format!("find branch {branch}: {e}"))?
        .into_reference()
        .peel_to_commit()
        .map_err(|e| format!("peel branch: {e}"))?;

    if parent_commit.tree_id() == tree_oid {
        // Nothing to commit — recipe finished cleanly without writes.
        return Ok(());
    }

    let tree = repo.find_tree(tree_oid).map_err(|e| format!("find_tree: {e}"))?;
    let cfg = repo.config().map_err(|e| format!("config: {e}"))?;
    let name = cfg
        .get_string("user.name")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "SoloMD Agent".to_string());
    let email = cfg
        .get_string("user.email")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "agent@solomd.local".to_string());
    let sig = git2::Signature::now(&name, &email).map_err(|e| format!("sig: {e}"))?;

    let summary = if writes_consumed > 0 {
        format!(
            "agent: {} ({} write{})",
            recipe.slug,
            writes_consumed,
            if writes_consumed == 1 { "" } else { "s" }
        )
    } else {
        format!("agent: {}", recipe.slug)
    };

    let oid = repo
        .commit(
            Some(&format!("refs/heads/{branch}")),
            &sig,
            &sig,
            &summary,
            &tree,
            &[&parent_commit],
        )
        .map_err(|e| format!("commit: {e}"))?;

    // Diff parent → new commit to enumerate the touched files for the
    // trace. Best-effort: failures here just mean an empty `files` list.
    let new_commit = repo.find_commit(oid).map_err(|e| format!("find new: {e}"))?;
    let new_tree = new_commit.tree().map_err(|e| format!("new tree: {e}"))?;
    let parent_tree = parent_commit
        .tree()
        .map_err(|e| format!("parent tree: {e}"))?;
    let mut files: Vec<String> = Vec::new();
    if let Ok(diff) = repo.diff_tree_to_tree(Some(&parent_tree), Some(&new_tree), None) {
        diff.foreach(
            &mut |delta, _progress| {
                let p = delta
                    .new_file()
                    .path()
                    .or_else(|| delta.old_file().path())
                    .map(|p| p.to_string_lossy().to_string());
                if let Some(p) = p {
                    if !files.contains(&p) {
                        files.push(p);
                    }
                }
                true
            },
            None,
            None,
            None,
        )
        .ok();
    }

    let _ = handle.append_step(serde_json::json!({
        "kind": "git_commit",
        "branch": branch,
        "sha": oid.to_string(),
        "summary": summary,
        "files": files,
    }));
    Ok(())
}

fn commit_on_branch(
    workspace: &Path,
    branch: &str,
    rel: &str,
    msg: &str,
) -> Result<String, String> {
    let repo = Repository::open(workspace).map_err(|e| format!("open: {e}"))?;
    let mut index = repo.index().map_err(|e| format!("index: {e}"))?;
    index
        .add_path(Path::new(rel))
        .map_err(|e| format!("index add {rel}: {e}"))?;
    index.write().map_err(|e| format!("index write: {e}"))?;
    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("write_tree: {e}"))?;
    let tree = repo.find_tree(tree_oid).map_err(|e| format!("find_tree: {e}"))?;

    // Parent = current tip of the agent branch.
    let parent_commit = repo
        .find_branch(branch, BranchType::Local)
        .map_err(|e| format!("find branch {branch}: {e}"))?
        .into_reference()
        .peel_to_commit()
        .map_err(|e| format!("peel branch: {e}"))?;

    let cfg = repo.config().map_err(|e| format!("config: {e}"))?;
    let name = cfg
        .get_string("user.name")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "SoloMD Agent".to_string());
    let email = cfg
        .get_string("user.email")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "agent@solomd.local".to_string());
    let sig = git2::Signature::now(&name, &email).map_err(|e| format!("sig: {e}"))?;

    let oid = repo
        .commit(
            Some(&format!("refs/heads/{branch}")),
            &sig,
            &sig,
            msg,
            &tree,
            &[&parent_commit],
        )
        .map_err(|e| format!("commit: {e}"))?;
    // Reset the index to match HEAD on the *current* working branch
    // (whatever the user's checkout is) so subsequent saves don't get
    // confused by the in-progress staging area.
    let _ = index.read(true);
    Ok(oid.to_string())
}

// ---------------------------------------------------------------------------
// Cron loop — single tokio task that wakes on the next scheduled run.
// ---------------------------------------------------------------------------

pub fn spawn_cron_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            // Find the soonest schedule across all active recipes.
            let (workspace_opt, recipes) = {
                let state = app.state::<RecipesState>();
                let ws = state.workspace.lock().unwrap().clone();
                let r = state.recipes.lock().unwrap().clone();
                (ws, r)
            };
            let workspace = match workspace_opt {
                Some(w) => w,
                None => {
                    // No workspace yet — sleep and retry. A user setting a
                    // workspace bumps `recipes_list` which sets this.
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
            };
            let now = Utc::now();
            // Compute the soonest fire across all schedule recipes.
            let mut soonest: Option<(chrono::DateTime<Utc>, Recipe)> = None;
            for r in recipes {
                if r.trigger != TriggerKind::Schedule {
                    continue;
                }
                if let Some(next) = r.next_fire_after(now) {
                    match &soonest {
                        None => soonest = Some((next, r)),
                        Some((cur, _)) if next < *cur => soonest = Some((next, r)),
                        _ => {}
                    }
                }
            }
            // Bound the sleep so we recheck recipes periodically (a recipe
            // can be added or removed while we're sleeping).
            let sleep_ms: i64 = match &soonest {
                Some((next, _)) => (next.timestamp_millis() - now.timestamp_millis()).max(1000),
                None => 60_000,
            };
            let sleep_ms = sleep_ms.min(60_000) as u64;
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;

            let now2 = Utc::now();
            if let Some((next, recipe)) = soonest {
                if next <= now2 {
                    let ws = workspace.clone();
                    let app = app.clone();
                    let recipe_cl = recipe.clone();
                    let ctx = TriggerCtx {
                        workspace: ws.clone(),
                        ..Default::default()
                    };
                    tauri::async_runtime::spawn(async move {
                        let _ = run_recipe(&app, &ws, &recipe_cl, ctx).await;
                    });
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_for_resolves_local_alias() {
        let r = Recipe {
            name: "x".into(),
            slug: "x".into(),
            path: None,
            trigger: TriggerKind::Manual,
            schedule: None,
            match_glob: None,
            tag: None,
            prompt: "".into(),
            allow_write: false,
            write_cap: 1,
            provider: "local".into(),
            model: "qwen2.5:1.5b".into(),
            base_url: None,
            tools: vec![],
        };
        assert_eq!(provider_for(&r), "ollama");
    }

    #[test]
    fn provider_for_passes_through_other() {
        let r = Recipe {
            name: "x".into(),
            slug: "x".into(),
            path: None,
            trigger: TriggerKind::Manual,
            schedule: None,
            match_glob: None,
            tag: None,
            prompt: "".into(),
            allow_write: false,
            write_cap: 1,
            provider: "anthropic".into(),
            model: "claude".into(),
            base_url: None,
            tools: vec![],
        };
        assert_eq!(provider_for(&r), "anthropic");
    }
}
