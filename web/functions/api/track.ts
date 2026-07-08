/**
 * POST /api/track  — accept one analytics event.
 *
 * Body shape (JSON):
 *   {
 *     event: string,                       // required, [a-z0-9_], <=64 chars
 *     anon_id: string,                     // required, UUIDv4
 *     app_version?: string,                // e.g. "3.5.0"
 *     os?: "mac"|"windows"|"linux"|"ipad"|"web",
 *     locale?: "en"|"zh",
 *     props?: Record<string, string|number|boolean>
 *   }
 *
 * Validation guards (everything else is silently dropped):
 *   - body parses as JSON < 4 KB
 *   - event matches /^[a-z0-9_]{1,64}$/
 *   - anon_id matches a UUIDv4 regex
 *   - props has at most 16 keys, each value < 256 chars when stringified
 *   - we never persist the request IP, User-Agent, or any header
 *
 * Why fail-open with 204: telemetry must never affect the user. Any
 * malformed call still returns 204 so a buggy SDK build can't be
 * detected by probing the endpoint.
 */

interface Env {
  DB: D1Database;
}

const EVENT_RE = /^[a-z0-9_]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OS_VALUES = new Set(['mac', 'windows', 'linux', 'ipad', 'web']);
const LOCALE_VALUES = new Set(['en', 'zh']);
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/i;
const MAX_BODY_BYTES = 4096;
const MAX_PROP_KEYS = 16;
const MAX_PROP_VALUE_CHARS = 256;

const NO_CONTENT: ResponseInit = {
  status: 204,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
};

export const onRequestOptions: PagesFunction<Env> = async () => new Response(null, NO_CONTENT);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Cap the body before parsing so a 100 MB POST can't tie up an isolate.
  const len = Number(request.headers.get('content-length') || '0');
  if (len > MAX_BODY_BYTES) return new Response(null, NO_CONTENT);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(null, NO_CONTENT);
  }
  if (!body || typeof body !== 'object') return new Response(null, NO_CONTENT);

  const event = typeof body.event === 'string' ? body.event : '';
  const anonId = typeof body.anon_id === 'string' ? body.anon_id : '';
  if (!EVENT_RE.test(event)) return new Response(null, NO_CONTENT);
  if (!UUID_RE.test(anonId)) return new Response(null, NO_CONTENT);

  const appVersion =
    typeof body.app_version === 'string' && VERSION_RE.test(body.app_version)
      ? body.app_version
      : null;
  const os = typeof body.os === 'string' && OS_VALUES.has(body.os) ? body.os : null;
  const locale =
    typeof body.locale === 'string' && LOCALE_VALUES.has(body.locale) ? body.locale : null;

  // Sanitize props: drop everything that doesn't round-trip safely.
  const cleanProps: Record<string, string | number | boolean> = {};
  if (body.props && typeof body.props === 'object') {
    let keys = 0;
    for (const [k, v] of Object.entries(body.props)) {
      if (keys >= MAX_PROP_KEYS) break;
      if (!/^[a-zA-Z0-9_]{1,32}$/.test(k)) continue;
      if (typeof v === 'string') {
        if (v.length > MAX_PROP_VALUE_CHARS) continue;
        cleanProps[k] = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        cleanProps[k] = v;
      } else if (typeof v === 'boolean') {
        cleanProps[k] = v;
      } else {
        continue;
      }
      keys += 1;
    }
  }

  try {
    await env.DB.prepare(
      'INSERT INTO events (ts, event, anon_id, app_version, os, locale, props) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(Date.now(), event, anonId, appVersion, os, locale, JSON.stringify(cleanProps))
      .run();
  } catch {
    // Swallow — telemetry must never break the caller. The 204 below
    // is identical to the success path so the client never branches
    // on the ingest health.
  }

  return new Response(null, NO_CONTENT);
};
