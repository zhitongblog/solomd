# SoloMD self-hosted analytics

The desktop app POSTs anonymous usage events to `solomd.app/api/track`.
Storage is a Cloudflare D1 database; the only consumer is the `/admin`
page on this site, gated by a bearer token.

## What gets sent

From `app/src/lib/telemetry.ts`, fire-and-forget POST with body:

```json
{
  "event": "app_launched",
  "anon_id": "uuidv4 in localStorage",
  "app_version": "3.5.0",
  "os": "mac" | "windows" | "linux" | "ipad" | "web",
  "locale": "en" | "zh",
  "props": { "theme": "dark", "live_preview": 1 }
}
```

What is **not** sent: IP, User-Agent, OS user, file paths, content of any
note, AI prompts/responses. The server-side validator (`functions/api/track.ts`)
also drops:
- events not matching `[a-z0-9_]{1,64}`
- non-UUIDv4 anon_ids
- prop keys longer than 32 chars or values longer than 256 chars
- more than 16 prop keys per event

The user can opt out at any time in Settings → 发送匿名使用数据
(default on, per `app/src/stores/settings.ts:193`).

## Architecture

```
┌─────────────┐  POST /api/track   ┌────────────────────┐
│  Tauri app  │ ─────────────────► │  CF Pages Function │ ──► D1 (events)
└─────────────┘   204 (always)     └────────────────────┘

┌─────────────┐  GET /admin        ┌────────────────────┐
│   browser   │ ─────────────────► │  Astro static page │
└─────────────┘                    └────────────────────┘
       │  Bearer ADMIN_TOKEN
       ▼
┌─────────────────────────┐
│ /api/admin/stats        │ ──► D1 aggregate query
│  (token-protected)      │
└─────────────────────────┘
```

## One-time setup (per-environment)

This applies to **production deployment** (Cloudflare Pages). Local
dev (`wrangler pages dev`) only needs the local-mode steps.

### 1. Create the D1 database

```bash
cd web
pnpm exec wrangler login          # opens a browser; one-time auth
pnpm exec wrangler d1 create solomd-analytics
```

The CLI prints something like:

```
[[d1_databases]]
binding = "DB"
database_name = "solomd-analytics"
database_id = "abcd1234-..."
```

Paste the `database_id` into `web/wrangler.toml` (replace
`REPLACE_WITH_DB_ID_FROM_WRANGLER_D1_CREATE`).

### 2. Apply the schema

```bash
# Production:
pnpm exec wrangler d1 execute solomd-analytics --remote --file=migrations/0001_init_events.sql

# Local dev (runs against a SQLite file in .wrangler/):
pnpm exec wrangler d1 execute solomd-analytics --local --file=migrations/0001_init_events.sql
```

### 3. Bind D1 to the Pages project

In the Cloudflare dashboard:

  Workers & Pages → solomd-web → Settings → Bindings → Add D1 database
    Variable name: `DB`
    D1 database:   `solomd-analytics`

(`wrangler.toml` declares the binding, but Pages projects created
before the wrangler.toml convention need this set in the dashboard
once. New projects pick it up from the file automatically.)

### 4. Set the admin token

Pick a long random token (32+ bytes). Then:

```bash
# Production secret (will prompt for the value):
pnpm exec wrangler pages secret put ADMIN_TOKEN --project-name solomd-web

# Local dev: edit web/.dev.vars (gitignored) — already has a placeholder.
```

### 5. Verify

```bash
# Tail local dev:
pnpm exec wrangler pages dev
# In another terminal:
curl -X POST http://localhost:8788/api/track \
  -d '{"event":"smoke","anon_id":"00000000-0000-4000-8000-000000000000"}'
curl http://localhost:8788/api/admin/stats \
  -H "Authorization: Bearer dev-test-token"
```

Production: open `https://solomd.app/admin/`, paste the token, expect
the dashboard to render with the events you just POSTed.

## Free-tier limits (D1, as of 2025)

| Resource     | Free tier     | Our headroom (3.4k installs, ~30 events/day each) |
|--------------|---------------|---------------------------------------------------|
| Storage      | 5 GB          | ~50M events @ ~100 B each                         |
| Reads/day    | 5,000,000     | dashboard reads only — not even close             |
| Writes/day   | 100,000       | ~30k events/day expected — 3× headroom            |

If we ever blow the write budget, the next step is batching writes in
the function (queue events to KV, flush every minute) — but at current
volume it's premature.

## Privacy invariant

Events are stored in D1 with `ts` as the only timestamp; we never log
the request's IP or User-Agent. Cloudflare's edge logs may keep IPs in
the access log per their default retention, but those logs are
separate from the events table and are not queryable from the
dashboard. If we ever need stricter guarantees we can disable Logpush
on the `solomd-web` project entirely.
