// id: B8 F-1
// title: ⌘Z / ⌘⇧Z undo and redo exactly, and ⌘⇧Z does not start a Pomodoro session
const R = checks();
await fresh('undo.md', 'plain text\n');
const v = V();
v.focus();
const orig = doc();
v.dispatch({ selection: { anchor: 0, head: 5 } });
act('fmt.bold'); await sleep(100);
const after = doc();
R.t(after !== orig, 'edit applied');
const pomo = st('pomodoro');
const wasActive = pomo.active;
key(v.contentDOM, 'z', { meta: true }); await sleep(100);
R.eq(doc(), orig, '⌘Z undoes');
key(v.contentDOM, 'z', { meta: true, shift: true }); await sleep(200);
R.eq(doc(), after, '⌘⇧Z redoes');
R.eq([wasActive, pomo.active], [false, false], 'pomodoro not started by ⌘⇧Z');
return R.done();
