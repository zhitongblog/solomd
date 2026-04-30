//! v4.0 Pillar 2 — recipe runner + trigger dispatcher.
//!
//! Responsibilities:
//!   1. Loading recipes for the active workspace and watching
//!      `.solomd/agents/` for changes (`State::reload`).
//!   2. Hooking save / commit / cron / manual triggers and dispatching to
//!      `run_recipe`.
//!   3. Driving one recipe: mint a run id, create the AutoGit branch,
//!      ask the LLM for a response, count writes, finalize the trace.
//!
//! ## P1 merge note
//!
//! When P1 (Agent Panel) lands on `main`, it will introduce:
//!   - a canonical `RunHandle` we can subsume our minimal one into
//!     (currently in `agent_run.rs`)
//!   - a real tool-call loop inside `ai_chat`
//!   - the in-process `agent_tool_*` registry
//!
//! Until then this module fakes the agent loop with a single-shot
//! provider call and `// TODO(merge-P1)` markers at every spot the loop
//! should be inserted. The placeholder DOES NOT actually exercise tool
//! calls — it just streams a response, parses any `[[wikilink]]`-style
//! references, and finalizes. That's enough to demonstrate the wiring
//! end-to-end (run dir, trace, branch sandbox, write-cap, accept/reject).
//!
//! Do NOT duplicate P1's tool registry here — that's wasted work and a
//! merge conflict farm.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use git2::{BranchType, Repository, ResetType};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::agent_run::{self, RecipeMeta, RunHandle, RunMeta, RunStatus, TokenCounts};
use super::recipes::{
    self, Recipe, TriggerCtx, TriggerKind, WRITE_CAP_MAX,
};

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

/// List runs whose status is `ok` and `accepted == None` — these are the
/// pending-review entries pinned to the top of the Recipes panel.
#[tauri::command]
pub async fn recipes_pending_runs(workspace: String) -> Result<Vec<RunMeta>, String> {
    let runs = agent_run::list_runs(Path::new(&workspace));
    Ok(runs
        .into_iter()
        .filter(|r| r.status == "ok" && r.accepted.is_none())
        .collect())
}

#[tauri::command]
pub async fn recipes_history(workspace: String) -> Result<Vec<RunMeta>, String> {
    Ok(agent_run::list_runs(Path::new(&workspace)))
}

#[tauri::command]
pub async fn recipes_read_trace(workspace: String, run_id: String) -> Result<String, String> {
    agent_run::read_trace(Path::new(&workspace), &run_id)
}

#[tauri::command]
pub async fn recipes_read_run_md(workspace: String, run_id: String) -> Result<String, String> {
    agent_run::read_run_md(Path::new(&workspace), &run_id)
}

