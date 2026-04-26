/**
 * Typed wrappers around browser.storage.local.
 *
 * One source of truth for the keys the extension persists. Keep this file
 * dependency-light — it's loaded by the popup, options page, background
 * worker and content script.
 */
import browser from 'webextension-polyfill';

export interface ClipperSettings {
  /** Base URL of the SoloMD capture endpoint, e.g. http://127.0.0.1:7777 */
  endpoint: string;
  /** Bearer token copied from SoloMD Settings → Integrations. */
  token: string;
  /**
   * Optional sub-folder (relative to the workspace inbox folder) under which
   * captures should land. Empty string = root of inbox folder.
   */
  subfolder: string;
  /** Show a desktop notification on success. Default true. */
  notifyOnSuccess: boolean;
  /** UI language: 'en' | 'zh' | 'auto' (auto-pick from browser). */
  locale: 'en' | 'zh' | 'auto';
}

export const DEFAULT_SETTINGS: ClipperSettings = {
  endpoint: 'http://127.0.0.1:7777',
  token: '',
  subfolder: '',
  notifyOnSuccess: true,
  locale: 'auto',
};

const KEY = 'solomd-clipper-settings';

export async function loadSettings(): Promise<ClipperSettings> {
  const got = (await browser.storage.local.get(KEY)) as Record<string, unknown>;
  const raw = got[KEY] as Partial<ClipperSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
}

export async function saveSettings(s: ClipperSettings): Promise<void> {
  await browser.storage.local.set({ [KEY]: s });
}

/** Helper for the options page — only update fields we provide. */
export async function patchSettings(patch: Partial<ClipperSettings>): Promise<ClipperSettings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await saveSettings(next);
  return next;
}
