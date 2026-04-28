/**
 * Cloudflare Pages Function: /api/stats
 *
 * Server-side proxy for GitHub stats. Fetches stars + total download count,
 * caches for 5 minutes in Cloudflare's edge cache. This means:
 *   - Clients are never rate-limited (they only hit our own domain)
 *   - GitHub API gets at most 1 req / 5 min per edge location (far below
 *     the 60/hour anon limit)
 *   - Stats update automatically every 5 minutes without any redeploy
 *
 * Response: { stars, downloads, updated, latest_tag, latest_url }
 *
 * Desktop app's "Check for updates" feature also calls this endpoint
 * (instead of api.github.com directly) to avoid hitting GitHub's
 * 60 req/hour unauth rate limit on the user's own IP.
 */

const REPO = 'zhitongblog/solomd';
const CACHE_TTL = 300; // 5 minutes

export const onRequest: PagesFunction = async ({ request }) => {
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(request.url, request);

  // 1. Try edge cache
  let cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 2. Fetch from GitHub (server-side, User-Agent required)
  // null = "we don't know" (don't display anything / don't overwrite SSR value).
  // 0 used to be returned on failure, which the homepage interpreted as
  // "actually zero stars" and rendered ⭐ 0 / 0 downloads to every visitor
  // for the 5-minute cache window — bug seen 2026-04-28.
  let stars: number | null = null;
  let downloads: number | null = null;
  let latestTag: string | null = null;
  let latestUrl: string | null = null;
  let fetchOk = false;

  try {
    const headers = {
      'User-Agent': 'SoloMD-stats-proxy',
      Accept: 'application/vnd.github+json',
    };
    const [repoRes, relRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}`, { headers }),
      fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers }),
    ]);

    if (repoRes.ok) {
      const repo = (await repoRes.json()) as { stargazers_count?: number };
      stars = repo.stargazers_count ?? null;
      fetchOk = true;
    }

    if (relRes.ok) {
      const releases = (await relRes.json()) as Array<{
        tag_name?: string;
        html_url?: string;
        draft?: boolean;
        prerelease?: boolean;
        published_at?: string;
        assets?: Array<{ download_count?: number }>;
      }>;
      if (Array.isArray(releases)) {
        let total = 0;
        for (const rel of releases) {
          for (const a of rel.assets || []) {
            total += a.download_count || 0;
          }
        }
        downloads = total;
        // First non-draft, non-prerelease release == latest stable
        // (releases are returned newest-first by published_at).
        const stable = releases.find((r) => !r.draft && !r.prerelease);
        if (stable) {
          latestTag = (stable.tag_name || '').replace(/^v/, '') || null;
          latestUrl = stable.html_url || null;
        }
        fetchOk = true;
      }
    }
  } catch {
    // Leave everything null; fall through to short-cache failure response.
  }

  const body = JSON.stringify({
    stars,
    downloads,
    updated: new Date().toISOString(),
    latest_tag: latestTag,
    latest_url: latestUrl,
  });

  // Cache successful fetches for 5 minutes; failures get only 30 seconds
  // so a single rate-limit hit doesn't pin ⭐ 0 to the homepage for the
  // full TTL.
  const ttl = fetchOk ? CACHE_TTL : 30;

  const response = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
      // Permit the browser on the same origin; other origins are read-only JSON.
      'Access-Control-Allow-Origin': '*',
    },
  });

  if (fetchOk) {
    // Only cache successful responses at the edge.
    await cache.put(cacheKey, response.clone());
  }

  return response;
};