/// Diff between the agent branch and `main`. Returns the unified diff
/// text — the UI renders it in a `<pre>` block. Implementation re-uses
/// libgit2 directly rather than shelling out to `git diff`.
#[tauri::command]
pub async fn recipes_run_diff(workspace: String, run_id: String) -> Result<String, String> {
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

/// Drive a single recipe end-to-end:
///   1. cooldown check
///   2. mint run id + create AutoGit branch
///   3. `RunHandle::create` writes meta.json + run.md header
///   4. resolve prompt + emit `prompt` step
///   5. call provider (placeholder shim — TODO(merge-P1))
///   6. for each suggested write the (eventual) tool loop produces,
///      enforce write-cap and commit on the agent branch
///   7. finalize meta.json
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

    let run_id = recipes::mint_run_id(Utc::now());
    // Replace our placeholder slot now that we have the real run id.
    {
        let mut running = state.running.lock().unwrap();
        running.insert(recipe.slug.clone(), run_id.clone());
    }
    ctx.workspace = workspace.to_path_buf();

    let branch_name = format!("agent/{}/{}", recipe.slug, run_id);

    // Create the agent branch off HEAD. If this fails we abort early —
    // no run dir is created, no slot is left dangling.
    let branch_create_res = create_agent_branch(workspace, &branch_name);
    if let Err(e) = branch_create_res {
        state.running.lock().unwrap().remove(&recipe.slug);
        return Err(e);
    }

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

    let handle = match RunHandle::create(workspace, &run_id, meta.clone()) {
        Ok(h) => Arc::new(h),
        Err(e) => {
            state.running.lock().unwrap().remove(&recipe.slug);
            return Err(e);
        }
    };

    // Emit run_started + prompt steps.
    let _ = handle.emit_run_started(&meta);
    let prompt_resolved = recipe.resolved_prompt(&ctx);
    let _ = handle.append_step(serde_json::json!({
        "kind": "prompt",
        "role": "user",
        "content": prompt_resolved,
    }));
    let _ = handle.append_markdown(&format!("## Prompt\n\n{prompt_resolved}\n\n"));

    // Emit a model_call step + invoke the placeholder shim.
    let _ = handle.append_step(serde_json::json!({
        "kind": "model_call",
        "provider": meta.provider,
        "model": meta.model,
        "messages_n": 2,
        "tools_n": recipe.tools.len(),
    }));

    // TODO(merge-P1): replace `single_shot_chat` with the multi-turn
    // tool-call loop landing in `ai_chat`. For now, treat the LLM as a
    // single completion and parse text back into trace as `model_done`.
    let final_meta_arc = Arc::new(Mutex::new(meta));
    let exec = single_shot_chat(
        app,
        workspace,
        recipe,
        &ctx,
        &prompt_resolved,
        Arc::clone(&handle),
        Arc::clone(&final_meta_arc),
        &branch_name,
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

    // Release cooldown slot.
    state.running.lock().unwrap().remove(&recipe.slug);

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
// Single-shot chat shim (PLACEHOLDER until P1's tool loop merges)
// ---------------------------------------------------------------------------
//
// This intentionally does the smallest thing that's still useful:
//   * Resolves the provider (defaulting to the user's settings or
//     `ollama` if `local`).
//   * Calls the provider's REST endpoint with one user message + a
//     system prompt that lists the allowed tools (so the model behaves
//     consistently when P1's loop drops in).
//   * Captures the full text reply, emits a single `model_done` step,
//     and treats *no* tool calls as the success case.
//
// When P1 merges, swap this for `ai_chat` + the registered tool loop.

#[allow(clippy::too_many_arguments)]
async fn single_shot_chat(
    _app: &AppHandle,
    workspace: &Path,
    recipe: &Recipe,
    _ctx: &TriggerCtx,
    prompt: &str,
    handle: Arc<RunHandle>,
    meta_arc: Arc<Mutex<RunMeta>>,
    branch: &str,
) -> Result<(), String> {
    // System prompt mirrors what P1's tool registry will eventually use,
    // so a recipe written today won't drift in behaviour after merge.
    let tools_list = recipe.tools.join(", ");
    let system = format!(
        "You are a SoloMD agent running a recipe.\n\
         Allowed tools: {tools_list}.\n\
         Write-cap: {} (writes beyond this will be refused).\n\
         Respond with the result; if you would call a tool, name it and the file.\n",
        recipe.write_cap
    );

    let provider = {
        let m = meta_arc.lock().unwrap();
        if m.provider.is_empty() {
            // Fallback for empty provider on the recipe — let the LLM call
            // fail with a clear error rather than silently pick a default.
            "anthropic".to_string()
        } else {
            m.provider.clone()
        }
    };

    let api_format = if provider == "ollama" {
        "ollama".to_string()
    } else if provider == "claude" || provider == "anthropic" {
        "anthropic".to_string()
    } else {
        "openai".to_string()
    };

    // Run a one-turn chat. Errors here translate to run status=error.
    let model = {
        let m = meta_arc.lock().unwrap();
        if m.model.is_empty() {
            // Reasonable default per provider, picked to match the
            // recipe's written-down example in `docs/roadmap.md`.
            match provider.as_str() {
                "anthropic" | "claude" => "claude-sonnet-4-6".to_string(),
                "ollama" => "qwen2.5:7b".to_string(),
                _ => "gpt-4.1-mini".to_string(),
            }
        } else {
            m.model.clone()
        }
    };

    let reply = match provider_call(&api_format, &provider, &model, &system, prompt, recipe.base_url.as_deref()).await {
        Ok(t) => t,
        Err(e) => {
            // Emit a model_done step with finish_reason=error so the
            // trace replay path stays consistent.
            let _ = handle.append_step(serde_json::json!({
                "kind": "model_done",
                "text": "",
                "tokens_in": 0,
                "tokens_out": 0,
                "finish_reason": "error",
            }));
            return Err(e);
        }
    };

    let tokens_out = estimate_tokens(&reply);
    let tokens_in = estimate_tokens(prompt) + estimate_tokens(&system);
    let _ = handle.append_step(serde_json::json!({
        "kind": "model_done",
        "text": truncate_for_trace(&reply),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "finish_reason": "stop",
    }));
    let _ = handle.append_markdown(&format!("## Assistant\n\n{reply}\n\n"));

    {
        let mut m = meta_arc.lock().unwrap();
        m.tokens.input = tokens_in;
        m.tokens.output = tokens_out;
    }

    // Apply C4.2 write-cap to any ```write_note path: …``` blocks the
    // model emits. This is a best-effort placeholder so the cap is
    // exercised in tests; P1's tool loop is the real thing.
    if recipe.allow_write {
        let writes = parse_write_blocks(&reply);
        let cap = recipe.write_cap.min(WRITE_CAP_MAX);
        let mut count: u32 = 0;
        for (path_rel, content) in writes {
            if count >= cap {
                let _ = handle.append_step(serde_json::json!({
                    "kind": "tool_result",
                    "tool_call_id": format!("tc_{}", count),
                    "result": "",
                    "error": "write-cap exceeded",
                }));
                let mut m = meta_arc.lock().unwrap();
                m.error = Some("write-cap exceeded".to_string());
                return Err("write-cap exceeded".to_string());
            }
            count += 1;
            // Resolve write target relative to the workspace.
            let abs = workspace.join(&path_rel);
            if let Some(parent) = abs.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&abs, &content).map_err(|e| format!("write_note: {e}"))?;
            let sha = commit_on_branch(workspace, branch, &path_rel, &format!("agent: write_note {}", path_rel))?;
            let _ = handle.append_step(serde_json::json!({
                "kind": "git_commit",
                "branch": branch,
                "sha": sha,
                "summary": format!("agent: write_note {}", path_rel),
                "files": [path_rel],
            }));
        }
    }

    Ok(())
}

/// Approximate token count — chars / 4. Good enough for cost estimation
/// before the real counts come back from the provider.
fn estimate_tokens(s: &str) -> u64 {
    (s.chars().count() / 4) as u64
}

/// C2 §2KB — truncate the trace `text` field at 2048 chars and tack on
/// an ellipsis sentinel so the replay path knows it was clipped.
fn truncate_for_trace(s: &str) -> String {
    const LIMIT: usize = 2048;
    if s.chars().count() <= LIMIT {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(LIMIT).collect();
        format!("{truncated}…(truncated)")
    }
}

// Parse simple write blocks from the model's reply.
//
// Format (NOT real Markdown — the runner just scans for the literal
// fence prefix below):
//
//     ~~~write_note path: relative/path.md
//     <body lines>
//     ~~~
//
// We don't try to be clever — if P1's tool loop is doing this for real,
// the loop replaces this entire path. The placeholder just exists so
// the write-cap path can be exercised.
fn parse_write_blocks(reply: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut lines = reply.lines();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("```write_note path:") {
            let path = rest.trim().to_string();
            let mut body = String::new();
            for inner in lines.by_ref() {
                if inner.trim_start().starts_with("```") {
                    break;
                }
                body.push_str(inner);
                body.push('\n');
            }
            out.push((path, body));
        }
    }
    out
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
// Provider call — minimal one-shot. Mirrors `ai_proxy`'s shape but
// non-streaming because the recipe runner doesn't need chunking.
// ---------------------------------------------------------------------------

async fn provider_call(
    api_format: &str,
    provider: &str,
    model: &str,
    system: &str,
    user: &str,
    base_url: Option<&str>,
) -> Result<String, String> {
    // Resolve the API key from the OS keychain — same `solomd:ai-<provider>`
    // entry that `ai_proxy::ai_set_key` writes. No key needed for ollama.
    let api_key = if api_format == "ollama" {
        String::new()
    } else {
        let entry = keyring::Entry::new("solomd", &format!("ai-{provider}"))
            .map_err(|e| format!("keychain: {e}"))?;
        entry
            .get_password()
            .map_err(|e| format!("recipe '{provider}' has no API key in keychain — open Settings → AI to set one ({e})"))?
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("http: {e}"))?;

    match api_format {
        "openai" => {
            let base = base_url
                .map(|s| s.trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            let url = format!("{base}/chat/completions");
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    {"role":"system","content": system},
                    {"role":"user","content": user},
                ],
                "stream": false,
            });
            let res = client
                .post(&url)
                .bearer_auth(&api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("openai: {e}"))?;
            let status = res.status();
            let raw = res.text().await.map_err(|e| format!("openai read: {e}"))?;
            if !status.is_success() {
                return Err(format!("openai {status}: {}", truncate(&raw, 300)));
            }
            let v: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("openai parse: {e}"))?;
            let text = v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            Ok(text)
        }
        "anthropic" => {
            let base = base_url
                .map(|s| s.trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://api.anthropic.com".to_string());
            let url = format!("{base}/v1/messages");
            let body = serde_json::json!({
                "model": model,
                "system": system,
                "messages": [{"role":"user","content": user}],
                "max_tokens": 4096,
                "stream": false,
            });
            let res = client
                .post(&url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("anthropic: {e}"))?;
            let status = res.status();
            let raw = res.text().await.map_err(|e| format!("anthropic read: {e}"))?;
            if !status.is_success() {
                return Err(format!("anthropic {status}: {}", truncate(&raw, 300)));
            }
            let v: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("anthropic parse: {e}"))?;
            let text = v
                .get("content")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("text"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            Ok(text)
        }
        "ollama" => {
            let base = base_url
                .map(|s| s.trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "http://localhost:11434".to_string());
            let url = format!("{base}/api/chat");
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    {"role":"system","content": system},
                    {"role":"user","content": user},
                ],
                "stream": false,
            });
            let res = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("ollama: {e}"))?;
            let status = res.status();
            let raw = res.text().await.map_err(|e| format!("ollama read: {e}"))?;
            if !status.is_success() {
                return Err(format!("ollama {status}: {}", truncate(&raw, 300)));
            }
            let v: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| format!("ollama parse: {e}"))?;
            let text = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            Ok(text)
        }
        other => Err(format!("unknown api_format: {other}")),
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
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
    fn parse_write_blocks_basic() {
        let reply = "ok\n```write_note path: a.md\nhello\n```\nthen\n```write_note path: b.md\nworld\n```\n";
        let blocks = parse_write_blocks(reply);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].0, "a.md");
        assert!(blocks[0].1.contains("hello"));
        assert_eq!(blocks[1].0, "b.md");
    }

    #[test]
    fn truncate_for_trace_short_passthrough() {
        let s = "abc";
        assert_eq!(truncate_for_trace(s), s);
    }

    #[test]
    fn truncate_for_trace_long_clipped() {
        let s: String = "x".repeat(3000);
        let out = truncate_for_trace(&s);
        assert!(out.ends_with("…(truncated)"));
        assert!(out.chars().count() < 3000);
    }

    #[test]
    fn estimate_tokens_smoke() {
        // chars/4 — exact value not load-bearing, just non-zero for non-empty.
        assert_eq!(estimate_tokens(""), 0);
        assert!(estimate_tokens("hello world") > 0);
    }
}
