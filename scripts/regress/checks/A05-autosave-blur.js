// id: A5
// title: autosave on window blur writes the file (edit settled, and edit typed <350 ms before the blur)
const R = checks();
await fresh('blur.md', 'start\n');
if (!settings.autoSaveOnBlur) act('file.autoSave');
R.t(settings.autoSaveOnBlur, 'autoSaveOnBlur on');
const rel = '_work/' + CHECK + '-blur.md';
// a) edit, let the editor->tab sync settle, then blur
const text = 'blurred ' + Date.now() + '\n';
setDoc(text);
await sleep(700);
window.dispatchEvent(new Event('blur'));
R.t(!!(await waitFor(async () => (await readText(rel)) === text, 4000)), 'settled edit written on blur');
window.dispatchEvent(new Event('focus'));
// b) the realistic fast case: type, then switch apps at once (50 ms later)
const text2 = 'fast ' + Date.now() + '\n';
setDoc(text2);
await sleep(50);
window.dispatchEvent(new Event('blur'));
await sleep(1500);
const disk = await readText(rel);
R.t(disk === text2, 'edit made 50 ms before blur is written (disk: ' + JSON.stringify(disk) + ')');
window.dispatchEvent(new Event('focus'));
return R.done();
