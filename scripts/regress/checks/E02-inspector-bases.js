// id: E2 K4
// title: properties inspector lists front matter (zh labels, no English); bases view lists notes
const R = checks();
await open('Table Note.md');
settings.rightSidebarHidden = false;
if (!settings.showInspector) act('view.toggleInspector');
const insp = await waitFor(() => $('[data-rs-pane=inspector]'), 3000);
if (!R.t(!!insp, 'inspector pane shown')) return R.done();
await sleep(500);
const keys = $$('.prop-row__key', insp).map((e) => e.textContent.trim());
R.eq(keys, ['status', 'tags', 'type'], 'property rows');
await open('README.md');
await sleep(500);
const txt = insp.innerText.replace(/\s+/g, ' ');
const english = txt.match(/\b(No properties|Add one below|Status|Suggested|Add property|Text)\b[^。]*/g);
R.t(!english, 'inspector has no English UI strings in zh: ' + (english ? JSON.stringify(english) : 'ok') + ' | ' + txt.slice(0, 120));
act('bases.open');
const ok = await waitFor(() => APP.basesOpen && $$('.bases, [class*=bases]').some(vis), 3000);
R.t(!!ok, 'bases view opens');
await sleep(500);
const rows = $$('[class*=bases] tr, [class*=bases] [role=row]').length;
R.t(rows >= 5, 'bases lists notes (' + rows + ' rows)');
APP.basesOpen = false;
return R.done();
