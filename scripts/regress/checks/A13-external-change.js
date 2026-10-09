// id: A13
// title: a clean tab reloads an external edit; a dirty tab asks (忽略/从磁盘重新加载/覆盖外部修改)
// timeout: 25000
// The external writes are done by the runner (a foreign process): the app's own
// write_file is marked as a self-write and the watcher rightly ignores it.
const R = checks();
const rel = '_work/' + CHECK + '-ext.md';
if (PHASE === 1) {
  await fresh('ext.md', 'original\n');
  // watcher.rs treats an mtime within 2 s of our own write as a self-write.
  await sleep(2600);
  return { next: 1, host: { write: { [rel]: 'changed outside 1\n' } } };
}
if (PHASE === 2) {
  const t = tabs.activeTab;
  const reloaded = await waitFor(() => doc() === 'changed outside 1\n', 8000);
  R.t(!!reloaded, 'clean tab picked up the external change (doc=' + JSON.stringify(doc()) + ')');
  R.t(!tabs.isDirty(t.id), 'and stays clean');
  R.t(!APP.fileChangedOpen, 'no dialog for a clean tab');
  setDoc('local edit\n');
  await sleep(800);
  if (!R.t(tabs.isDirty(t.id), 'local edit makes the tab dirty')) return R.done();
  return { next: R.done(), host: { write: { [rel]: 'changed outside 2\n' } } };
}
const prev = CARRY;
const dlg = await waitFor(() => APP.fileChangedOpen, 8000);
R.t(prev.ok, 'phase 2: ' + prev.detail);
R.t(!!dlg, 'dirty tab: file-changed dialog shown');
const labels = $$('button').filter(vis).map((b) => b.textContent.trim());
R.t(['忽略', '从磁盘重新加载', '覆盖外部修改'].every((l) => labels.includes(l)), 'dialog buttons: ' + labels.filter((l) => /忽略|重新加载|覆盖/.test(l)).join('/'));
const reload = $$('button').find((b) => b.textContent.trim() === '从磁盘重新加载');
if (reload) {
  reload.click();
  R.t(!!(await waitFor(() => doc() === 'changed outside 2\n', 3000)), 'reload takes the disk version');
}
return R.done();
