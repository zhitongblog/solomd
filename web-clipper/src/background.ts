/**
 * Background script (Chrome MV3 service worker / Firefox MV2 event page).
 *
 * Owns:
 *   - context-menu items + their click handlers
 *   - keyboard-shortcut commands
 *   - the bridge between popup → content script → capture endpoint
 *   - desktop notifications (success / error toasts)
 */
import browser from 'webextension-polyfill';

// Type aliases for the namespaced types we need. The imported `browser`
// value is typed as `typeof globalThis.browser` (see types/webextension-polyfill.d.ts),
// so the nested namespaces declared on the global by
// @types/firefox-webext-browser are accessible via the type-position alias.
type BrowserTab = browser.tabs.Tab;

import { initI18n, t } from './lib/i18n.js';
import {
  postCapture,
  type CaptureErrorKind,
  type CapturePayload,
  type CaptureResult,
} from './lib/capture.js';
import { loadSettings } from './lib/storage.js';

type CaptureKind = 'page' | 'selection' | 'link';

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

const MENU_IDS = {
  page: 'solomd-clip-page',
  selection: 'solomd-clip-selection',
  link: 'solomd-save-link',
};

// ---------------------------------------------------------------------------
// Setup: install context menus + run i18n boot. Both browsers fire `onInstalled`
// at first install + on every extension update; we re-create the menus each
// time to absorb i18n string changes.
// ---------------------------------------------------------------------------

async function ensureContextMenus(): Promise<void> {
  await initI18n();
  try {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: MENU_IDS.page,
      title: t('clipper.menu.clipPage'),
      contexts: ['page'],
    });
    browser.contextMenus.create({
      id: MENU_IDS.selection,
      title: t('clipper.menu.clipSelection'),
      contexts: ['selection'],
    });
    browser.contextMenus.create({
      id: MENU_IDS.link,
      title: t('clipper.menu.saveLink'),
      contexts: ['page', 'link'],
    });
  } catch (e) {
    console.warn('[solomd-clipper] contextMenus setup failed', e);
  }
}

browser.runtime.onInstalled.addListener(() => {
  void ensureContextMenus();
});
browser.runtime.onStartup.addListener(() => {
  void ensureContextMenus();
});
// Service workers wake from a cold start by an event; the onInstalled hook
// already covers first-install. For Firefox event pages we still want the
// menus on every wake — so do an unconditional best-effort here.
void ensureContextMenus();

// ---------------------------------------------------------------------------
// Context-menu clicks.
// ---------------------------------------------------------------------------

browser.contextMenus.onClicked.addListener(
  (info: browser.contextMenus.OnClickData, tab?: BrowserTab) => {
    if (!tab) return;
    if (info.menuItemId === MENU_IDS.page) {
      void runCapture('page', tab);
    } else if (info.menuItemId === MENU_IDS.selection) {
      void runCapture('selection', tab);
    } else if (info.menuItemId === MENU_IDS.link) {
      // For "save link" via the link context, prefer the linked URL if any;
      // else save the current page URL.
      void runCapture('link', tab, info.linkUrl ?? undefined, info.linkText ?? undefined);
    }
  },
);

// ---------------------------------------------------------------------------
// Keyboard shortcuts.
// ---------------------------------------------------------------------------

browser.commands.onCommand.addListener(async (command: string) => {
  const tab = await activeTab();
  if (!tab) return;
  if (command === 'clip-selection') {
    await runCapture('selection', tab);
  } else if (command === 'save-link') {
    await runCapture('link', tab);
  }
});

// ---------------------------------------------------------------------------
// Popup → background message bridge. Popup posts {kind: 'capture', mode}.
// ---------------------------------------------------------------------------

interface CaptureMsg {
  kind: 'capture';
  mode: CaptureKind;
}
interface PingMsg {
  kind: 'ping';
}

browser.runtime.onMessage.addListener(async (raw: unknown): Promise<unknown> => {
  const msg = raw as CaptureMsg | PingMsg | { kind?: string };
  if ((msg as PingMsg).kind === 'ping') {
    return { ok: true };
  }
  if ((msg as CaptureMsg).kind === 'capture') {
    const tab = await activeTab();
    if (!tab) return { ok: false, error: 'no active tab' };
    return await runCapture((msg as CaptureMsg).mode, tab);
  }
  return undefined;
});

// ---------------------------------------------------------------------------
// Capture pipeline.
// ---------------------------------------------------------------------------

async function activeTab(): Promise<BrowserTab | undefined> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function ensureContentScript(tabId: number): Promise<void> {
  // Try a no-op message first — if the content script is already injected,
  // we skip the programmatic injection. This matters because re-injection
  // duplicates the message listener, leading to duplicate replies and
  // duplicate captures.
  try {
    const reply = await browser.tabs.sendMessage(tabId, { kind: 'ping' } as never);
    if (reply !== undefined) return;
  } catch {
    /* not yet injected */
  }
  // Chrome MV3: scripting.executeScript. Firefox MV2: tabs.executeScript.
  // The polyfill exposes scripting under chrome only — branch.
  const anyBrowser = browser as unknown as {
    scripting?: {
      executeScript: (opts: { target: { tabId: number }; files: string[] }) => Promise<unknown>;
    };
    tabs: typeof browser.tabs & {
      executeScript?: (
        tabId: number,
        details: { file: string },
      ) => Promise<unknown>;
    };
  };
  if (anyBrowser.scripting?.executeScript) {
    await anyBrowser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } else if (anyBrowser.tabs.executeScript) {
    await anyBrowser.tabs.executeScript(tabId, { file: 'content.js' });
  } else {
    throw new Error('no scripting API available');
  }
}

