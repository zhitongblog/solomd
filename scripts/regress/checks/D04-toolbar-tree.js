// id: D4
// title: view.toggleToolbar and view.toggleFileTree; ⌘B toggles the tree exactly once and does not bold
const R = checks();
await fresh('cmdb.md', 'word\n');
const t0 = settings.toolbarHidden;
act('view.toggleToolbar'); await sleep(150);
R.eq(settings.toolbarHidden, !t0, 'toggleToolbar flips');
act('view.toggleToolbar'); await sleep(150);
const f0 = settings.showFileTree;
act('view.toggleFileTree'); await sleep(200);
R.eq(settings.showFileTree, !f0, 'toggleFileTree flips');
act('view.toggleFileTree'); await sleep(200);
const v = V(); v.focus(); v.dispatch({ selection: { anchor: 0, head: 4 } });
key(v.contentDOM, 'b', { meta: true }); await sleep(250);
R.eq(settings.showFileTree, !f0, '⌘B toggled the tree once');
R.eq(doc(), 'word\n', '⌘B did not bold');
key(v.contentDOM, 'b', { meta: true }); await sleep(250);
R.eq(settings.showFileTree, f0, '⌘B again restores');
return R.done();
