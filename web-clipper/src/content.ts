/**
 * Content script — runs in the page context to extract content for clipping.
 *
 * Listens for runtime messages from the background worker:
 *   { kind: 'extract-page' }      → Readability article → markdown
 *   { kind: 'extract-selection' } → user's text selection → markdown
 *
 * Returns one of:
 *   { ok: true, payload: { title, body, url, byline? } }
 *   { ok: false, error: string }
 */
import { Readability } from '@mozilla/readability';
import browser from 'webextension-polyfill';

import { elementToMarkdown, htmlToMarkdown } from './lib/markdown.js';

interface ExtractRequest {
  kind: 'extract-page' | 'extract-selection';
}

interface ExtractedPayload {
  title: string;
  body: string;
  url: string;
  byline?: string;
}

interface ExtractOk {
  ok: true;
  payload: ExtractedPayload;
}
interface ExtractErr {
  ok: false;
  error: string;
}
type ExtractResponse = ExtractOk | ExtractErr;

function safeTitle(): string {
  return (document.title || location.hostname || 'Untitled').trim();
}

function selectionAsHtml(): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const range = sel.getRangeAt(0);
  const frag = range.cloneContents();
  const wrap = document.createElement('div');
  wrap.appendChild(frag);
  return wrap.innerHTML;
}

function extractPage(): ExtractResponse {
  // Clone the document to keep Readability from mutating the live DOM —
  // it strips nodes as it scores them, which would visibly shred the page.
  const cloned = document.cloneNode(true) as Document;
  const reader = new Readability(cloned, {
    charThreshold: 200, // smallest article we'll accept (≈ 200 chars of body text)
    // Keep classes so our markdown converter can pull `language-foo` off
    // <pre>/<code>. Readability still strips most styling-only classes; this
    // just preserves the ones that carry semantic meaning for syntax highlighting.
    keepClasses: true,
  });
  const article = reader.parse();
  if (article && article.content && article.content.trim().length > 50) {
    const dom = new DOMParser().parseFromString(article.content, 'text/html');
    const root = dom.body;
    const md = elementToMarkdown(root, { baseUri: document.baseURI }, 'article');
    return {
      ok: true,
      payload: {
        title: (article.title || safeTitle()).trim(),
        body: md,
        url: location.href,
        byline: article.byline ?? undefined,
      },
    };
  }
  // Readability failed — fall back to whole-body conversion with the
  // banner-stripping aggressive pass.
  const md = htmlToMarkdown(document.body.outerHTML, { baseUri: document.baseURI }, 'full');
  if (!md.trim()) {
    return { ok: false, error: 'page has no extractable text content' };
  }
  return {
    ok: true,
    payload: {
      title: safeTitle(),
      body: md,
      url: location.href,
    },
  };
}

function extractSelection(): ExtractResponse {
  const html = selectionAsHtml();
  if (!html.trim()) {
    // Caller (background) should fall back to full-page when selection is
    // empty. We return a signal so the background can branch.
    return { ok: false, error: 'no selection' };
  }
  const md = htmlToMarkdown(html, { baseUri: document.baseURI }, 'article');
  return {
    ok: true,
    payload: {
      title: safeTitle(),
      body: md.trim(),
      url: location.href,
    },
  };
}

browser.runtime.onMessage.addListener((raw: unknown): Promise<ExtractResponse> => {
  const msg = raw as ExtractRequest;
  try {
    if (msg.kind === 'extract-page') {
      return Promise.resolve(extractPage());
    }
    if (msg.kind === 'extract-selection') {
      return Promise.resolve(extractSelection());
    }
    return Promise.resolve({ ok: false, error: `unknown message kind: ${String((msg as { kind?: string }).kind)}` });
  } catch (e) {
    return Promise.resolve({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
