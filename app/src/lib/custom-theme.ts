/**
 * Custom CSS theme injection.
 *
 * Lets the user point SoloMD at any .css file on disk; we read it via Tauri
 * and inject as a <style id="solomd-custom-theme"> element. Re-applying
 * replaces the previous content. Empty path removes the style element.
 */

import { invoke } from '@tauri-apps/api/core';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const STYLE_ID = 'solomd-custom-theme';

/**
 * A selector that (also) targets `body` — `body`, `body:root`, `html body`,
 * `body, .foo`, `body[data-theme]`, … SoloMD forces
 * `background-attachment: scroll !important` on body to stop drag flicker; a
 * theme that (re)sets it to `fixed` on body would override that and make the
 * whole viewport re-rasterize on every frame while dragging → flicker.
 */
const BODY_SELECTOR_RE = /(^|[,\s])body([\s:\[\]\.#>+~,]|$)/i;

/** A declaration block that sets `background-attachment: fixed` (own property
 *  or inside a `background` shorthand). */
const BODY_FIXED_RE = /background-attachment\s*:\s*fixed|background\s*:[^;{}]*\bfixed\b/i;

/**
 * Detect whether a custom theme sets `background-attachment: fixed` **on
 * body** (not any other element), and warn that it will re-enable drag
 * flicker. Called after a theme loads.
 */
function warnIfFixedAttachment(css: string) {
  if (!css) return;
  // Scan each `selector { declarations }` rule; only care if the selector
  // targets body and the block sets a fixed attachment.
  const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = RULE_RE.exec(css))) {
    const selector = match[1];
    const declarations = match[2];
    if (BODY_SELECTOR_RE.test(selector) && BODY_FIXED_RE.test(declarations)) {
      const { t } = useI18n();
      useToastsStore().warning(t('settings.customCssFixedWarning'), 5000);
      return;
    }
  }
}

interface FileReadResult {
  content: string;
  encoding: string;
  language: string;
  had_bom: boolean;
}

/**
 * Read `path` and inject it as the custom theme.
 *
 * Never throws: the `settings.customCssPath` watcher in App.vue calls this
 * fire-and-forget, so a deleted or unreadable file must not surface as an
 * unhandled rejection. Returns whether the CSS was actually applied — callers
 * that report back to the user (the Settings reload button) need to tell a
 * real reload from a silent failure, since the failure path *removes* the
 * theme rather than leaving stale CSS in place.
 */
export async function loadCustomTheme(path: string): Promise<boolean> {
  if (!path) {
    removeCustomTheme();
    return false;
  }
  try {
    const result = await invoke<FileReadResult>('read_file', { path });
    applyCss(result.content);
    warnIfFixedAttachment(result.content);
    return true;
  } catch (e) {
    console.error('Failed to load custom theme:', e);
    removeCustomTheme();
    return false;
  }
}

function applyCss(css: string) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export function removeCustomTheme() {
  const el = document.getElementById(STYLE_ID);
  if (el) el.remove();
}