async function extract(
  tabId: number,
  kind: 'extract-page' | 'extract-selection',
): Promise<ExtractResponse> {
  await ensureContentScript(tabId);
  try {
    const reply = (await browser.tabs.sendMessage(tabId, { kind } as never)) as ExtractResponse;
    return reply ?? { ok: false, error: 'no reply from content script' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function isoNow(): string {
  // ISO 8601 with seconds. Local timezone offset for human readability.
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const ah = pad(Math.floor(Math.abs(tzMin) / 60));
  const am = pad(Math.abs(tzMin) % 60);
  return `${y}-${mo}-${da}T${h}:${m}:${s}${sign}${ah}:${am}`;
}

/** Build the full markdown body, including the spec'd YAML front matter. */
function renderBody(args: {
  sourceUrl: string;
  capturedAt: string;
  title: string;
  body: string;
  inbox: boolean;
  byline?: string;
}): string {
  const { sourceUrl, capturedAt, title, body, inbox, byline } = args;
  const yaml = [
    '---',
    `source_url: ${yamlScalar(sourceUrl)}`,
    `captured_at: ${yamlScalar(capturedAt)}`,
    `title: ${yamlScalar(title)}`,
    byline ? `byline: ${yamlScalar(byline)}` : null,
    `inbox: ${inbox}`,
    '---',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  return `${yaml}\n${body.trim()}\n`;
}

function yamlScalar(s: string): string {
  // Same conservative logic as the Rust side: quote anything that could
  // confuse a plain-scalar parser. The Rust receiver tolerates any string
  // here — these YAML keys end up in a *body* that the receiver wraps with
  // its own front-matter block. So really only we read these. But we still
  // emit valid YAML so a manual eyeball-check renders cleanly.
  if (
    s === '' ||
    /[:\n"'#\[\]\{\},&*?|>!@`]/.test(s) ||
    s.startsWith(' ') ||
    s.endsWith(' ') ||
    /^\s/.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

async function runCapture(
  kind: CaptureKind,
  tab: BrowserTab,
  linkUrl?: string,
  linkText?: string,
): Promise<CaptureResult> {
  await initI18n();
  const settings = await loadSettings();
  if (!settings.endpoint || !settings.token) {
    notify(t('clipper.toast.error.notConfigured'), 'error');
    void browser.runtime.openOptionsPage();
    return { ok: false, kind: 'not_configured', message: 'not configured' };
  }

  const url = linkUrl ?? tab.url ?? '';
  const title = (tab.title ?? linkText ?? url).trim() || url;

  let payload: CapturePayload;

  if (kind === 'link') {
    const date = new Date().toISOString().slice(0, 10);
    const linkBody = `[${title}](${url}) — ${t('clipper.frontmatter.captured')} ${date}`;
    payload = {
      title,
      content: renderBody({
        sourceUrl: url,
        capturedAt: isoNow(),
        title,
        body: linkBody,
        inbox: true,
      }),
      url,
      tags: ['link'],
      inbox: true,
    };
  } else if (kind === 'selection' || kind === 'page') {
    if (!tab.id) {
      return failNotify({ ok: false, kind: 'server', message: 'no tab id' });
    }
    let extracted = await extract(
      tab.id,
      kind === 'selection' ? 'extract-selection' : 'extract-page',
    );
    // Selection mode falls back to full-page when the selection was empty.
    if (kind === 'selection' && !extracted.ok && extracted.error === 'no selection') {
      extracted = await extract(tab.id, 'extract-page');
    }
    if (!extracted.ok) {
      return failNotify({ ok: false, kind: 'server', message: extracted.error });
    }
    payload = {
      title: extracted.payload.title,
      content: renderBody({
        sourceUrl: extracted.payload.url,
        capturedAt: isoNow(),
        title: extracted.payload.title,
        body: extracted.payload.body,
        byline: extracted.payload.byline,
        inbox: true,
      }),
      url: extracted.payload.url,
      tags: ['clipped', kind === 'selection' ? 'selection' : 'page'],
      inbox: true,
    };
  } else {
    return failNotify({ ok: false, kind: 'server', message: `unknown capture kind: ${String(kind)}` });
  }

  const result = await postCapture(settings, payload);
  if (result.ok) {
    if (settings.notifyOnSuccess) {
      notify(`${t('clipper.toast.savedPrefix')}${payload.title}`, 'success');
    }
  } else {
    return failNotify(result);
  }
  return result;
}

function failNotify(result: CaptureResult & { ok: false }): CaptureResult {
  notify(messageForKind(result.kind, result.message), 'error');
  return result;
}

function messageForKind(kind: CaptureErrorKind, raw: string): string {
  switch (kind) {
    case 'not_configured':
      return t('clipper.toast.error.notConfigured');
    case 'endpoint_down':
      return t('clipper.toast.error.endpointDown');
    case 'bad_token':
      return t('clipper.toast.error.badToken');
    case 'no_workspace':
      return t('clipper.toast.error.noWorkspace');
    case 'timeout':
      return t('clipper.toast.error.timeout');
    case 'network':
      return t('clipper.toast.error.network');
    default:
      return `${t('clipper.toast.error.generic')}${raw}`;
  }
}

function notify(message: string, kind: 'success' | 'error'): void {
  try {
    void browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-128.png'),
      title: kind === 'success' ? t('clipper.popup.title') : 'SoloMD',
      message,
    });
  } catch (e) {
    console.warn('[solomd-clipper] notify failed', e);
  }
}
