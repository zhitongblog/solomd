// id: K4
// title: <html lang> follows the UI language; zh toasts are Chinese (open / export / copy)
// timeout: 30000
const R = checks();
R.eq(document.documentElement.lang.toLowerCase().slice(0, 2), 'zh', 'html lang zh');
settings.setLanguage('de'); await sleep(200);
R.eq(document.documentElement.lang.toLowerCase().slice(0, 2), 'de', 'html lang de after switch');
settings.setLanguage('zh'); await sleep(200);
window.__regressToasts = [];
await fresh('toast.md', '# T\n');
window.__solomdSavePathOverride = path('_work/' + CHECK + '.html');
act('export.html');
await waitFor(() => window.__regressToasts.some((m) => /HTML/.test(m) && !/…/.test(m)), 15000, 200);
delete window.__solomdSavePathOverride;
const saved = await inv('plugin:clipboard-manager|read_text').catch(() => null);
act('export.copyMd'); await sleep(500);
if (saved != null) await inv('plugin:clipboard-manager|write_text', { text: saved });
const english = window.__regressToasts.filter((m) => /^[\x00-\x7F]+$/.test(m) && /[a-z]{3,}/i.test(m));
R.t(english.length === 0, 'toasts in zh: ' + JSON.stringify(window.__regressToasts));
return R.done();
