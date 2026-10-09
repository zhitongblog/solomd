// id: A3
// title: opening a folder (underlying setFolder; the native picker is not driven) lists it in the tree; openPath opens a file
const R = checks();
const rowOf = (rel) => $$('li.ftree__item').find((li) => li.dataset.path === path(rel));
for (const rel of ['notes', 'enc', 'README.md', 'Table Note.md']) R.t(!!(await waitFor(() => rowOf(rel), 3000)), 'tree shows ' + rel);
// Switch to a sub-folder as the workspace and back
workspace.setFolder(path('notes'));
R.t(!!(await waitFor(() => rowOf('notes/Math Note.md') && !rowOf('README.md'), 4000)), 'tree follows a folder switch');
workspace.setFolder(VAULT);
R.t(!!(await waitFor(() => rowOf('README.md'), 4000)), 'and back');
const t = await open('Table Note.md');
R.t(t.fileName === 'Table Note.md' && doc().includes('Back to [[README]]'), 'openPath opens the file in the editor');
R.t(!!(await waitFor(() => rowOf('Table Note.md')?.classList.contains('ftree__item--selected'), 2000)), 'tree highlights the active file');
return R.done();
