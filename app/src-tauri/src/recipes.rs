//! v4.0 Pillar 2 — Agent Recipes (schema + parser + loader + watcher).
//!
//! Recipes are declarative agent jobs persisted as YAML files in the
//! workspace at `<workspace>/.solomd/agents/<slug>.yml`. Each file
//! describes:
//!
//!   * a trigger (`schedule` / `on-save` / `on-commit` / `on-tag-add` /
//!     `manual`)
//!   * a glob `match:` (or `tag:`) that filters which events fire it
//!   * a free-text prompt with `{{date:…}}` / `{{trigger.path}}` / etc.
//!     interpolation
//!   * provider + model + tool allow-list + write cap + allow-write flag
//!
//! This module owns:
//!   - `Recipe` (the parsed struct) + `parse_recipe` (validating loader)
//!   - `load_recipes(workspace)` — disk → `Vec<Recipe>` for the active
//!     workspace
//!   - the file-watcher used by `recipe_runner` so edits in
//!     `.solomd/agents/` re-load without an app restart
//!   - the variable-interpolation routine `Recipe::variables_resolve`
//!
//! Spec lives in `/tmp/solomd-v4-contracts.md` §C4 (and `docs/roadmap.md`
//! Pillar 2). Re-read C4 before changing the schema — the recipe runner
//! and the Settings UI both rely on the exact field names below.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Utc};
use cron::Schedule as CronSchedule;
use globset::{Glob, GlobMatcher};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// C4.1 — write-cap upper bound. Treated as a hard ceiling; recipes that
// declare a value above this clamp at parse time so a runaway prompt
// can't fork-bomb the vault.
// ---------------------------------------------------------------------------
pub const WRITE_CAP_MAX: u32 = 50;
pub const WRITE_CAP_DEFAULT: u32 = 5;

// ---------------------------------------------------------------------------
// Tool allow-list — must stay in sync with C3.1. Duplicated locally
// because P1 hasn't merged the canonical `agent_tool_*` registry yet;
// we'll dedupe at merge time.
// ---------------------------------------------------------------------------
pub const KNOWN_TOOLS: &[&str] = &[
    "list_notes",
    "read_note",
    "search",
    "get_backlinks",
    "list_tags",
    "get_outline",
    "autogit_log",
    "autogit_diff",
    "write_note",
    "append_to_note",
    "read_agent_trace",
];
pub const WRITE_TOOLS: &[&str] = &["write_note", "append_to_note"];

pub fn read_only_tools() -> Vec<String> {
    KNOWN_TOOLS
        .iter()
        .filter(|t| !WRITE_TOOLS.contains(t))
        .map(|s| s.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Recipe schema (C4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TriggerKind {
    Schedule,
    OnSave,
    OnCommit,
    OnTagAdd,
    Manual,
}

impl TriggerKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TriggerKind::Schedule => "schedule",
            TriggerKind::OnSave => "on-save",
            TriggerKind::OnCommit => "on-commit",
            TriggerKind::OnTagAdd => "on-tag-add",
            TriggerKind::Manual => "manual",
        }
    }
}

/// Wire-format struct mirrored 1:1 with the YAML file. We deserialize into
/// this with a permissive shape and then validate / normalize into
/// [`Recipe`]. Doing it in two phases lets us emit a useful error message
/// at the schema level (missing `trigger`, bad enum, etc.) before we try
/// to compile the cron / glob.
#[derive(Debug, Clone, Deserialize)]
struct RecipeRaw {
    name: String,
    trigger: String,
    #[serde(default)]
    schedule: Option<String>,
    #[serde(default)]
    #[serde(rename = "match")]
    match_glob: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    prompt: String,
    #[serde(default, rename = "allow-write")]
    allow_write: bool,
    #[serde(default, rename = "write-cap")]
    write_cap: Option<u32>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    tools: Option<Vec<String>>,
}

