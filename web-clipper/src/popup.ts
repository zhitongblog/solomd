/**
 * Popup script — wires the three big buttons to the background worker
 * and shows a paired/unpaired indicator at the bottom.
 */
import browser from 'webextension-polyfill';

import { getHealth } from './lib/capture.js';
import { initI18n, t } from './lib/i18n.js';
import { loadSettings } from './lib/storage.js';

async function applyI18n(): Promise<void> {
  await initI18n();
  document.title = t('clipper.popup.title');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = el.dataset.i18n;
    if (!key) continue;
    el.textContent = t(key);
  }
  const titleEl = document.getElementById('popup-title');
  if (titleEl) titleEl.textContent = t('clipper.popup.title');
}

async function refreshPairStatus(): Promise<void> {
  const status = document.getElementById('pair-status');
  if (!status) return;
  status.classList.remove('footer__pair--ok', 'footer__pair--err');
  status.textContent = t('clipper.popup.checking');
  const settings = await loadSettings();
  if (!settings.endpoint || !settings.token) {
    status.classList.add('footer__pair--err');
    status.textContent = t('clipper.popup.unpaired');
    return;
  }
  const res = await getHealth(settings);
  if (res.ok) {
    status.classList.add('footer__pair--ok');
    status.textContent = `${t('clipper.popup.paired')} · v${res.data.version}`;
  } else {
    status.classList.add('footer__pair--err');
    status.textContent = t('clipper.popup.unpaired');
  }
}

function bindActions(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.action'))) {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode as 'page' | 'selection' | 'link' | undefined;
      if (!mode) return;
      btn.disabled = true;
      try {
        await browser.runtime.sendMessage({ kind: 'capture', mode });
      } catch (e) {
        console.warn('[solomd-clipper popup] sendMessage failed', e);
      } finally {
        // Close immediately — the background worker shows the toast/notification
        // for both success and failure. Keeping the popup open longer feels
        // laggy and would require extra wiring to surface the result here.
        window.close();
      }
    });
  }

  const settingsBtn = document.getElementById('open-options');
  settingsBtn?.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
    window.close();
  });
}

(async () => {
  await applyI18n();
  bindActions();
  await refreshPairStatus();
})();
