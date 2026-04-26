/**
 * In-page driver used by the live-Chrome smoke test (scripts/live-smoke.mjs).
 *
 * Mirrors the extension's content + background pipeline exactly — same
 * Readability options, same markdown.ts, same renderBody YAML shape,
 * same POST shape — but exposed as a `window.__solomdClipFor(endpoint, token)`
 * hook so the test can drive it without needing an extension context.
 */
import { Readability } from '@mozilla/readability';

import { elementToMarkdown, htmlToMarkdown } from '../src/lib/markdown.js';

interface CaptureResult {
  ok: boolean;
  status: number;
  body: unknown;
  payloadTitle: string;
}

function isoNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`;
}

function yamlScalar(s: string): string {
  if (s === '' || /[:\n"'#\[\]\{\},&*?|>!@`]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function renderBody(args: {
  sourceUrl: string;
  capturedAt: string;
  title: string;
  body: string;
}): string {
  const { sourceUrl, capturedAt, title, body } = args;
  return [
    '---',
    `source_url: ${yamlScalar(sourceUrl)}`,
    `captured_at: ${yamlScalar(capturedAt)}`,
    `title: ${yamlScalar(title)}`,
    'inbox: true',
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');
}

function extractPage(): { title: string; body: string; url: string } {
  const cloned = document.cloneNode(true) as Document;
  const reader = new Readability(cloned, { charThreshold: 200, keepClasses: true });
  const article = reader.parse();
  if (article && article.content && article.content.trim().length > 50) {
    const dom = new DOMParser().parseFromString(article.content, 'text/html');
    return {
      title: (article.title || document.title || 'Untitled').trim(),
      body: elementToMarkdown(dom.body, { baseUri: document.baseURI }, 'article'),
      url: location.href,
    };
  }
  return {
    title: (document.title || 'Untitled').trim(),
    body: htmlToMarkdown(document.body.outerHTML, { baseUri: document.baseURI }, 'full'),
    url: location.href,
  };
}

function extractSelection(): { title: string; body: string; url: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const wrap = document.createElement('div');
  wrap.appendChild(sel.getRangeAt(0).cloneContents());
  return {
    title: (document.title || 'Selection').trim(),
    body: htmlToMarkdown(wrap.innerHTML, { baseUri: document.baseURI }, 'article'),
    url: location.href,
  };
}

async function postCapture(
  endpoint: string,
  token: string,
  payload: { title: string; content: string; url: string; tags: string[]; inbox: boolean },
): Promise<CaptureResult> {
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, payloadTitle: payload.title };
}

declare global {
  interface Window {
    __solomdClipFor: (endpoint: string, token: string, mode: 'page' | 'selection') => Promise<CaptureResult>;
  }
}

window.__solomdClipFor = async (
  endpoint: string,
  token: string,
  mode: 'page' | 'selection',
): Promise<CaptureResult> => {
  let extracted: { title: string; body: string; url: string } | null;
  if (mode === 'selection') {
    extracted = extractSelection() ?? extractPage();
  } else {
    extracted = extractPage();
  }
  const content = renderBody({
    sourceUrl: extracted.url,
    capturedAt: isoNow(),
    title: extracted.title,
    body: extracted.body,
  });
  return await postCapture(endpoint, token, {
    title: extracted.title,
    content,
    url: extracted.url,
    tags: ['clipped', mode],
    inbox: true,
  });
};
