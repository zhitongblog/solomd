# GitHub stars + downloads on a static homepage — the pattern

How [solomd.app](https://solomd.app) renders ⭐ stars and **N downloads** on its
landing page without burning the visitor's GitHub rate limit, going dark when
GitHub is slow, or showing "⭐ 0" when the API hiccups. This doc is the
copy-pasteable reference — adapt freely.

> **TL;DR:** **3 layers** — build-time SSR, edge-cached server proxy, client refresh.
> **2 footguns** — never confuse `null` with `0`; never let one rate-limit hit
> pin "⭐ 0" to your homepage for the cache TTL.

---

## The naive approach (don't do this)

```html
<script>
  fetch('https://api.github.com/repos/USER/REPO')
    .then(r => r.json())
    .then(j => document.getElementById('stars').textContent = '⭐ ' + j.stargazers_count);
</script>
```

Three reasons it breaks:

1. **GitHub rate-limits unauthenticated requests at 60/hour per IP**. Every
   visitor on a corporate VPN / mobile carrier NAT shares one IP. A popular
   homepage hits the cap in minutes; visitors then see no number.
2. **The `<script>` runs after first paint**. The badge area is empty for
   ~300 ms while DNS-resolving `api.github.com`, fetching, parsing — feels
   broken on slow connections.
3. **GitHub returns nothing for download counts** unless you walk every release
   asset; that's a *second* `/releases` request that compounds problem #1.

---

## The 3-layer pattern

```
                      Build time           Edge (5-min TTL)        Client
                          │                      │                    │
GitHub API  ──────────────┤   prerender numbers  │                    │
                          ▼  into HTML           │                    │
                    ┌──────────────┐             │                    │
                    │  index.html  │  ──────────►│  static asset      │
                    │  ⭐ 4.7k     │             │   served from edge │
                    │  3.2k dl     │             │                    │
                    └──────────────┘             │                    │
                                                 │                    │
                                                 │   GET /api/stats   │
                                                 │  ◄─────────────────┤  (after first paint)
                                                 │                    │
                                                 │  if cached  ──────►│  refresh badges
GitHub API  ◄──── if not cached, fetch +         │                    │  if numbers > 0
                  cache for 300s
```

Each layer covers what the others miss:

| Layer        | Solves                                              | Failure mode                          |
|--------------|------------------------------------------------------|---------------------------------------|
| **Build-time SSR** | Numbers visible on first paint, no JS required, works for crawlers / RSS readers / preview cards | Stale until next deploy (acceptable — vanity numbers) |
| **Edge proxy** | Visitors hit your domain, never `api.github.com`. One GitHub call per region per 5 min. | One regional cold-cache miss per 5 min — invisible to users |
| **Client refresh** | Stale-while-static — page can show today's number even if last deploy was last week | If `/api/stats` 503s, the build-time number stays — never *worse* than SSR |

---

## Code

### 1. Edge proxy — Cloudflare Pages Function

`web/functions/api/stats.ts`:

```ts
const REPO = 'USER/REPO';
const CACHE_TTL = 300;             // seconds — 5 minutes

export const onRequest: PagesFunction = async ({ request }) => {
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(request.url, request);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // null = "we don't know" — clients then keep the build-time number on screen.
  // Returning 0 used to mean "actually zero stars" downstream and rendered
  // "⭐ 0 / 0 downloads" to every visitor for the full TTL after a transient
  // GitHub blip. Bug seen once; never again. (See footgun #1 below.)
  let stars: number | null = null;
  let downloads: number | null = null;
  let fetchOk = false;

  try {
    const headers = {
      'User-Agent': 'YOUR-APP-stats-proxy',  // GitHub requires a UA
      Accept: 'application/vnd.github+json',
    };
    const [repoRes, relRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}`, { headers }),
      fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers }),
    ]);

    if (repoRes.ok) {
      const repo = await repoRes.json() as { stargazers_count?: number };
      stars = repo.stargazers_count ?? null;
      fetchOk = true;
    }
    if (relRes.ok) {
      const releases = await relRes.json() as Array<{ assets?: Array<{ download_count?: number }> }>;
      let total = 0;
      for (const rel of releases) for (const a of rel.assets || []) total += a.download_count || 0;
      downloads = total;
      fetchOk = true;
    }
  } catch { /* leave nulls */ }

  const body = JSON.stringify({ stars, downloads, updated: new Date().toISOString() });

  // 5 min on success, 30 s on failure — so a single bad request can't pin
  // bad numbers to the homepage. (Footgun #2.)
  const ttl = fetchOk ? CACHE_TTL : 30;
  const response = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
      'Access-Control-Allow-Origin': '*',
    },
  });

  if (fetchOk) await cache.put(cacheKey, response.clone());
  return response;
};
```

**Adapt to other stacks:**
- **Vercel Edge Function**: same code, `export default async function handler(req)` signature, use `unstable_cache` or set the `Cache-Control` header (Vercel CDN respects `s-maxage`).
- **Netlify Edge Function**: same, with `export default async (req, ctx) => …` and `Netlify-CDN-Cache-Control` for the edge cache.
- **AWS CloudFront + Lambda@Edge**: hand the response with the same `Cache-Control` and CloudFront caches it on the same TTL.

### 2. Build-time SSR — Astro example

`web/src/components/Hero.astro` (frontmatter — runs at build time):

```astro
---
const REPO = 'USER/REPO';

