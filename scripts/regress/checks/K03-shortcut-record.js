// id: K3
// title: shortcut recording — ⌘F reaches the recorder (conflict warning), a free chord rebinds, reset restores
const R = checks();
APP.openSettingsAt('keys');
await waitFor(() => $('.settings__page-title')?.textContent.trim() === '快捷键', 3000);
await sleep(300);
const rowFor = (label) => $$('.kb-row').find((r) => r.querySelector('.kb-row__label')?.textContent.trim() === label);
const row = rowFor('切换打字机模式') || rowFor('打字机模式') || $$('.kb-row').find((r) => /打字机/.test(r.textContent));
if (!R.t(!!row, 'typewriter row present')) return R.done();
const changeBtn = () => $$('button.kb-btn', row).find((b) => /更改|取消/.test(b.textContent));
const focusBefore = document.activeElement;
changeBtn().click(); await sleep(150);
R.t(!!$('.kb-chip--recording', row), 'recording armed');
key(document.body, 'f', { meta: true }); await sleep(200);
const body = $('.settings__body').innerText;
R.t(/⌘F[^\n]*占用/.test(body), '⌘F reached the recorder: conflict warning shown');
R.t(document.activeElement === focusBefore, 'focus did not jump (to the settings search)');
R.t(!!$('.kb-chip--recording', row), 'still armed after the conflict');
key(document.body, '9', { meta: true, alt: true, shift: true, code: 'Digit9' }); await sleep(200);
const kb = settings.keybindings['view.toggleTypewriter'];
R.t(JSON.stringify(kb || '').includes('9'), 'rebound to a ⌘⌥⇧9 chord: ' + JSON.stringify(kb));
R.t(!$('.kb-chip--recording', row), 'recording ended');
settings.setKeybinding('view.toggleTypewriter', undefined);
await sleep(100);
R.t(!settings.keybindings['view.toggleTypewriter'], 'reset to default');
APP.settingsOpen = false;
return R.done();
