# Sample agent recipes

Reference recipes for v4.0 Pillar 2 (Agent Recipes). To enable one in
your vault, copy it (renaming away the `.example` suffix) into
`<your vault>/.solomd/agents/`.

These ship under the app's source tree purely so they're versioned
with the schema. SoloMD's recipe loader scans
`<workspace>/.solomd/agents/` only — files in this directory don't
auto-fire.

| File | Trigger | What it does |
|---|---|---|
| `_sample-weekly-review.yml.example` | `schedule` (Sundays 18:00) | Summarises the week's `daily/` notes into `weekly/YYYY-WW.md`. |

The full schema lives in `/tmp/solomd-v4-contracts.md` §C4 and
`docs/roadmap.md`'s Pillar 2 section.