let initialStars = 0;
let initialDownloads = 0;
try {
  const [repoRes, relRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${REPO}`),
    fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`),
  ]);
  if (repoRes.ok) initialStars = (await repoRes.json()).stargazers_count || 0;
  if (relRes.ok) {
    for (const rel of await relRes.json())
      for (const a of rel.assets || [])
        initialDownloads += a.download_count || 0;
  }
} catch {}

const fmtStars = (n: number) => n >= 1000 ? `⭐ ${(n/1000).toFixed(1)}k` : `⭐ ${n}`;
const fmtDl    = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}k downloads` : `${n} downloads`;
const initialStarsText     = initialStars     > 0 ? fmtStars(initialStars)         : '';
const initialDownloadsText = initialDownloads > 0 ? fmtDl(initialDownloads)        : '';
---

<div class="hero__badge">
  beta · <span id="hero-stars">{initialStarsText}</span>
       · <span id="hero-dl-count">{initialDownloadsText}</span>
</div>
```

**For Next.js**: same code in a Server Component. **For SvelteKit**: same code in `+page.server.ts`. **For Hugo / Jekyll / 11ty**: shell out at build time and inject via templating.

### 3. Client refresh — vanilla, ~30 lines

```html
<script>
(function () {
  fetch('/api/stats')
    .then(r => r.ok ? r.json() : null)
    .then(stats => {
      if (!stats) return;

      // CRITICAL: gate with `> 0`, not `!= null`. The /api/stats fallback used
      // to serve {stars: 0, downloads: 0} on GitHub failure — that's
      // numerically valid but visually meaningless ("⭐ 0") and would clobber
      // the build-time number already on screen. Bug seen 2026-04-28.
      if (typeof stats.stars === 'number' && stats.stars > 0) {
        var el = document.getElementById('hero-stars');
        if (el) el.textContent = stats.stars >= 1000
          ? '⭐ ' + (stats.stars/1000).toFixed(1) + 'k'
          : '⭐ ' + stats.stars;
      }
      if (typeof stats.downloads === 'number' && stats.downloads > 0) {
        var el2 = document.getElementById('hero-dl-count');
        if (el2) el2.textContent = stats.downloads >= 1000
          ? (stats.downloads/1000).toFixed(1) + 'k downloads'
          : stats.downloads + ' downloads';
      }
    })
    .catch(function () { /* fall back to the build-time numbers */ });
})();
</script>
```

No framework, no bundle bloat, ~700 bytes inline. The `is:inline` (Astro) /
`<script>` tag (any HTML) directive ensures it ships verbatim, doesn't get
hoisted into a giant runtime, and runs on first paint.

