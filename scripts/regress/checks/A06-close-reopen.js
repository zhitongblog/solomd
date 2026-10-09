// id: A6
// title: closing a dirty tab asks first; tab.reopenClosed brings the tab back
const R = checks();
const t = await fresh('close.md', 'close me\n');
setDoc('close me edited\n');
await waitFor(() => tabs.isDirty(t.id), 2000);
act('file.closeTab');
const dlg = await waitFor(() => APP.unsavedOpen && $$('button').find((b) => b.textContent.trim() === '不保存'), 3000);
R.t(!!dlg, 'unsaved dialog with 不保存 shown');
R.t(!!$$('button').find((b) => b.textContent.trim() === '取消'), 'dialog has 取消');
if (dlg) dlg.click();
await waitFor(() => !tabs.tabs.some((x) => x.id === t.id), 3000);
R.t(!tabs.tabs.some((x) => x.id === t.id), 'tab closed after 不保存');
R.eq(await readText('_work/' + CHECK + '-close.md'), 'close me\n', 'disk untouched');
act('tab.reopenClosed');
const back = await waitFor(() => tabs.activeTab?.filePath === path('_work/' + CHECK + '-close.md'), 3000);
R.t(!!back, 'reopenClosed restores the tab');
return R.done();