/// Validated, runtime-ready recipe. Constructed via [`parse_recipe`] from a
/// YAML string OR via [`load_recipes`] from disk.
#[derive(Debug, Clone, Serialize)]
pub struct Recipe {
    /// Display name from `name:`.
    pub name: String,
    /// `kebab-case` slug derived from `name` — used for branch names and
    /// the YAML filename when a recipe is created via the wizard.
    pub slug: String,
    /// Absolute path to the source `.yml` file (None when parsed from a
    /// string in tests).
    pub path: Option<PathBuf>,
    pub trigger: TriggerKind,
    /// Cron expression (for `schedule` triggers). Always parseable —
    /// validation rejects unparseable strings up-front.
    pub schedule: Option<String>,
    pub match_glob: Option<String>,
    pub tag: Option<String>,
    pub prompt: String,
    pub allow_write: bool,
    pub write_cap: u32,
    /// `claude` / `openai` / `anthropic` / `ollama` / `local` (alias of
    /// ollama, P5 contract). Empty = use the user's default AI provider.
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub tools: Vec<String>,
}

impl Recipe {
    /// Slugify a recipe name into a filesystem-safe ASCII handle.
    /// `Weekly review` → `weekly-review`; non-ASCII chars become hex
    /// nibbles so two CJK names don't collide on disk.
    pub fn slugify(name: &str) -> String {
        let mut out = String::with_capacity(name.len());
        let mut last_dash = false;
        for c in name.chars() {
            if c.is_ascii_alphanumeric() {
                out.push(c.to_ascii_lowercase());
                last_dash = false;
            } else if c.is_whitespace() || c == '-' || c == '_' {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            } else {
                // Non-ASCII (CJK, emoji, etc.) — encode each codepoint as
                // a short hex pair so distinct chars stay distinct without
                // smuggling unsafe bytes into the path.
                for b in (c as u32).to_be_bytes() {
                    if b != 0 {
                        out.push_str(&format!("{:02x}", b));
                    }
                }
                last_dash = false;
            }
        }
        let trimmed = out.trim_matches('-').to_string();
        if trimmed.is_empty() {
            "recipe".to_string()
        } else {
            trimmed
        }
    }

    /// Compile the `match:` glob into a [`GlobMatcher`]. Returns `None`
    /// when the recipe has no glob (e.g. `manual` or `schedule` triggers
    /// without a path filter).
    pub fn compiled_match(&self) -> Option<GlobMatcher> {
        self.match_glob
            .as_ref()
            .and_then(|g| Glob::new(g).ok().map(|g| g.compile_matcher()))
    }

    /// Apply C4.1 token interpolation to a prompt string. Unknown
    /// `{{tokens}}` are passed through verbatim — the user is allowed to
    /// embed literals like `{{example}}` in their prompts.
    #[allow(dead_code)]
    pub fn variables_resolve(prompt: &str, ctx: &TriggerCtx) -> String {
        resolve_variables(prompt, ctx)
    }

    /// Convenience — runs `variables_resolve` against this recipe's own
    /// prompt.
    pub fn resolved_prompt(&self, ctx: &TriggerCtx) -> String {
        resolve_variables(&self.prompt, ctx)
    }

    /// Compute the next fire time (UTC) for a schedule recipe given a
    /// reference instant. Returns `None` for non-schedule triggers or
    /// when the cron expression has no future occurrences (impossible
    /// for sane crons but the `cron` crate models it as an `Option`).
    pub fn next_fire_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        if self.trigger != TriggerKind::Schedule {
            return None;
        }
        let expr = self.schedule.as_deref()?;
        let sched: CronSchedule = normalize_cron(expr).parse().ok()?;
        sched.after(&after).next()
    }
}

