/**
 * POST helper for the SoloMD capture endpoint.
 *
 * Single source of truth for the wire format — keep aligned with
 * `app/src-tauri/src/capture_endpoint.rs::CaptureBody`.
 */
import type { ClipperSettings } from './storage.js';

export interface CapturePayload {
  /** YAML title, also used to derive the filename slug. */
  title: string;
  /** Raw markdown body (no front matter — server adds its own). */
  content: string;
  /** Source URL — copied into front matter `source:`. */
  url?: string;
  /** Tags — copied into front matter `tags: […]`. */
  tags?: string[];
  /** Whether the note should land in the inbox (default true). */
  inbox?: boolean;
}

export interface CaptureSuccess {
  ok: true;
  /** Absolute path the desktop app wrote the new note to. */
  path: string;
}

export type CaptureErrorKind =
  | 'not_configured'
  | 'endpoint_down'
  | 'bad_token'
  | 'no_workspace'
  | 'timeout'
  | 'network'
  | 'server';

export interface CaptureFailure {
  ok: false;
  kind: CaptureErrorKind;
  /** Best-available human-readable error string. */
  message: string;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

/** Health response from `GET /capture/health`. */
export interface HealthResponse {
  ok: true;
  version: string;
  workspace: string;
  inbox_folder: string;
  workspace_open: boolean;
}

const REQUEST_TIMEOUT_MS = 10_000;

function settingsAreReady(s: ClipperSettings): boolean {
  return Boolean(s.endpoint && s.endpoint.trim() && s.token && s.token.trim());
}

function joinUrl(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '');
  const s = suffix.replace(/^\/+/, '');
  return `${b}/${s}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classify(httpStatus: number, body: { error?: string } | null): CaptureErrorKind {
  if (httpStatus === 401) return 'bad_token';
  if (httpStatus === 503) return 'no_workspace';
  if (httpStatus === 0) return 'endpoint_down';
  if (httpStatus >= 500) return 'server';
  // 400 — usually a malformed body (we control the body, so this is a bug),
  // but bubble the server's message verbatim.
  if (httpStatus === 400 && body?.error) return 'server';
  return 'server';
}

/**
 * Fire a capture POST. Retries once on transient network errors before
 * giving up.
 */
export async function postCapture(
  settings: ClipperSettings,
  payload: CapturePayload,
): Promise<CaptureResult> {
  if (!settingsAreReady(settings)) {
    return {
      ok: false,
      kind: 'not_configured',
      message: 'endpoint URL or token not configured',
    };
  }
  // Build the inbox-prefixed sub-folder if the user set one. The server
  // accepts the bare filename + writes into <workspace>/<inbox_folder>/<file>;
  // we prepend a sub-folder by inlining it into the YAML — but the v2.4
  // endpoint doesn't yet take a sub-folder hint, so we just append it to
  // the title via a `path:` front-matter line that SoloMD's inbox triage
  // reads. (Right now the server stores at the inbox root; sub-folder
  // routing is roadmap.)
  // → keep payload as-is for forward compat; document in README.

  const url = joinUrl(settings.endpoint, '/capture');
  const body = JSON.stringify({
    title: payload.title,
    content: payload.content,
    url: payload.url,
    tags: payload.tags,
    inbox: payload.inbox ?? true,
  });

  let attempt = 0;
  // Single-retry loop. The server is loopback-only, so if it doesn't answer
  // on attempt 1 the user almost certainly has the endpoint disabled — the
  // retry is for the rare race where a tab woke up before the listener did.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.token}`,
        },
        body,
      });
      const text = await res.text();
      let parsed: { ok?: boolean; path?: string; error?: string } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (res.ok && parsed?.ok && parsed.path) {
        return { ok: true, path: parsed.path };
      }
      const kind = classify(res.status, parsed);
      const message = parsed?.error ?? `HTTP ${res.status}`;
      return { ok: false, kind, message };
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === 'AbortError';
      if (isAbort) {
        return { ok: false, kind: 'timeout', message: 'timeout' };
      }
      if (attempt >= 2) {
        return {
          ok: false,
          kind: 'endpoint_down',
          message: e instanceof Error ? e.message : String(e),
        };
      }
      // Tiny backoff, then retry once.
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Fire a `GET /capture/health` for the options page "Test connection" button. */
export async function getHealth(
  settings: ClipperSettings,
): Promise<{ ok: true; data: HealthResponse } | CaptureFailure> {
  if (!settingsAreReady(settings)) {
    return { ok: false, kind: 'not_configured', message: 'endpoint URL or token not configured' };
  }
  const url = joinUrl(settings.endpoint, '/capture/health');
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${settings.token}` },
    });
    const text = await res.text();
    let parsed: HealthResponse | { error?: string } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (res.ok && parsed && (parsed as HealthResponse).ok) {
      return { ok: true, data: parsed as HealthResponse };
    }
    const kind = classify(res.status, parsed as { error?: string } | null);
    const message =
      (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    return { ok: false, kind, message };
  } catch (e) {
    const isAbort = e instanceof DOMException && e.name === 'AbortError';
    if (isAbort) return { ok: false, kind: 'timeout', message: 'timeout' };
    return {
      ok: false,
      kind: 'endpoint_down',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
