# Awesome-MCP-Servers community lists

`modelcontextprotocol/servers` removed its community section — the de facto
community indices are now three "awesome-mcp-servers" lists that collectively
have ~14k forks. Each has its own format conventions and category
taxonomies; this directory has SoloMD-styled entries for each.

| List | Forks | Best section for SoloMD | Entry file |
|---|---|---|---|
| **[punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)** | ~10.9k | `🧠 Knowledge & Memory` (or `📝 Note Taking`) | [`entry-punkpeye.md`](entry-punkpeye.md) |
| **[appcypher/awesome-mcp-servers](https://github.com/appcypher/awesome-mcp-servers)** | ~1.6k | `📝 Note Taking` | [`entry-appcypher.md`](entry-appcypher.md) |
| **[wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers)** | ~1.4k | `Community Servers` | [`entry-wong2.md`](entry-wong2.md) |

## Submission flow per list

Each list takes plain-PR submissions. Per the parent
[`marketplace/README.md`](../README.md), submission goes:

```bash
# Pick one — repeat per list.
gh repo fork punkpeye/awesome-mcp-servers --clone --remote
cd awesome-mcp-servers

# Manually insert the entry from entry-punkpeye.md into the right section
# (alphabetical inside the section). Most lists use alphabetical-by-name.

git checkout -b add-solomd
git add README.md
git commit -m "Add SoloMD MCP server"
git push -u origin add-solomd
gh pr create --title "Add SoloMD MCP server (Markdown vault with 13 tools)" \
             --body-file ../marketplace/awesome-mcp/pr-body.md
```

## PR body

[`pr-body.md`](pr-body.md) is reused across all 3 PRs (the same submitter
context applies to each).

## After acceptance

For each list that merges:

1. Update [`../README.md`](../README.md)'s status table.
2. Add a "Featured in" badge cluster to root README:
   ```markdown
   [![punkpeye/awesome-mcp-servers](https://img.shields.io/badge/Featured%20on-punkpeye%20awesome--mcp-blue)](https://github.com/punkpeye/awesome-mcp-servers#knowledge--memory)
   ```