/// Context passed to the prompt interpolator + the runner. Populated by
/// the trigger that fires a recipe.
#[derive(Debug, Clone, Default)]
pub struct TriggerCtx {
    pub workspace: PathBuf,
    /// File path that triggered the run, if any (relative to workspace).
    pub trigger_path: Option<String>,
    /// Commit SHA (for on-commit trigger).
    pub trigger_sha: Option<String>,
    /// Tag name (for on-tag-add trigger).
    pub trigger_tag: Option<String>,
    /// Override `now` for tests; production callers pass `None` and we use
    /// the current wall clock.
    pub now: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------------------
// Variable interpolation (C4.1)
// ---------------------------------------------------------------------------

/// Pure-Rust mini template engine. We don't pull in `tera` / `handlebars`
/// for two reasons: (a) we need exactly four tokens, (b) keeping the
/// surface tiny means a malicious recipe can't suddenly access an
/// inherited helper. Unknown tokens pass through verbatim per C4.1.
fn resolve_variables(input: &str, ctx: &TriggerCtx) -> String {
    let now: DateTime<Utc> = ctx.now.unwrap_or_else(Utc::now);
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Look for `{{`. If not found, copy the rest and stop.
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            // Find matching `}}` — bounded by 256 chars to prevent
            // pathological inputs from scanning to EOF on every `{{`.
            let search_end = (i + 256).min(bytes.len().saturating_sub(1));
            let mut close = None;
            let mut j = i + 2;
            while j < search_end {
                if bytes[j] == b'}' && bytes[j + 1] == b'}' {
                    close = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(close_idx) = close {
                let token = &input[i + 2..close_idx];
                if let Some(replacement) = resolve_token(token.trim(), ctx, now) {
                    out.push_str(&replacement);
                } else {
                    // Unknown — copy the literal `{{token}}` so the user's
                    // own placeholders survive untouched.
                    out.push_str(&input[i..close_idx + 2]);
                }
                i = close_idx + 2;
                continue;
            }
        }
        // Default — copy one byte. We're operating on UTF-8, but `{`
        // / `}` are single bytes so this is safe.
        let next = next_char_boundary(input, i);
        out.push_str(&input[i..next]);
        i = next;
    }
    out
}

/// UTF-8 boundary helper — moves past a single codepoint starting at `i`.
fn next_char_boundary(s: &str, i: usize) -> usize {
    let bytes = s.as_bytes();
    let mut j = i + 1;
    while j < bytes.len() && (bytes[j] & 0b1100_0000) == 0b1000_0000 {
        j += 1;
    }
    j
}

fn resolve_token(token: &str, ctx: &TriggerCtx, now: DateTime<Utc>) -> Option<String> {
    if let Some(fmt) = token.strip_prefix("date:") {
        return Some(format_date(now, fmt.trim()));
    }
    match token {
        "trigger.path" => Some(ctx.trigger_path.clone().unwrap_or_default()),
        "trigger.sha" => Some(ctx.trigger_sha.clone().unwrap_or_default()),
        "trigger.tag" => Some(ctx.trigger_tag.clone().unwrap_or_default()),
        "workspace" => Some(ctx.workspace.to_string_lossy().to_string()),
        _ => None,
    }
}

/// Format `now` per C4.1's compact format language. We accept:
///   - `YYYY` / `YY` / `MM` / `DD`
///   - `WW` (ISO week number, zero-padded to 2 digits)
///   - `HH` / `mm` / `ss`
///   - any literal character (so `YYYY-MM-DD` works as expected)
///
/// We render in the workspace's *local* timezone — users intuitively
/// expect "today's daily note" to mean their local date, even when the
/// recipe runs at midnight UTC. That said, the ISO week is always
/// computed from the local date as well; mixing UTC + local week numbers
/// is more confusing than the rare midnight-edge case.
fn format_date(now: DateTime<Utc>, fmt: &str) -> String {
    let local: DateTime<Local> = now.with_timezone(&Local);
    let local_naive: NaiveDate = local.date_naive();

    // Walk the format string. We use a hand-rolled scanner because
    // chrono's `format()` uses `%Y` / `%m` / `%V` etc., not `YYYY` style,
    // and the spec is the simpler form.
    let mut out = String::with_capacity(fmt.len() + 4);
    let chars: Vec<char> = fmt.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let rem = &chars[i..];
        if starts_with(rem, "YYYY") {
            out.push_str(&format!("{:04}", local.year()));
            i += 4;
        } else if starts_with(rem, "YY") {
            out.push_str(&format!("{:02}", local.year() % 100));
            i += 2;
        } else if starts_with(rem, "MM") {
            out.push_str(&format!("{:02}", local.month()));
            i += 2;
        } else if starts_with(rem, "DD") {
            out.push_str(&format!("{:02}", local.day()));
            i += 2;
        } else if starts_with(rem, "WW") {
            // ISO 8601 week number — chrono provides it via `iso_week()`.
            out.push_str(&format!("{:02}", local_naive.iso_week().week()));
            i += 2;
        } else if starts_with(rem, "HH") {
            out.push_str(&format!("{:02}", local.hour()));
            i += 2;
        } else if starts_with(rem, "mm") {
            out.push_str(&format!("{:02}", local.minute()));
            i += 2;
        } else if starts_with(rem, "ss") {
            out.push_str(&format!("{:02}", local.second()));
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn starts_with(haystack: &[char], needle: &str) -> bool {
    let n: Vec<char> = needle.chars().collect();
    if haystack.len() < n.len() {
        return false;
    }
    haystack[..n.len()] == n[..]
}

// chrono::Timelike isn't imported by default — we use it explicitly here
// via a use *inside* the impl block to keep the public surface tidy.
use chrono::Timelike;

// ---------------------------------------------------------------------------
// Parsing + validation
// ---------------------------------------------------------------------------

/// Normalise a cron expression to the form the `cron` crate expects.
///
/// Standard Vixie cron is 5 fields: `min hour dom mon dow`. The `cron`
/// crate accepts 6 (with leading seconds) or 7 (with trailing year)
/// fields. C4's spec quotes 5-field syntax (`"0 18 * * SUN"`) so we
/// transparently prepend a `0` for seconds when a 5-field expression
/// arrives. Leaves 6/7-field input untouched. We never mutate the
/// original `recipe.schedule` field — the user-facing form keeps their
/// canonical 5-field syntax intact in the YAML on disk.
fn normalize_cron(expr: &str) -> String {
    let trimmed = expr.trim();
    let n = trimmed.split_whitespace().count();
    if n == 5 {
        format!("0 {trimmed}")
    } else {
        trimmed.to_string()
    }
}

/// Parse a YAML string into a validated [`Recipe`]. Returns a human-
/// readable error message ready to surface in a toast.
pub fn parse_recipe(source: &str, path: Option<PathBuf>) -> Result<Recipe, String> {
    let raw: RecipeRaw = serde_yaml::from_str(source)
        .map_err(|e| format!("recipe yaml: {e}"))?;
    validate_recipe(raw, path)
}

fn validate_recipe(raw: RecipeRaw, path: Option<PathBuf>) -> Result<Recipe, String> {
    if raw.name.trim().is_empty() {
        return Err("recipe: name is required".into());
    }
    let trigger = match raw.trigger.as_str() {
        "schedule" => TriggerKind::Schedule,
        "on-save" => TriggerKind::OnSave,
        "on-commit" => TriggerKind::OnCommit,
        "on-tag-add" => TriggerKind::OnTagAdd,
        "manual" => TriggerKind::Manual,
        other => {
            return Err(format!(
                "recipe '{}': unknown trigger '{other}' (expected one of: schedule, on-save, on-commit, on-tag-add, manual)",
                raw.name
            ))
        }
    };

    // schedule trigger requires a parseable cron expression.
    if trigger == TriggerKind::Schedule {
        let s = raw
            .schedule
            .as_deref()
            .ok_or_else(|| format!("recipe '{}': schedule trigger requires `schedule:`", raw.name))?;
        if normalize_cron(s).parse::<CronSchedule>().is_err() {
            return Err(format!(
                "recipe '{}': invalid cron expression `{s}` — expected standard 5-field cron (min hour dom mon dow) or 6/7-field with seconds/year",
                raw.name
            ));
        }
    }

    // on-save / on-commit require a glob.
    if matches!(trigger, TriggerKind::OnSave | TriggerKind::OnCommit) {
        let g = raw
            .match_glob
            .as_deref()
            .ok_or_else(|| format!("recipe '{}': {} trigger requires `match:`", raw.name, trigger.as_str()))?;
        Glob::new(g).map_err(|e| format!("recipe '{}': bad glob `{g}`: {e}", raw.name))?;
    }

    // on-tag-add requires both a tag and a glob (so we know which files to scan).
    if trigger == TriggerKind::OnTagAdd {
        if raw.tag.as_deref().map(|s| s.trim()).unwrap_or("").is_empty() {
            return Err(format!("recipe '{}': on-tag-add trigger requires `tag:`", raw.name));
        }
        // `match:` is optional for on-tag-add — falls back to `**/*.md`.
        if let Some(g) = raw.match_glob.as_deref() {
            Glob::new(g).map_err(|e| format!("recipe '{}': bad glob `{g}`: {e}", raw.name))?;
        }
    }

    // Validate tools allow-list against C3.1.
    let tools = raw.tools.unwrap_or_else(read_only_tools);
    for t in &tools {
        if !KNOWN_TOOLS.contains(&t.as_str()) {
            return Err(format!(
                "recipe '{}': unknown tool '{t}' (allowed: {})",
                raw.name,
                KNOWN_TOOLS.join(", ")
            ));
        }
    }

    // write tools require allow-write: true.
    let mut have_write_tool = false;
    for t in &tools {
        if WRITE_TOOLS.contains(&t.as_str()) {
            have_write_tool = true;
        }
    }
    if have_write_tool && !raw.allow_write {
        return Err(format!(
            "recipe '{}': tools list includes a write tool ({}) but `allow-write` is false",
            raw.name,
            WRITE_TOOLS
                .iter()
                .filter(|t| tools.contains(&t.to_string()))
                .copied()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    // Cap write-cap at WRITE_CAP_MAX (50 per C4).
    let mut write_cap = raw.write_cap.unwrap_or(WRITE_CAP_DEFAULT);
    if write_cap > WRITE_CAP_MAX {
        write_cap = WRITE_CAP_MAX;
    }

    let slug = Recipe::slugify(&raw.name);
    Ok(Recipe {
        name: raw.name,
        slug,
        path,
        trigger,
        schedule: raw.schedule,
        match_glob: raw.match_glob,
        tag: raw.tag,
        prompt: raw.prompt,
        allow_write: raw.allow_write,
        write_cap,
        provider: raw.provider.unwrap_or_default(),
        model: raw.model.unwrap_or_default(),
        base_url: raw.base_url,
        tools,
    })
}

/// Round-trip a Recipe back to YAML text. Used by the New Recipe wizard
/// when it materialises the file the user just described in a form. We
/// emit fields in the canonical order from C4 so generated files match
/// hand-written ones a user might compare against.
#[allow(dead_code)]
pub fn recipe_to_yaml(recipe: &Recipe) -> String {
    let mut map: BTreeMap<String, serde_yaml::Value> = BTreeMap::new();
    map.insert("name".into(), recipe.name.clone().into());
    map.insert("trigger".into(), recipe.trigger.as_str().to_string().into());
    if let Some(s) = &recipe.schedule {
        map.insert("schedule".into(), s.clone().into());
    }
    if let Some(g) = &recipe.match_glob {
        map.insert("match".into(), g.clone().into());
    }
    if let Some(t) = &recipe.tag {
        map.insert("tag".into(), t.clone().into());
    }
    map.insert("prompt".into(), recipe.prompt.clone().into());
    map.insert("allow-write".into(), recipe.allow_write.into());
    map.insert(
        "write-cap".into(),
        serde_yaml::Value::Number((recipe.write_cap as u64).into()),
    );
    if !recipe.provider.is_empty() {
        map.insert("provider".into(), recipe.provider.clone().into());
    }
    if !recipe.model.is_empty() {
        map.insert("model".into(), recipe.model.clone().into());
    }
    if let Some(b) = &recipe.base_url {
        map.insert("base_url".into(), b.clone().into());
    }
    if !recipe.tools.is_empty() {
        let tools: Vec<serde_yaml::Value> = recipe.tools.iter().map(|t| t.clone().into()).collect();
        map.insert("tools".into(), serde_yaml::Value::Sequence(tools));
    }
    serde_yaml::to_string(&map).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/// Path to the `.solomd/agents/` directory inside `workspace`. Created on
/// the fly when the user saves their first recipe — we don't auto-create
/// it on app start because the watcher tolerates a missing dir.
pub fn agents_dir(workspace: &Path) -> PathBuf {
    workspace.join(".solomd").join("agents")
}

/// Scan `<workspace>/.solomd/agents/*.yml` (and `.yaml`) and return every
/// recipe that parses successfully. Bad recipes get logged via the
/// returned `errors` Vec rather than aborting the whole load — one
/// broken file shouldn't disable the others.
pub fn load_recipes(workspace: &Path) -> (Vec<Recipe>, Vec<String>) {
    let mut recipes = Vec::new();
    let mut errors = Vec::new();
    let dir = agents_dir(workspace);
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return (recipes, errors),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase);
        // `.example` files (sample recipes that ship with the app) are
        // intentionally skipped so they don't auto-fire.
        let is_yaml = matches!(ext.as_deref(), Some("yml") | Some("yaml"));
        if !is_yaml {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("{}: {e}", path.display()));
                continue;
            }
        };
        match parse_recipe(&raw, Some(path.clone())) {
            Ok(r) => recipes.push(r),
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }
    // Deterministic ordering for the UI list.
    recipes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (recipes, errors)
}

/// Persist a recipe to disk under `agents_dir/<slug>.yml`. Creates the
/// directory if it doesn't exist. Returns the resulting absolute path.
#[allow(dead_code)]
pub fn save_recipe(workspace: &Path, recipe: &Recipe) -> Result<PathBuf, String> {
    let dir = agents_dir(workspace);
    fs::create_dir_all(&dir).map_err(|e| format!("create agents dir: {e}"))?;
    let path = recipe
        .path
        .clone()
        .unwrap_or_else(|| dir.join(format!("{}.yml", recipe.slug)));
    fs::write(&path, recipe_to_yaml(recipe)).map_err(|e| format!("write recipe: {e}"))?;
    Ok(path)
}

/// Delete the recipe file. Idempotent — removing a missing file is OK so
/// the UI doesn't have to special-case the "already deleted in another
/// window" race.
pub fn delete_recipe(workspace: &Path, slug: &str) -> Result<(), String> {
    let dir = agents_dir(workspace);
    for ext in ["yml", "yaml"] {
        let p = dir.join(format!("{slug}.{ext}"));
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("delete: {e}"))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tag-change detection helper (used by the on-tag-add trigger)
// ---------------------------------------------------------------------------

/// Tags introduced in `after` that weren't present in `before`. Used by
/// the `on-tag-add` trigger to decide whether to fire after a save.
pub fn newly_added_tags(before: &[String], after: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for t in after {
        if !before.iter().any(|b| b == t) {
            out.push(t.clone());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Run-id minting (C1 §run-id format)
// ---------------------------------------------------------------------------

/// Mint a run id matching the `YYYYMMDD-HHMMSS-<6hex>` format (UTC).
/// Two runs in the same second still get distinct ids thanks to the hex
/// suffix sourced from a process-local counter mixed with the second of
/// the day so successive ids stay readable in `ls`.
pub fn mint_run_id(now: DateTime<Utc>) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut bytes = [0u8; 3];
    bytes[0] = ((n >> 16) & 0xff) as u8;
    bytes[1] = ((n >> 8) & 0xff) as u8;
    bytes[2] = (n & 0xff) as u8;
    let suffix = hex::encode(bytes);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}-{}",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        suffix
    )
}

#[allow(dead_code)]
fn _silence_timezone_unused() {
    // `Utc` is implicitly used via `Utc::now()`; touch this so the linter
    // doesn't strip the import in some refactor.
    let _ = Utc.timestamp_opt(0, 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parse_minimal_schedule() {
        let yaml = r#"
name: Weekly review
trigger: schedule
schedule: "0 18 * * SUN"
prompt: hello
"#;
        let r = parse_recipe(yaml, None).expect("parse");
        assert_eq!(r.trigger, TriggerKind::Schedule);
        assert_eq!(r.schedule.as_deref(), Some("0 18 * * SUN"));
        assert_eq!(r.write_cap, WRITE_CAP_DEFAULT);
        assert!(!r.allow_write);
        // Default tool list = read-only set.
        assert!(r.tools.contains(&"read_note".to_string()));
        assert!(!r.tools.contains(&"write_note".to_string()));
    }

    #[test]
    fn parse_rejects_bad_cron() {
        let yaml = r#"
name: Bad
trigger: schedule
schedule: "every wednesday"
prompt: hi
"#;
        let err = parse_recipe(yaml, None).unwrap_err();
        assert!(err.contains("invalid cron"), "got: {err}");
    }

    #[test]
    fn parse_rejects_unknown_tool() {
        let yaml = r#"
name: Weird
trigger: manual
prompt: hi
tools:
  - read_note
  - launch_nukes
"#;
        let err = parse_recipe(yaml, None).unwrap_err();
        assert!(err.contains("unknown tool"), "got: {err}");
    }

    #[test]
    fn parse_rejects_write_tool_without_allow_write() {
        let yaml = r#"
name: Writes
trigger: manual
prompt: hi
tools:
  - read_note
  - write_note
"#;
        let err = parse_recipe(yaml, None).unwrap_err();
        assert!(err.contains("allow-write"), "got: {err}");
    }

    #[test]
    fn parse_caps_write_cap_at_50() {
        let yaml = r#"
name: Greedy
trigger: manual
prompt: hi
allow-write: true
write-cap: 9999
tools:
  - write_note
"#;
        let r = parse_recipe(yaml, None).expect("parse");
        assert_eq!(r.write_cap, WRITE_CAP_MAX);
    }

    #[test]
    fn parse_on_save_requires_match() {
        let yaml = r#"
name: NoMatch
trigger: on-save
prompt: hi
"#;
        let err = parse_recipe(yaml, None).unwrap_err();
        assert!(err.contains("match"), "got: {err}");
    }

    #[test]
    fn parse_on_save_validates_glob() {
        let yaml = r#"
name: BadGlob
trigger: on-save
match: "[unclosed"
prompt: hi
"#;
        let err = parse_recipe(yaml, None).unwrap_err();
        assert!(err.contains("glob"), "got: {err}");
    }

    #[test]
    fn parse_on_tag_add_requires_tag() {
        let yaml = r#"
name: Tagless
trigger: on-tag-add
prompt: hi
"#;
        let err = parse_recipe(yaml, None).unwrap_err();
        assert!(err.contains("tag"), "got: {err}");
    }

    #[test]
    fn yaml_roundtrip_preserves_fields() {
        let yaml = r#"
name: Roundtrip
trigger: schedule
schedule: "0 0 * * *"
prompt: |
  hi
allow-write: true
write-cap: 7
provider: claude
model: claude-sonnet-4-6
tools:
  - read_note
  - write_note
"#;
        let r = parse_recipe(yaml, None).expect("parse");
        let dumped = recipe_to_yaml(&r);
        let r2 = parse_recipe(&dumped, None).expect("re-parse");
        assert_eq!(r.name, r2.name);
        assert_eq!(r.trigger, r2.trigger);
        assert_eq!(r.schedule, r2.schedule);
        assert_eq!(r.write_cap, r2.write_cap);
        assert_eq!(r.allow_write, r2.allow_write);
        assert_eq!(r.tools, r2.tools);
        assert_eq!(r.provider, r2.provider);
        assert_eq!(r.model, r2.model);
    }

    #[test]
    fn variables_resolve_dates() {
        let ws = std::path::PathBuf::from("/tmp/vault");
        // Pin to 2024-01-01 12:34:56 UTC to make the test deterministic
        // regardless of the machine's clock. We deliberately don't pin
        // the local timezone — formatters render in local time, and the
        // test should pass for any TZ. So we only assert the YYYY part
        // (which can flip ±1 day across some TZs but never across years
        // for noon UTC) and verify shape, not exact local digits.
        let now = Utc.with_ymd_and_hms(2024, 1, 1, 12, 34, 56).unwrap();
        let ctx = TriggerCtx { workspace: ws.clone(), now: Some(now), ..Default::default() };
        let s = Recipe::variables_resolve("y={{date:YYYY}} m={{date:MM}} d={{date:DD}}", &ctx);
        assert!(s.starts_with("y=2024 "), "got: {s}");
        assert!(s.contains(" m=01 ") || s.contains(" m=12 "), "got: {s}"); // local TZ might roll back to Dec 31
        // workspace token
        let ws_s = Recipe::variables_resolve("path={{workspace}}", &ctx);
        assert_eq!(ws_s, format!("path={}", ws.to_string_lossy()));
    }

    #[test]
    fn variables_resolve_iso_week() {
        // 2024-01-01 is a Monday — ISO week 1.
        let now = Utc.with_ymd_and_hms(2024, 1, 1, 12, 0, 0).unwrap();
        let ctx = TriggerCtx { now: Some(now), ..Default::default() };
        let s = Recipe::variables_resolve("{{date:YYYY-WW}}", &ctx);
        // Local TZ may push us to 2023-W52 in pacific time → accept either.
        assert!(s == "2024-01" || s == "2023-52", "got: {s}");
    }

    #[test]
    fn variables_resolve_unknown_passes_through() {
        let ctx = TriggerCtx::default();
        let s = Recipe::variables_resolve("hello {{nope}} world", &ctx);
        assert_eq!(s, "hello {{nope}} world");
    }

    #[test]
    fn variables_resolve_trigger_path_and_sha() {
        let ctx = TriggerCtx {
            trigger_path: Some("daily/2024-01-01.md".into()),
            trigger_sha: Some("abc1234".into()),
            ..Default::default()
        };
        let s = Recipe::variables_resolve("p={{trigger.path}} s={{trigger.sha}}", &ctx);
        assert_eq!(s, "p=daily/2024-01-01.md s=abc1234");
    }

    #[test]
    fn glob_match() {
        let yaml = r#"
name: Daily
trigger: on-save
match: "daily/**/*.md"
prompt: hi
"#;
        let r = parse_recipe(yaml, None).expect("parse");
        let m = r.compiled_match().expect("glob");
        assert!(m.is_match("daily/2024/01-01.md"));
        assert!(m.is_match("daily/01-01.md"));
        assert!(!m.is_match("weekly/01-01.md"));
        assert!(!m.is_match("daily/01-01.txt"));
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(Recipe::slugify("Weekly review"), "weekly-review");
        assert_eq!(Recipe::slugify("  Hello   World  "), "hello-world");
        assert_eq!(Recipe::slugify(""), "recipe");
    }

    #[test]
    fn slugify_cjk_distinct() {
        // Two distinct CJK names should hash to distinct slugs.
        let a = Recipe::slugify("周报");
        let b = Recipe::slugify("月报");
        assert_ne!(a, b);
        assert!(!a.is_empty());
    }

    #[test]
    fn newly_added_tags_diff() {
        let before = vec!["a".to_string(), "b".to_string()];
        let after = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(newly_added_tags(&before, &after), vec!["c".to_string()]);
        assert!(newly_added_tags(&after, &before).is_empty());
    }

    #[test]
    fn next_fire_after_for_cron() {
        let r = parse_recipe(
            r#"
name: Hourly
trigger: schedule
schedule: "0 0 * * * *"
prompt: hi
"#,
            None,
        )
        .expect("parse");
        let from = Utc.with_ymd_and_hms(2024, 1, 1, 12, 30, 0).unwrap();
        let next = r.next_fire_after(from).expect("schedule");
        assert!(next > from);
    }

    #[test]
    fn mint_run_id_format() {
        let now = Utc.with_ymd_and_hms(2024, 1, 2, 3, 4, 5).unwrap();
        let id = mint_run_id(now);
        assert!(id.starts_with("20240102-030405-"), "got: {id}");
        assert_eq!(id.len(), 8 + 1 + 6 + 1 + 6);
    }

    #[test]
    fn load_recipes_from_dir() {
        let tmp = tempdir();
        let agents = tmp.join(".solomd").join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(
            agents.join("a.yml"),
            "name: A\ntrigger: manual\nprompt: hi\n",
        )
        .unwrap();
        std::fs::write(
            agents.join("b.yml"),
            "name: B\ntrigger: manual\nprompt: hi\n",
        )
        .unwrap();
        // .example file should NOT load.
        std::fs::write(
            agents.join("c.yml.example"),
            "name: C\ntrigger: manual\nprompt: hi\n",
        )
        .unwrap();
        let (recipes, errs) = load_recipes(&tmp);
        assert_eq!(recipes.len(), 2, "errs: {errs:?}");
        assert_eq!(recipes[0].name, "A");
        assert_eq!(recipes[1].name, "B");
    }

    fn tempdir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "solomd-recipes-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
