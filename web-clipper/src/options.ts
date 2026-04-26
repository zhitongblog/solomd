/**
 * Options page — pair the clipper with a running SoloMD desktop instance.
 */
import { getHealth } from './lib/capture.js';
import { initI18n, t } from './lib/i18n.js';
import { loadSettings, patchSettings } from './lib/storage.js';

async function applyI18n(): Promise<void> {
  await initI18n();
  document.title = t('clipper.options.title');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = el.dataset.i18n;
    if (!key) continue;
    el.textContent = t(key);
  }
}

function $(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: ${id}`);
  return el as HTMLInputElement;
}

async function loadIntoForm(): Promise<void> {
  const s = await loadSettings();
  $('endpoint').value = s.endpoint;
  $('token').value = s.token;
  $('subfolder').value = s.subfolder;
  $('notify').checked = s.notifyOnSuccess;
  ($('locale') as unknown as HTMLSelectElement).value = s.locale;
}

function setStatus(text: string, kind: 'idle' | 'ok' | 'err'): void {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('status--ok', 'status--err');
  if (kind === 'ok') el.classList.add('status--ok');
  else if (kind === 'err') el.classList.add('status--err');
}

async function readForm() {
  const localeSel = $('locale') as unknown as HTMLSelectElement;
  return {
    endpoint: $('endpoint').value.trim(),
    token: $('token').value.trim(),
    subfolder: $('subfolder').value.trim(),
    notifyOnSuccess: $('notify').checked,
    locale: (['auto', 'en', 'zh'].includes(localeSel.value)
      ? (localeSel.value as 'auto' | 'en' | 'zh')
      : 'auto') as 'auto' | 'en' | 'zh',
  };
}

async function onTest(): Promise<void> {
  setStatus(t('clipper.options.testRunning'), 'idle');
  const form = await readForm();
  // Use the *current form* (not saved) so the test reflects what the user
  // typed, even if they haven't saved yet.
  const res = await getHealth({
    ...(await loadSettings()),
    endpoint: form.endpoint,
    token: form.token,
  });
  if (res.ok) {
    if (res.data.workspace_open) {
      setStatus(`${t('clipper.options.testOkPrefix')}${res.data.workspace}`, 'ok');
    } else {
      setStatus(t('clipper.options.testNoWorkspace'), 'err');
    }
  } else {
    setStatus(`${t('clipper.options.testFailPrefix')}${res.message}`, 'err');
  }
}

async function onSave(e: Event): Promise<void> {
  e.preventDefault();
  const form = await readForm();
  await patchSettings(form);
  // Re-apply i18n in case the user changed locale.
  await applyI18n();
  setStatus(t('clipper.options.saved'), 'ok');
}

(async () => {
  await applyI18n();
  await loadIntoForm();
  document.getElementById('settings-form')?.addEventListener('submit', onSave);
  document.getElementById('test-btn')?.addEventListener('click', onTest);
})();
