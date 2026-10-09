// id: A2
// title: file.newInFolder creates the note in the folder selected in the tree
const R = checks();
const name = 'NewIn-' + Date.now().toString(36);
// Select notes/ in the tree (click its row).
const rowOf = (rel) => $$('li.ftree__item').find((li) => li.dataset.path === path(rel));
await waitFor(() => rowOf('notes'), 3000);
const li = rowOf('notes');
if (!R.t(!!li, 'tree shows notes/')) return R.done();
(li.querySelector(':scope > *') || li).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
await sleep(200);
act('file.newInFolder');
const input = await waitFor(() => $('input.ftree__edit-input'), 3000);
if (!R.t(!!input, 'inline name input appears in the tree')) return R.done();
R.note('prefill=' + input.value); input.value = name;
input.dispatchEvent(new Event('input', { bubbles: true }));
key(input, 'Enter');
const ok = await waitFor(() => tabs.activeTab?.filePath === path('notes/' + name + '.md'), 4000);
R.t(!!ok, 'new tab points at notes/' + name + '.md (active: ' + tabs.activeTab?.filePath + ')');
R.t(await exists('notes/' + name + '.md'), 'file exists on disk');
R.t(!!(await waitFor(() => rowOf('notes/' + name + '.md'), 3000)), 'file appears in the tree');
// The first keystrokes after naming go into the new note, not nowhere
// (Linux round-2 run: focus stayed on nothing after the tree's inline name).
R.t(!!(await waitFor(() => !!document.activeElement?.closest('.cm-editor'), 2000)),
  'caret is in the new note\'s editor after naming (active: ' + (document.activeElement?.className || document.activeElement?.tagName) + ')');
return R.done();
