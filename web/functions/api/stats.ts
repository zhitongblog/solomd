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
  let stars = 0;
  let downloads = 0;
  let latestTag: string | null = null;
  let latestUrl: string | null = null;

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
      stars = repo.stargazers_count || 0;
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
        for (const rel of releases) {
          for (const a of rel.assets || []) {
            downloads += a.download_count || 0;
          }
        }
        // First non-draft, non-prerelease release == latest stable
        // (releases are returned newest-first by published_at).
        const stable = releases.find((r) => !r.draft && !r.prerelease);
        if (stable) {
          latestTag = (stable.tag_name || '').replace(/^v/, '') || null;
          latestUrl = stable.html_url || null;
        }
      }
    }
  } catch {
    // Return zeros on failure — client can fall back to its own cache
  }

  const body = JSON.stringify({
    stars,
    downloads,
    updated: new Date().toISOString(),
    latest_tag: latestTag,
    latest_url: latestUrl,
  });

  const response = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
      // Permit the browser on the same origin; other origins are read-only JSON.
      'Access-Control-Allow-Origin': '*',
    },
  });

  // Cache at the edge for 5 min
  await cache.put(cacheKey, response.clone());

  return response;
};
