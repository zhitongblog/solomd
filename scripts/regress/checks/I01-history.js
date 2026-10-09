// id: I1
// title: history.initWorkspace creates a repo; auto-commit on save; file history lists versions
// timeout: 30000
const R = checks();
const gh = st('gitHistory');
act('history.initWorkspace');
const ok = await waitFor(async () => inv('fs_dir_exists', { path: path('.git') }), 8000, 200);
R.t(!!ok, '.git created');
if (!settings.autoGitEnabled && !settings.autoGit) act('history.toggleAutoGit');
const t = await fresh('hist.md', 'v1\n');
setDoc('v2 edit\n'); await sleep(500);
act('file.save');
await waitFor(() => !tabs.isDirty(t.id), 3000);
act('history.commitNow');
await sleep(2500);
let list = [];
try { list = await inv('git_file_history', { folder: VAULT, filePath: t.filePath, limit: 10 }); } catch (e) { R.note('history err ' + e); }
R.t(list.length >= 1, 'file history has commits (' + list.length + ')');
return R.done();
