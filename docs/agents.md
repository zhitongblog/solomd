# Agents in SoloMD

> **Status:** v4.0 (May 2026). Companion to `docs/roadmap.md` § "v4.0 — Agent-native author".

SoloMD treats agents as **first-class editor surfaces**, not external CLI handoffs. This doc is the
*write-your-own-agent* guide: the YAML schema, what tools exist, the safety model, and the patterns
that work. If you just want to install a starter, open **Settings → Recipes → Browse cookbook**.

---

## TL;DR — three things to know

1. **A recipe is one YAML file** under `<workspace>/.solomd/agents/*.yml`. No build step, no plugin
   manifest. Edit, save, run.
2. **Every run is sandboxed** on its own AutoGit branch (`agent/<recipe>/<run-id>`). Writes don't
   touch `main` until you click **Accept** in Settings → Recipes → Pending.
3. **Read tools are free; write tools are gated** behind `allow-write: true` + a per-run `write-cap`
   (default 5, hard cap 50). The trace view shows every read and every write before you accept.

---

## YAML schema

```yaml
name: Weekly review              # required, displayed in UI
trigger: schedule                # required: schedule | on-save | on-commit | on-tag-add | manual
schedule: "0 18 * * SUN"         # required when trigger=schedule (5-field cron, UTC)
match: "daily/**/*.md"           # required for on-save / on-commit / on-tag-add (glob, workspace-relative)
tag: review-me                   # required for on-tag-add (no leading #)
prompt: |                        # required: the agent's instructions (multi-line block)
  Read this week's daily/ notes.
  Write weekly/{{date:YYYY-WW}}.md: themes / decisions / open threads.
allow-write: true                # default false — required if prompt asks for write_note / append_to_note
write-cap: 5                     # default 5, hard upper bound 50 — refusal bails before any side-effect
provider: claude                 # optional: claude | openai | anthropic | gemini | ollama | local | …
model: claude-sonnet-4-6         # optional, falls back to user's default model for the provider
base_url: https://api.x          # optional, only when self-hosting an OpenAI-compatible endpoint
tools:                           # optional explicit allowlist; default = every tool
  - read_note
  - write_note
```

A few subtleties worth knowing:

- **Cron is UTC**. `0 18 * * SUN` fires at 18:00 UTC on Sunday — that's 02:00 Monday in Beijing,
  10:00 Saturday in San Francisco. The cron parser accepts the standard 5 fields plus an optional
  6th (seconds, for testing).
- **Glob is workspace-relative** and uses the same `globset` crate as `gitignore` — `**/*.md` walks
  every folder, `daily/**/*.md` only inside `daily/`.
- **`tools:` allowlist** is a safety belt: when set, any tool the prompt asks for that's not in the
  list is refused at dispatch time. Useful for "this recipe should never write" recipes that you
  also mark `allow-write: false` for double protection.
- **`provider: local`** is an alias of `ollama` (kept for forward-compat with future local
  runtimes — see roadmap "Bundled local LLM runtime" → explicitly skipped).

---

## Triggers

| Trigger      | Fires when                                 | Required fields           | Notes |
|--------------|---------------------------------------------|---------------------------|-------|
| `schedule`   | Cron expression matches current UTC minute | `schedule:` (cron)        | Cron loop polls every 60s; never double-fires within a minute. |
| `on-save`    | A markdown file matching `match:` is saved | `match:` (glob)           | Debounced 800ms; rapid saves coalesce into one run. |
| `on-commit`  | An AutoGit commit lands and touches `match:` | `match:` (glob)           | Fires once per commit; multiple matched files = one run with `{{files}}` populated. |
| `on-tag-add` | A note gets `#tag` added that matches `tag:` | `tag:`                    | Detected by diffing the post-save tag list vs the pre-save list. |
| `manual`     | User clicks **Run now** in Settings → Recipes | (none)                    | The escape hatch — also useful for "test my prompt" cycles. |

