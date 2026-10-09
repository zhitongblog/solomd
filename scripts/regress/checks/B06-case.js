// id: B6
// title: editor.case* transform the selection (and cycle on a bare caret)
const R = checks();
await fresh('case.md', 'a big word\n');
const ids = { 'editor.caseUpper': 'BIG', 'editor.caseLower': 'big', 'editor.caseTitle': 'Big' };
for (const [id, want] of Object.entries(ids)) {
  setDoc('a bIg word\n', 2, 5);
  act(id); await sleep(80);
  R.eq(doc(), `a ${want} word\n`, id);
  R.eq(sel().text, want, id + ' keeps selection');
}
setDoc('a big word\n', 3);
const seen = [];
for (let i = 0; i < 3; i++) { act('editor.caseCycle'); await sleep(80); seen.push(doc().split(' ')[1]); }
R.eq(seen, ['BIG', 'Big', 'big'], 'caseCycle on caret');
return R.done();
