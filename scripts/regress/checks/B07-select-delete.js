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
// #491: cursor history queue (editor.cursorBack / editor.cursorForward)
const p10 = v.state.doc.line(10).from;
const p80 = v.state.doc.line(80).from;
v.dispatch({ selection: { anchor: p10, head: p10 } }); await sleep(50);
v.dispatch({ selection: { anchor: p80, head: p80 } }); await sleep(50);
act('editor.cursorBack'); await sleep(80);
R.eq(lineOf(sel().from), 10, 'cursorBack jumps back to line 10');
act('editor.cursorForward'); await sleep(80);
R.eq(lineOf(sel().from), 80, 'cursorForward jumps forward to line 80');
return R.done();
