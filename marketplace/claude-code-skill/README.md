# Claude Code Skill — SoloMD

## Status

⏳ **Ready to submit** once Anthropic's official Skill marketplace opens
public listings. As of writing the Skill mechanism is live in Claude Code
(SKILL.md under `~/.claude/skills/<name>/`) but the discoverable index is
still in early access — for now we ship the skill as a downloadable
folder users can drop into their Claude Code config, and we link to it
from our root README.

## What's here

| Path | Purpose |
|---|---|
| [`solomd/SKILL.md`](solomd/SKILL.md) | The skill itself. Frontmatter + instructions Claude Code reads when the skill is loaded. |
| [`solomd/install.sh`](solomd/install.sh) | One-liner that downloads `solomd-mcp` and wires it into `~/.claude/mcp.json`. |
| [`solomd/recipes/`](solomd/recipes/) | The same 11 YAML recipes as the Skill Pack — included here so the skill is self-contained. |

## Installing the skill in Claude Code

```bash
# Option A — Clone from the SoloMD repo (recommended; tracks updates):
git clone https://github.com/zhitongblog/solomd.git /tmp/solomd-skill
cp -r /tmp/solomd-skill/marketplace/claude-code-skill/solomd ~/.claude/skills/solomd
bash ~/.claude/skills/solomd/install.sh

# Option B — One-shot installer:
curl -L https://raw.githubusercontent.com/zhitongblog/solomd/main/marketplace/claude-code-skill/solomd/install.sh | bash
```

After install, start a new Claude Code session in your notes folder and
type `/skills`. `solomd` should appear in the list. Activate with
`/skills solomd` and Claude Code will load the SKILL.md instructions and
have the 13 MCP tools available.

## Submitting to the official marketplace (when it opens)

When Anthropic publishes the Skill marketplace submission process,
the path will look like:

1. Fork their skill registry repo.
2. Add `skills/solomd/` mirroring the `solomd/` directory here.
3. Open a PR with the body from [`pr-body.md`](pr-body.md) (below).

## Maintaining

When SoloMD's MCP gains/loses a tool, update:

- `solomd/SKILL.md` — the "Tools available" section.
- `solomd/recipes/` — copy from `app/src-tauri/cookbook/`.
- This README's tool count if it ever moves off 13.
