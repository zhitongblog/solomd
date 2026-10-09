// id: E1 F-3
// title: outline / backlinks (file line 13, click jumps there) / tags / tasks panels show the right data and navigate
// timeout: 25000
const R = checks();
await open('README.md');
settings.rightSidebarHidden = false;
if (!settings.showTasksPanel) act('view.toggleTasksPanel');
const pane = (id) => $(`[data-rs-pane=${id}]`);
await sleep(300);
if (!pane('outline')) act('view.toggleOutline');
await waitFor(() => pane('outline') && pane('backlinks') && pane('tags') && pane('tasks'), 4000);
// Outline
const items = $$('.outline__label', pane('outline') || document).map((e) => e.textContent.trim());
R.eq(items, ['Fixture Vault', 'Tasks', 'Section Two', 'Deep heading'], 'outline headings');
const sec = $$('.outline__label', pane('outline') || document).find((e) => e.textContent.trim() === 'Section Two');
if (sec) { sec.click(); await sleep(300); R.eq(lineOf(V().state.selection.main.head), 11, 'outline click -> caret on "## Section Two" (line 11)'); }
// Backlinks: Table Note.md links to README on FILE line 13 (5 lines of front matter)
const bl = await waitFor(() => $$('.rp-row', pane('backlinks')).find((r) => r.textContent.includes('Table Note')), 5000);
if (R.t(!!bl, 'backlink row for Table Note.md')) {
  R.t(/L13\b/.test(bl.textContent), 'backlink shows L13: ' + bl.textContent.replace(/\s+/g, ' ').trim());
  R.t(/Back to \[\[README\]\]/.test(bl.textContent), 'context is the link line');
  bl.click();
  const ok = await waitFor(() => tabs.activeTab?.fileName === 'Table Note.md' && V() && lineOf(V().state.selection.main.head) === 13, 4000);
  R.t(!!ok, 'click opens Table Note.md at line 13 (line ' + (V() && lineOf(V().state.selection.main.head)) + ')');
}
await open('README.md');
// Tags
const tagText = pane('tags')?.innerText || '';
R.t(/fixture/.test(tagText) && /tag\/project/.test(tagText), 'tags panel lists fixture, tag/project');
// Tasks
const task = await waitFor(() => $$('.tasks-panel__item', pane('tasks')).find((e) => /task with #tag\/project/.test(e.textContent)), 4000);
if (R.t(!!task, 'tasks panel lists the open task')) {
  (task.querySelector('.tasks-panel__text') || task).click();
  await sleep(400);
  R.t(V() && V().state.doc.lineAt(V().state.selection.main.head).text.includes('task with #tag/project'), 'task click -> caret on the task line');
}
return R.done();
