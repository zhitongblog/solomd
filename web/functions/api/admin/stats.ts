/**
 * GET /api/admin/stats — aggregate read endpoint.
 *
 * Auth: Authorization: Bearer <ADMIN_TOKEN>
 *
 * Query params:
 *   range = "1h" | "24h" | "7d" | "30d" | "90d"   (default: "7d")
 *   limit = number (default 50, capped to 200)
 *
 * Returns JSON:
 *   {
 *     range, since, until,
 *     totals: { events, unique_devices, active_today, active_7d },
 *     events: [{ event, count, unique_devices }],     // top by count
 *     versions: [{ app_version, count }],
 *     os: [{ os, count }],
 *     locales: [{ locale, count }],
 *     daily: [{ day, events, unique_devices }],
 *   }
 */

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Bearer realm="solomd-admin"',
    },
  });
}

function checkAuth(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // Constant-time compare via lengths + char loop (Workers don't expose
  // crypto.timingSafeEqual; this is good enough for a 32-byte token).
  const got = m[1];
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!checkAuth(request, env.ADMIN_TOKEN)) return unauthorized();

  const url = new URL(request.url);
  const rangeKey = url.searchParams.get('range') || '7d';
  const rangeMs = RANGE_MS[rangeKey] ?? RANGE_MS['7d'];
  const until = Date.now();
  const since = until - rangeMs;

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);

  const dayStartUtc = (() => {
    const d = new Date(until);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const sevenDaysAgo = until - 7 * 24 * 60 * 60 * 1000;

  const [
    totals,
    events,
    versions,
    osBreakdown,
    locales,
    daily,
    activeToday,
    active7d,
  ] = await Promise.all([
    env.DB.prepare(
      'SELECT COUNT(*) AS events, COUNT(DISTINCT anon_id) AS unique_devices FROM events WHERE ts >= ? AND ts <= ?',
    )
      .bind(since, until)
      .first<{ events: number; unique_devices: number }>(),
    env.DB.prepare(
      `SELECT event, COUNT(*) AS count, COUNT(DISTINCT anon_id) AS unique_devices
         FROM events
        WHERE ts >= ? AND ts <= ?
        GROUP BY event
        ORDER BY count DESC
        LIMIT ?`,
    )
      .bind(since, until, limit)
      .all<{ event: string; count: number; unique_devices: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(app_version, 'unknown') AS app_version, COUNT(*) AS count
         FROM events
        WHERE ts >= ? AND ts <= ?
        GROUP BY app_version
        ORDER BY count DESC
        LIMIT 30`,
    )
      .bind(since, until)
      .all<{ app_version: string; count: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(os, 'unknown') AS os, COUNT(*) AS count
         FROM events
        WHERE ts >= ? AND ts <= ?
        GROUP BY os
        ORDER BY count DESC`,
    )
      .bind(since, until)
      .all<{ os: string; count: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(locale, 'unknown') AS locale, COUNT(*) AS count
         FROM events
        WHERE ts >= ? AND ts <= ?
        GROUP BY locale
        ORDER BY count DESC`,
    )
      .bind(since, until)
      .all<{ locale: string; count: number }>(),
    env.DB.prepare(
      `SELECT date(ts / 1000, 'unixepoch') AS day,
              COUNT(*) AS events,
              COUNT(DISTINCT anon_id) AS unique_devices
         FROM events
        WHERE ts >= ? AND ts <= ?
        GROUP BY day
        ORDER BY day`,
    )
      .bind(since, until)
      .all<{ day: string; events: number; unique_devices: number }>(),
    env.DB.prepare(
      'SELECT COUNT(DISTINCT anon_id) AS n FROM events WHERE ts >= ?',
    )
      .bind(dayStartUtc)
      .first<{ n: number }>(),
    env.DB.prepare(
      'SELECT COUNT(DISTINCT anon_id) AS n FROM events WHERE ts >= ?',
    )
      .bind(sevenDaysAgo)
      .first<{ n: number }>(),
  ]);

  const body = {
    range: rangeKey,
    since,
    until,
    totals: {
      events: totals?.events ?? 0,
      unique_devices: totals?.unique_devices ?? 0,
      active_today: activeToday?.n ?? 0,
      active_7d: active7d?.n ?? 0,
    },
    events: events.results || [],
    versions: versions.results || [],
    os: osBreakdown.results || [],
    locales: locales.results || [],
    daily: daily.results || [],
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};
