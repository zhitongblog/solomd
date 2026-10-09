// id: B11
// title: [[wiki link]] is decorated and ⌘-click opens the target
const R = checks();
await open('README.md');
settings.setViewMode('liveEdit');
V().dispatch({ selection: { anchor: 0 } });
await sleep(300);
const link = await waitFor(() => $$('.cm-content .cm-wikilink').find((e) => (e.getAttribute('data-wikilink') || '').includes('Table Note')), 2000);
if (!R.t(!!link, 'wikilink decorated')) return R.done();
R.t(link.classList.contains('cm-wikilink--ok'), 'resolved link styled ok');
link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, metaKey: true, button: 0 }));
const ok = await waitFor(() => tabs.activeTab?.fileName === 'Table Note.md', 3000);
R.t(!!ok, '⌘-click opens Table Note.md (active ' + tabs.activeTab?.fileName + ')');
return R.done();
