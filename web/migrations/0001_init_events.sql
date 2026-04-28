-- SoloMD analytics: single events table.
--
-- Design choices:
--   * One row per event. Aggregations are computed at read time
--     (we never write back; D1 has 100k writes/day on the free tier
--      vs. 5M reads, so this is the right side to optimize).
--   * `props` is a JSON blob — small, low cardinality keys only
--     (locale, theme, view-mode, format). Anything PII-shaped is
--     blocked by the /api/track validator.
--   * `anon_id` is a UUIDv4 generated client-side and stored in
--     localStorage. It identifies a device, not a person; clearing
--     storage rotates it. We never derive it from any OS identifier.
--   * `ts` is server-side wall clock at insertion. Client clock is
--     untrusted.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,           -- ms since epoch (server clock)
  event TEXT NOT NULL,           -- e.g. "app_launched", "file_exported"
  anon_id TEXT NOT NULL,         -- client UUIDv4
  app_version TEXT,              -- e.g. "3.5.0"
  os TEXT,                       -- "mac" | "windows" | "linux" | "ipad" | "web"
  locale TEXT,                   -- "en" | "zh"
  props TEXT NOT NULL DEFAULT '{}'  -- JSON blob, validated to be small
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
CREATE INDEX IF NOT EXISTS idx_events_anon_ts ON events(anon_id, ts);
