-- Last-known-good cache for /api/stats so GitHub API blips
-- (rate-limit, transient 5xx) don't make the homepage display "⭐ -- · -- downloads"
-- to every visitor for the 5-minute edge-cache window.
--
-- Single row keyed by `key = 'github'`. We treat it as a tiny KV.

CREATE TABLE IF NOT EXISTS stats_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,        -- JSON blob: { stars, downloads, latest_tag, latest_url }
  updated_at INTEGER NOT NULL -- ms since epoch (server clock)
);
