// id: A4
// title: file.save writes the editor bytes (incl. CJK) and clears the dirty dot
const R = checks();
await fresh('save.md', '# Save\n\nbody\n');
const text = '# Save\n\nbody 中文 ✓ ' + Date.now() + '\n';
setDoc(text);
await waitFor(() => tabs.isDirty(tabs.activeId), 2000);
R.t(tabs.isDirty(tabs.activeId), 'tab dirty after edit');
act('file.save');
await waitFor(() => !tabs.isDirty(tabs.activeId), 3000);
R.t(!tabs.isDirty(tabs.activeId), 'dirty cleared after save');
R.eq(await readText('_work/' + CHECK + '-save.md'), text, 'disk equals editor');
await sleep(1500);
R.t(!APP.fileChangedOpen, 'own save does not raise "file changed on disk"');
return R.done();
