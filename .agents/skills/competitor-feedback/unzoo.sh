#!/usr/bin/env bash
#
# Thin wrapper over the local **Unzoo Browser REST API** (a real headless
# Chromium; handles JS-rendered pages, anti-bot, cookies — better than plain
# WebFetch for forums/Reddit). NOTE: unzoo is NOT exposed as `mcp__unzoo__*`
# MCP tools in this environment — it's this HTTP API at 127.0.0.1:9399.
#
# Usage:
#   unzoo.sh health
#   unzoo.sh search-web "Typora bug missing feature 2026"
#   unzoo.sh search-github "markdown editor WYSIWYG"
#   unzoo.sh fetch-web https://forum.obsidian.md/c/bug-reports/3
#   unzoo.sh fetch-github obsidianmd obsidian-releases
#   unzoo.sh discover-rss https://forum.typora.io
set -uo pipefail
BASE="${UNZOO_BASE:-http://127.0.0.1:9399/api/v1}"
TIMEOUT="${UNZOO_TIMEOUT:-45}"
jstr() { python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"; }
post() { curl -s --max-time "$TIMEOUT" -X POST "$BASE/$1" -H "Content-Type: application/json" -d "$2"; }

cmd="${1:-}"; arg="${2:-}"; arg2="${3:-}"
case "$cmd" in
  health)        curl -s --max-time 6 "$BASE/health" ;;
  search-web)    post search/web    "{\"query\":$(jstr "$arg")}" ;;
  search-github) post search/github "{\"query\":$(jstr "$arg")}" ;;
  fetch-web)     post fetch/web     "{\"url\":$(jstr "$arg")}" ;;
  fetch-github)  post fetch/github  "{\"owner\":$(jstr "$arg"),\"repo\":$(jstr "$arg2")}" ;;
  discover-rss)  post discover/rss  "{\"url\":$(jstr "$arg")}" ;;
  fetch-rss)     post fetch/rss     "{\"url\":$(jstr "$arg")}" ;;
  *) echo "usage: unzoo.sh {health|search-web Q|search-github Q|fetch-web URL|fetch-github OWNER REPO|discover-rss URL|fetch-rss URL}" >&2; exit 2 ;;
esac