---

## Footguns we hit (and fixed)

### Footgun 1 — `null` vs `0`

The original `/api/stats` returned `{stars: 0, downloads: 0}` when the GitHub
fetch failed. That's *numerically valid* but means two different things:

- "GitHub said you have 0 stars" (real)
- "We couldn't reach GitHub" (a server bug)

The client side then unconditionally clobbered the build-time SSR number with
`0`, so a single bad fetch pinned **⭐ 0 · 0 downloads** to the homepage for
the full 5-minute cache TTL. Looked like the project was dead.

**Fix in two places:**

- Server returns `null` on failure (not `0`). `null` means "we don't know."
- Client checks `typeof stats.stars === 'number' && stats.stars > 0` before
  overwriting — both `null` and `0` skip the update, leaving the SSR number
  on screen.

Counts that *legitimately* are 0 (a brand-new repo) are now hidden until
they're not — fine for a vanity badge.

### Footgun 2 — caching failures for the full TTL

If we cache *every* response for 5 min, one transient GitHub 503 means 5
minutes of "GitHub is slow → homepage thinks numbers are missing." Easy fix:
cache success for 300s, cache failure for 30s (or don't cache failures at
all):

```ts
const ttl = fetchOk ? 300 : 30;
const response = new Response(body, { headers: { 'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}` }});
if (fetchOk) await cache.put(cacheKey, response.clone());
```

### Footgun 3 — forgetting the `User-Agent`

GitHub returns `403 Forbidden` for unauthenticated requests without a
`User-Agent` header. Edge runtimes don't always set one for you. Always send:

```ts
headers: { 'User-Agent': 'YOUR-APP-stats-proxy' }
```

### Footgun 4 — `releases?per_page=100` only goes back ~100 releases

For a young project, fine. For a 5-year-old project with 200+ releases you'll
miss the older ones. Either paginate (cheap, your edge fetcher does it once
per 5 min):

```ts
let page = 1, all = [];
while (true) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
  const batch = await r.json();
  if (!batch.length) break;
  all.push(...batch);
  if (batch.length < 100) break;
  page++;
}
```

…or accept the cap and document it. We accept the cap; we tag ~6 minor
releases per year, so 100 is plenty for the next decade.

### Footgun 5 — the desktop app hitting GitHub directly for "Check for updates"

If your project also has a desktop / CLI app that wants to know "is there a
newer version?", point its updater at the **same `/api/stats` endpoint**, not
at `api.github.com`. The user's IP is already shared with the rest of their
office; without your proxy, every "check for updates" on Monday morning hits
the rate limit at the same time.

```ts
// In your app's auto-updater:
const r = await fetch('https://your-site.com/api/stats');
const { latest_tag } = await r.json();
if (latest_tag && semver.gt(latest_tag, CURRENT_VERSION)) prompt_update();
```

(Add `latest_tag` and `latest_url` fields to the `/api/stats` response — both
come from the same `/releases` data you're already fetching.)

---

## What this gives you

- **First-paint numbers** on every page load, every render path (HTML cache,
  preview card, RSS reader, screenshot bot).
- **Numbers that update every 5 minutes** without redeploying.
- **Zero GitHub rate-limit pressure** on visitors. Your edge function is the
  *only* IP hitting `api.github.com`, and it does so at most ~12 times per
  hour per region.
- **Graceful degradation** — GitHub down → SSR number stays on screen.
  Edge cache miss + GitHub down → SSR number stays on screen. Build-time
  fetch failed → JS quietly fills in. Three independent fallback paths,
  none of them require visitor action.

---

## Reference implementation

- **Edge proxy:** [`web/functions/api/stats.ts`](../web/functions/api/stats.ts)
- **Build-time SSR + client refresh:** [`web/src/components/Hero.astro`](../web/src/components/Hero.astro)
- **Live in production:** [solomd.app](https://solomd.app) — view source, look for `#hero-stars` / `#hero-dl-count` and `/api/stats`.

MIT-licensed alongside the rest of the project — use, fork, copy, adapt.
