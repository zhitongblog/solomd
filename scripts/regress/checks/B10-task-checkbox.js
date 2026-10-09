// id: B10 F-8
// title: task checkbox click toggles [ ]/[x] in the source — live editor and preview
const R = checks();
await fresh('task.md', '- [ ] open task\n- [x] done task\n');
settings.setViewMode('liveEdit');
const v = V();
v.dispatch({ selection: { anchor: v.state.doc.length } });
await sleep(300);
const cb = await waitFor(() => $('.cm-content .cm-task-checkbox'), 2000);
if (R.t(!!cb, 'live checkbox widget rendered')) {
  cb.click(); await sleep(200);
  R.eq(doc().split('\n')[0], '- [x] open task', 'live click checks');
}
settings.setViewMode('preview');
const box = await waitFor(() => $$('.preview input.task-list-item-checkbox, input.task-list-item-checkbox').filter(vis)[1], 3000);
if (R.t(!!box, 'preview checkbox rendered')) {
  R.t(!box.disabled, 'preview checkbox enabled');
  box.click(); await sleep(300);
  R.eq(tabs.activeTab.content.split('\n')[1], '- [ ] done task', 'preview click unchecks the 2nd task in the source');
}
settings.setViewMode('liveEdit');
return R.done();
