/**
 * Cloudflare Pages Function: /api/stats
 *
 * Server-side proxy for GitHub stats. Fetches stars + total download count,
 * caches for 5 minutes in Cloudflare's edge cache. This means:
 *   - Clients are never rate-limited (they only hit our own domain)
 *   - GitHub API gets at most 1 req / 5 min per edge location (far below
 *     the 60/hour anon limit, or 5000/hour authenticated)
 *   - Stats update automatically every 5 minutes without any redeploy
 *
 * Resilience layers (added 2026-05-04 after homepage showed empty downloads
 * for everyone for ~24h while GitHub anon rate-limit was burned):
 *   1. If GITHUB_TOKEN env is set, send Bearer auth → 5000/hr ceiling.
 *   2. Successful responses are written to D1 (`stats_cache` row id='github')
 *      so we have last-known-good values to serve when GitHub is unreachable.
 *   3. On fetch failure, fall back to the D1 cached values rather than null.
 *      The visitor still sees real numbers; they just may be a few hours stale.
 *
 * Response: { stars, downloads, updated, latest_tag, latest_url, fresh }
 *   - `fresh: true` means the values came from a successful upstream fetch.
 *   - `fresh: false` means they came from the D1 fallback cache.
 *
 * Desktop app's "Check for updates" feature also calls this endpoint
 * (instead of api.github.com directly) to avoid hitting GitHub's
 * 60 req/hour unauth rate limit on the user's own IP.
 */

const REPO = 'zhitongblog/solomd';
const CACHE_TTL = 300; // 5 minutes (edge cache TTL on success)
const CACHE_TTL_STALE = 60; // 1 minute (when serving D1 fallback — refresh sooner)

interface StatsPayload {
  stars: number | null;
  downloads: number | null;
  latest_tag: string | null;
  latest_url: string | null;
}

interface StatsEnv {
  DB?: D1Database;
  GITHUB_TOKEN?: string;
}

export const onRequest: PagesFunction<StatsEnv> = async ({ request, env }) => {
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(request.url, request);

  // 1. Edge cache short-circuit
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 2. Try GitHub (with token if available)
  let payload: StatsPayload = {
    stars: null,
    downloads: null,
    latest_tag: null,
    latest_url: null,
  };
  let fetchOk = false;

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'SoloMD-stats-proxy',
      Accept: 'application/vnd.github+json',
    };
    if (env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    }
    const [repoRes, relRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}`, { headers }),
      fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers }),
    ]);

    let starsOk = false;
    let releasesOk = false;

    if (repoRes.ok) {
      const repo = (await repoRes.json()) as { stargazers_count?: number };
      payload.stars = repo.stargazers_count ?? null;
      starsOk = true;
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
        payload.downloads = total;
        const stable = releases.find((r) => !r.draft && !r.prerelease);
        if (stable) {
          payload.latest_tag = (stable.tag_name || '').replace(/^v/, '') || null;
          payload.latest_url = stable.html_url || null;
        }
        releasesOk = true;
      }
    }

    // Both endpoints must succeed for this to count as "fresh".
    // Otherwise the homepage would render half-stale (e.g. fresh stars but
    // stale downloads) without any way for the cache layer to tell.
    fetchOk = starsOk && releasesOk;
  } catch {
    // Network blip; payload stays null and we fall through to D1 fallback.
  }

  // 3. Persist on success / read on failure
  if (fetchOk && env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO stats_cache(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
        .bind('github', JSON.stringify(payload), Date.now())
        .run();
    } catch {
      // Cache-write failure is non-fatal; the response is still served.
    }
  } else if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT value FROM stats_cache WHERE key = ?`,
      )
        .bind('github')
        .first<{ value: string }>();
      if (row?.value) {
        const fallback = JSON.parse(row.value) as StatsPayload;
        // Merge: prefer freshly-fetched fields where they came back, fall
        // back to last-known-good for the ones that didn't. (E.g. stars
        // succeeded this call but releases got rate-limited — keep the
        // fresh stars + the cached downloads.)
        payload = {
          stars: payload.stars ?? fallback.stars,
          downloads: payload.downloads ?? fallback.downloads,
          latest_tag: payload.latest_tag ?? fallback.latest_tag,
          latest_url: payload.latest_url ?? fallback.latest_url,
        };
      }
    } catch {
      // D1 unreachable — return whatever we got from GitHub (possibly all-null).
    }
  }

  const body = JSON.stringify({
    ...payload,
    updated: new Date().toISOString(),
    fresh: fetchOk,
  });

  // Cache fresh responses for the full TTL; stale-fallback responses only
  // briefly so the next request retries upstream sooner.
  const ttl = fetchOk ? CACHE_TTL : CACHE_TTL_STALE;

  const response = new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
      'Access-Control-Allow-Origin': '*',
    },
  });

  if (fetchOk) {
    await cache.put(cacheKey, response.clone());
  }

  return response;
};
