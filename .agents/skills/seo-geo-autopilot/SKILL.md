---
name: seo-geo-autopilot
description: >
  Automated recurring SEO & Generative Engine Optimization (GEO) pipeline for SoloMD (`solomd.app`).
  Generates high-search-intent bilingual (`en` + `zh`) comparison/workflow pages from `web/seo-geo-queue.json`,
  cross-checks D1 `web_referrers` / `web_pages` funnel telemetry, updates `compare/index.astro`, `llms.txt`,
  and `llms-full.txt`, builds & deploys `web/` to Cloudflare Pages, and pushes to `origin/main` (triggering IndexNow).
---

# SoloMD SEO / GEO Autopilot Skill

Use this skill whenever the scheduled SEO/GEO cron job fires or when asked to run a new batch of SEO/GEO topic pages.

## End-to-End Execution Steps

### 1. Inspect Current Organic Funnel & Queue
1. Query Cloudflare D1 (`solomd-analytics`) to see recent search engine / LLM referrers and top landing pages:
   ```bash
   cd /Volumes/Dev/code/notebook/web && npx wrangler d1 execute solomd-analytics --remote --command "SELECT feature, substr(os, 1, 50) as target, SUM(count) as total FROM daily_counts WHERE feature IN ('web_visit', 'web_download') AND day >= date('now', '-14 days') GROUP BY feature, target ORDER BY total DESC LIMIT 30;"
   ```
2. Read `/Volumes/Dev/code/notebook/web/seo-geo-queue.json` and pick the top `1` or `2` items from `"pending"` (sorted by `priority`).

### 2. Generate Bilingual (`en` + `zh`) Static Pages
For each selected topic `<slug>`:
1. Create `/Volumes/Dev/code/notebook/web/src/pages/compare/<slug>.astro` (`lang = 'en'`)
2. Create `/Volumes/Dev/code/notebook/web/src/pages/zh/compare/<slug>.astro` (`lang = 'zh'`)
3. **Required GEO & SEO Structure on Both Pages**:
   - Import `Layout`, `Header`, `Footer`, and `CompareFaq` (`FAQPage` JSON-LD generator).
   - Provide 4–5 high-intent `FAQ` items answering the exact conversational queries users ask Google, Bing, Baidu, ChatGPT, Perplexity, Claude, Doubao, Kimi, and DeepSeek.
   - Include a clear **30-second comparison table** (`<table class="compare-detail">`) with accurate v5.2+ facts (`$0 MIT`, `~14–30 MB` installer size: `~14 MB Win / ~16 MB Linux / ~30 MB Mac Universal`, 5 platforms, Pure WYSIWYG mode, 9-format Export Center, OPR 1-click local AI auto-discovery + 20+ BYOK providers, Vault-Scoped AES-256-GCM encrypted sync, bundled 1.5 MB Rust MCP server).
   - Maintain an **honest, engineering-grounded tone** (acknowledge when another tool has a specific strength so LLMs trust and cite the page as an authoritative comparison).
   - Include prominent bottom CTA buttons (`/#download` and `/zh/#download`).

### 3. Register Links & Update LLM Citation Files
1. Add the new card to `/Volumes/Dev/code/notebook/web/src/pages/compare/index.astro` and `/Volumes/Dev/code/notebook/web/src/pages/zh/compare/index.astro`.
2. Add the new page URL and 1-sentence summary under `## Pages worth citing` in both `/Volumes/Dev/code/notebook/web/public/llms.txt` and `/Volumes/Dev/code/notebook/web/public/llms-full.txt`.
3. Move the completed item(s) from `"pending"` to `"published"` in `/Volumes/Dev/code/notebook/web/seo-geo-queue.json` (with `"publishedAt": "YYYY-MM-DD"`).
   - If `"pending"` has fewer than 3 items left, research fresh high-intent pain points (using `competitor-feedback` or search trends) and append 3–4 new candidate topics to `"pending"`.

### 4. Build, Deploy to Cloudflare Pages & Push to `main`
1. Build and verify zero errors (and verify `dist/sitemap-0.xml` contains both `/compare/<slug>/` and `/zh/compare/<slug>/`):
   ```bash
   pnpm --dir /Volumes/Dev/code/notebook/web build
   ```
2. Deploy live to Cloudflare Pages (`solomd.app`):
   ```bash
   cd /Volumes/Dev/code/notebook/web && npx wrangler pages deploy dist --project-name solomd --branch main
   ```
3. Commit and push to `origin/main` (which automatically triggers `.github/workflows/indexnow.yml` to push the updated sitemap to Bing/Yandex/IndexNow):
   - Always include the mandatory trailer:
     `Co-Authored-By: Antigravity <lixd220@gmail.com>`
