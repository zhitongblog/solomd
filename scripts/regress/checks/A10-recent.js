// id: A10
// title: recent files list most-recent first; recent.clear empties it
const R = checks();
await open('README.md'); await open('Table Note.md');
const rec = workspace.recentFiles;
R.eq(rec.slice(0, 2), [path('Table Note.md'), path('README.md')], 'recent order');
act('recent.clear');
await sleep(100);
R.eq(workspace.recentFiles.length, 0, 'recent cleared');
R.t(!(JSON.parse(localStorage.getItem('solomd.workspace.v1') || '{}').recentFiles || []).length, 'cleared in localStorage');
return R.done();
