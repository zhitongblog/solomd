// id: B7
// title: editor.selectWord / selectLine / deleteWord / jumpToSelection
const R = checks();
await fresh('sel.md', 'alpha beta gamma\nsecond line\n');
setDoc('alpha beta gamma\nsecond line\n', 8);
act('editor.selectWord'); await sleep(80);
R.eq(sel().text, 'beta', 'selectWord');
setDoc('alpha beta gamma\nsecond line\n', 8);
act('editor.selectLine'); await sleep(80);
R.t(sel().text.replace(/\n$/, '') === 'alpha beta gamma', 'selectLine -> ' + JSON.stringify(sel().text));
act('editor.selectLine'); await sleep(80);
R.t(sel().text.startsWith('alpha beta gamma\nsecond line'), 'selectLine again extends');
setDoc('alpha beta gamma\n', 10);
act('editor.deleteWord'); await sleep(80);
R.t(/^alpha {1,2}gamma\n$/.test(doc()), 'deleteWord -> ' + JSON.stringify(doc()));
// jumpToSelection: long doc, selection far below, scroller jumps to it
const long = Array.from({ length: 300 }, (_, i) => 'row ' + i).join('\n');
setDoc(long, 0);
const v = V();
v.scrollDOM.scrollTop = 0;
const p = v.state.doc.line(250).from;
v.dispatch({ selection: { anchor: p, head: p + 3 }, scrollIntoView: false });
await sleep(50);
v.scrollDOM.scrollTop = 0;
act('editor.jumpToSelection');
await waitFor(() => v.scrollDOM.scrollTop > 1000, 2000);
R.t(v.scrollDOM.scrollTop > 1000, 'jumpToSelection scrolls to line 250 (scrollTop ' + v.scrollDOM.scrollTop + ')');
return R.done();