---

## Prompt variables

The runner does Mustache-style substitution before sending the prompt to the model. Unknown
`{{tokens}}` are passed through verbatim, so embedding the literal string `{{example}}` in a prompt
is fine.

| Token             | Resolved to                                                            | Available in        |
|-------------------|-------------------------------------------------------------------------|---------------------|
| `{{path}}`        | Workspace-relative path of the triggering file                          | `on-save`, `on-tag-add` |
| `{{files}}`       | Comma-separated list of paths in the triggering commit                 | `on-commit`         |
| `{{sha}}`         | Short commit SHA                                                        | `on-commit`         |
| `{{tag}}`         | The `#tag` that was just added (no leading `#`)                         | `on-tag-add`        |
| `{{date:FORMAT}}` | Current date in any [chrono](https://docs.rs/chrono) format string. Common: `YYYY-MM-DD`, `YYYY-WW` (ISO week), `YYYY-MM` | All triggers |
| `{{workspace}}`   | Absolute workspace path                                                 | All triggers        |
| `{{recipe}}`      | This recipe's `name:` (handy for self-reference inside prompts)         | All triggers        |

---

## Tools the agent can call

Read tools are always available; write tools require `allow-write: true`.

### Read

| Tool              | What it does                                                     |
|-------------------|------------------------------------------------------------------|
| `list_notes`      | List markdown files (optional `folder:` and `limit:`)            |
| `read_note`       | Read one note + parsed front matter / headings / wikilinks       |
| `search`          | Full-text search; `mode: literal` (default) or `mode: regex`     |
| `get_backlinks`   | Find every note that links to a given note via `[[wikilink]]`    |
| `list_tags`       | Enumerate every `#tag` with file counts                          |
| `get_outline`     | Heading tree (level / text / line) for a note                    |
| `autogit_log`     | Recent AutoGit commits that touched a file                       |
| `autogit_diff`    | Unified diff of a commit on a file                               |
| `read_agent_trace`| Read another run's `trace.jsonl` — opens the door to self-correcting recipes |

### Write (requires `allow-write: true`)

| Tool              | What it does                                                     |
|-------------------|------------------------------------------------------------------|
| `write_note`      | Create or overwrite a note. `allow_overwrite: true` to overwrite |
| `append_to_note`  | Append to an existing note (creates a leading newline)           |

Each write call charges the per-run `write-cap`. When the cap is exhausted the next write returns
an error to the model — the loop continues so the model can wrap up cleanly.

---

## Safety model: the AutoGit sandbox

Every recipe run begins by:

1. Creating a fresh AutoGit branch `agent/<recipe-slug>/<run-id>` off the current HEAD.
2. Running the prompt + tool loop. All `write_note` / `append_to_note` calls land on this branch.
3. On success the run goes into **Pending review** with a button to view the diff, **Accept**
   (merge into `main`), or **Reject** (delete the branch entirely).

A **rejected** run vanishes — no merge, no leftover commits in your history. An **accepted** run
fast-forwards `main` and shows up in `git log` like any other commit.

The `write-cap` is enforced *before* dispatch, so a model that asks to write 100 files when the cap
is 5 will get refusals starting at the 6th call, with no half-applied state.

---

## Output: the run dir

Every run materializes a directory:

```
<workspace>/.solomd/agent-runs/<run-id>/
├── meta.json     ← provider / model / status / token totals / cost estimate
├── trace.jsonl   ← one JSON line per step (prompt / model_call / tool_call / tool_result / done)
└── run.md        ← human-readable transcript with tool blocks inline
```

`run-id` format: `YYYYMMDD-HHMMSS-XXXXXX` (UTC + 6 random hex). The directory is plain markdown +
JSON — `grep`-able, `git`-trackable, AI-introspectable via the `read_agent_trace` tool.

The **Settings → Recipes → History** view renders these as collapsible step cards. The
**replay-from-step** button mints a new run that re-uses the trace up to step N and continues from
there — useful for "this run was almost right, but it took a bad turn at step 7."

---

## Patterns that work

### Read-only "suggest, don't act" recipes

Set `allow-write: false`. The model can still call read tools, and its conclusions land in the
trace view for your manual review. Great for link suggestions, citation audits, "give me a TL;DR
of these notes" kinds of work — anything where you want the agent to think but not edit.

See `cookbook/07-link-suggester.yml` for a full example.

### Schedule + report = no-touch cron jobs

`schedule: "0 22 * * *"` + `prompt: write a daily summary to today's daily note`. The recipe runs
every night, you wake up, the summary's there. If you don't like the summary you reject the run
and the daily note is untouched.

See `cookbook/08-daily-summary.yml`.

### Local provider for high-frequency, sensitive recipes

`provider: ollama` + `model: qwen2.5:1.5b` keeps notes on-device. Cheaper too: zero per-token cost.
Trade-off is quality — Qwen 2.5 1.5B handles structure-extraction recipes well but struggles with
nuanced prose rewrites. Use cloud providers for translation / proofreading.

See `cookbook/04-cjk-proofread.yml` for the local-first pattern.

### Tag-driven workflows

`trigger: on-tag-add` + `tag: meeting` lets you tag a freshly-typed meeting note `#meeting` and
trigger a "summarize + extract action items" recipe. Composes naturally with the write-cap (one
note touched = `write-cap: 1` is enough).

See `cookbook/06-meeting-notes-summary.yml`.

---

## Debugging recipes

- **The trace view is your debugger.** Every model call, every tool call, every tool result is
  there. Token counts and cost estimates per step.
- **Click "Run now" in Settings → Recipes** to test a recipe without waiting for its trigger.
- **Models lie about doing tool calls they didn't.** If the trace doesn't show a `tool_call` step,
  the call didn't happen — even if the model's text claims it did. Re-run with a stronger prompt.
- **Bad cron expressions are caught at parse time** (you'll see a YAML error in the recipe row).
- **Bad globs match nothing silently.** `match: "*.md"` only matches the workspace root, not subfolders;
  use `match: "**/*.md"` or `match: "daily/**/*.md"`.
- **`{{date:…}}` uses chrono format strings**, not strftime. `%Y-%m-%d` becomes `YYYY-MM-DD`.

---

## What recipes can't do

By design:

- **No multi-step orchestration across recipes.** Each run is one prompt → one tool loop. If you
  want "Recipe A then Recipe B," chain them via the trace: Recipe B reads `read_agent_trace` of
  Recipe A's run.
- **No external HTTP calls from the prompt.** The model only has the tools listed above. If you
  need to fetch from an external API, write a custom MCP tool (see the `solomd-mcp` source).
- **No long-running background work.** Recipes are bounded by the model's context window and
  the tool-loop cap (default 8 round-trips). Long jobs should be split into multiple scheduled
  runs.
- **No mutation of files outside the workspace.** The `resolve_in_workspace` check rejects any
  path that escapes the canonical workspace root.

---

## Related docs

- `docs/roadmap.md` — v4.0 plan + the strategic principles behind the safety model.
- `mcp-server/README.md` — the MCP surface for external clients (Claude Desktop, etc.).
- `app/src-tauri/src/recipes.rs` — schema definition (Rust types are the source of truth).
- `app/src-tauri/cookbook/` — every bundled recipe template.
- `scripts/v4-self-test.sh` — one-shot pass/fail across all 5 pillars.
  Run `./scripts/v4-self-test.sh` for the fast lane (~30s),
  `--with-release` to also link-check `cargo build --release` for the bin
  + mcp-server + frontend, or `--with-ollama` to add a live Ollama smoke test.
  Definition-of-Done for v4.0 requires this script to exit 0.
