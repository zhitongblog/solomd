#!/usr/bin/env bash
#
# Pull competitor user-feedback from GitHub (the reliable, structured channel).
# Closed-source competitors (Typora/Obsidian/…) are listed at the end for the
# caller to scan via WebSearch/WebFetch — they have no public issue API.
#
# Usage:
#   scan.sh            # full scan: top-voted + newest open issues + latest release
#   scan.sh new        # incremental: only issues opened since the last scan
#   scan.sh full Logseq SiYuan   # restrict to named competitors
#
# Env: LIMIT=8 (issues per section). Writes the scan date to .last-scan so a
# later `scan.sh new` shows only what's appeared since.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REG="$DIR/competitors.json"
STATE="$DIR/.last-scan"
LIMIT="${LIMIT:-8}"
MODE="${1:-full}"; shift || true
ONLY="$*"   # optional space-separated competitor names

SINCE=""
if [ "$MODE" = "new" ] && [ -f "$STATE" ]; then SINCE="$(cat "$STATE")"; fi

gh_retry() { local out; for i in 1 2 3 4 5; do out=$(gh "$@" 2>/dev/null) && { printf '%s' "$out"; return 0; }; sleep 3; done; return 1; }
want() { [ -z "$ONLY" ] && return 0; case " $ONLY " in *" $1 "*) return 0;; *) return 1;; esac; }

echo "# Competitor feedback scan — $(date -u +%Y-%m-%dT%H:%MZ)"
[ -n "$SINCE" ] && echo "_Incremental: issues opened since $SINCE_"
echo

# ---- GitHub-hosted competitors ----
python3 -c "import json;d=json.load(open('$REG'));[print(c['name']+'\t'+c['github']) for c in d['competitors'] if c.get('github')]" | \
while IFS=$'\t' read -r NAME REPO; do
  want "$NAME" || continue
  echo "## $NAME — $REPO"; echo
  echo "### Top-voted open issues (proxy for unmet demand)"
  gh_retry search issues --repo "$REPO" --state open --sort reactions --order desc --limit "$LIMIT" --json title,createdAt,url \
    | python3 -c "import json,sys;r=json.load(sys.stdin);print('\n'.join('- %s  %s  (%s)'%(i['createdAt'][:10],i['title'],i['url']) for i in r) or '  (none / fetch failed)')" 2>/dev/null || echo "  (fetch failed)"
  echo
  if [ -n "$SINCE" ]; then
    echo "### New open issues since $SINCE"
    gh_retry search issues --repo "$REPO" --state open --created ">=$SINCE" --sort created --order desc --limit "$LIMIT" --json title,createdAt,url \
      | python3 -c "import json,sys;r=json.load(sys.stdin);print('\n'.join('- %s  %s  (%s)'%(i['createdAt'][:10],i['title'],i['url']) for i in r) or '  (none)')" 2>/dev/null || echo "  (fetch failed)"
  else
    echo "### Newest open issues"
    gh_retry search issues --repo "$REPO" --state open --sort created --order desc --limit "$LIMIT" --json title,createdAt,url \
      | python3 -c "import json,sys;r=json.load(sys.stdin);print('\n'.join('- %s  %s  (%s)'%(i['createdAt'][:10],i['title'],i['url']) for i in r) or '  (none / fetch failed)')" 2>/dev/null || echo "  (fetch failed)"
  fi
  echo
  echo "### Latest release"
  gh_retry release list -R "$REPO" --limit 1 --json tagName,name,publishedAt \
    | python3 -c "import json,sys;r=json.load(sys.stdin);print('\n'.join('- %s  %s  (%s)'%(x.get('tagName',''),x.get('name',''),(x.get('publishedAt','') or '')[:10]) for x in r) or '  (no GitHub releases)')" 2>/dev/null || echo "  (none)"
  echo; echo "---"; echo
done

# ---- Closed-source competitors (web channel) ----
echo "## Closed-source competitors — scan via WebSearch/WebFetch"
python3 -c "import json;d=json.load(open('$REG'));[print('- %s :: %s :: %s'%(c['name'],c.get('note',''),' '.join(c.get('web',[])))) for c in d['competitors'] if not c.get('github')]"
echo
echo "_Caller: for each above, run WebSearch \"<name> bug OR missing feature OR complaint $(date -u +%Y)\" and WebFetch the listed forum/reddit URLs, then extract themes._"

date -u +%Y-%m-%d > "$STATE"
echo
echo "_Scan state saved to .last-scan ($(cat "$STATE")). Next \`scan.sh new\` shows only newer issues._"
