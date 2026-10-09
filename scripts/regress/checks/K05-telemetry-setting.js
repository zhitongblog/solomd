// id: K5
// title: the anonymous-usage switch is in Settings and reachable by search (not toggled on by the test)
const R = checks();
act('settings.open');
const search = await waitFor(() => $('.settings__search-input'), 3000);
search.value = '匿名'; search.dispatchEvent(new InputEvent('input', { bubbles: true })); await sleep(300);
const box = $$('.settings__body label').filter(vis).find((l) => /匿名/.test(l.textContent) && l.querySelector('input[type=checkbox]'));
R.t(!!box, 'search 匿名 finds the switch: ' + (box ? box.textContent.trim().slice(0, 30) : 'none'));
if (box) R.eq(box.querySelector('input').checked, settings.telemetryEnabled, 'checkbox mirrors telemetryEnabled');
APP.settingsOpen = false;
return R.done();
