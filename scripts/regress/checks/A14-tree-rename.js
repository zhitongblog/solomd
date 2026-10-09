// id: A14
// title: file tree — context-menu rename renames on disk and repoints the open tab; tree follows the active file
const R = checks();
const name = 'ren-' + Date.now().toString(36);
await writeText('_work/' + name + '.md', 'rename me\n');
const t = await open('_work/' + name + '.md');
const rowOf = (rel) => $$('li.ftree__item').find((li) => li.dataset.path === path(rel));
// expand _work in the tree if needed
let li = await waitFor(() => rowOf('_work/' + name + '.md'), 1500);
for (let i = 0; i < 3 && !li; i++) {
  const dir = await waitFor(() => rowOf('_work'), 3000);
  (dir?.querySelector(':scope > *') || dir)?.click();
  li = await waitFor(() => rowOf('_work/' + name + '.md'), 1500);
}
if (!R.t(!!li, 'file row in the tree')) return R.done();
R.t(li.classList.contains('ftree__item--selected'), 'active file highlighted in the tree');
const target = li.querySelector(':scope > *') || li;
const b = target.getBoundingClientRect();
target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 10, clientY: b.y + 5 }));
const ren = await waitFor(() => $$('.ftree__ctx-item').find((e) => /重命名/.test(e.textContent)), 2000);
if (!R.t(!!ren, 'context menu has 重命名')) return R.done();
ren.click();
const input = await waitFor(() => $('input.ftree__edit-input'), 2000);
if (!R.t(!!input, 'inline rename input')) return R.done();
input.value = name + '-renamed.md';
input.dispatchEvent(new Event('input', { bubbles: true }));
key(input, 'Enter');
const ok = await waitFor(async () => await exists('_work/' + name + '-renamed.md') && !(await exists('_work/' + name + '.md')), 4000, 150);
R.t(!!ok, 'renamed on disk');
R.t(!!(await waitFor(() => tabs.tabs.find((x) => x.id === t.id)?.filePath === path('_work/' + name + '-renamed.md'), 3000)), 'open tab repointed');
return R.done();
