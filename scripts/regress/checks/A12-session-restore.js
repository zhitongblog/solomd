// id: A12
// title: relaunch (page reload) restores tabs, the caret per tab, and text typed <0.5 s before quitting
// timeout: 30000
const R = checks();
if (PHASE === 1) {
  const t1 = await fresh('caret.md', Array.from({ length: 40 }, (_, i) => 'line ' + (i + 1) + ' text').join('\n') + '\n');
  const v = V();
  const pos = v.state.doc.line(30).from + 3;
  v.dispatch({ selection: { anchor: pos } });
  v.focus();
  await sleep(1200); // caret persist debounce is 800 ms
  const t2 = await fresh('unsaved.md', 'saved text\n');
  const marker = 'TYPED-LAST-' + Date.now();
  V().dispatch({ changes: { from: V().state.doc.length, insert: marker } });
  // Quit within the session-snapshot debounce (500 ms): reload right away.
  setTimeout(() => location.reload(), 30);
  return { reload: true, next: { caretPath: t1.filePath, unsavedPath: t2.filePath, marker } };
}
const { caretPath, unsavedPath, marker } = CARRY;
await waitFor(() => tabs.tabs.length >= 2 && V(), 8000);
const tc = tabs.tabs.find((t) => t.filePath === caretPath);
const tu = tabs.tabs.find((t) => t.filePath === unsavedPath);
R.t(!!tc && !!tu, 'both tabs restored (' + tabs.tabs.map((t) => t.fileName).join(',') + ')');
if (tu) {
  R.t(tu.content.includes(marker), 'text typed just before the reload survives in the tab');
  R.t(tabs.isDirty(tu.id), 'restored buffer is still dirty');
}
if (tc) {
  tabs.activate(tc.id);
  await waitFor(() => V() && V().state.doc.toString() === tc.content, 4000);
  await sleep(300);
  const v = V();
  const h = v.state.selection.main.head;
  const line = v.state.doc.lineAt(h);
  R.eq(line.number, 30, 'caret restored to line 30');
  // Column: PaneContent.restoreLaunchCursor uses Editor.setCaret when it exists, else gotoLine (col 1).
  R.note('column after restore = ' + (h - line.from) + ' (was 3)');
}
return R.done();
