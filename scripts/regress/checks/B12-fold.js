// id: B12
// title: fold.all / fold.none / fold.toggle fold heading sections
const R = checks();
await open('README.md');
const v = V();
const visible = () => $$('.cm-content > .cm-line').length;
const n0 = visible();
act('fold.all'); await sleep(200);
const n1 = visible();
R.t(n1 < n0, `fold.all: ${n0} -> ${n1} lines`);
act('fold.none'); await sleep(200);
R.eq(visible(), n0, 'fold.none restores');
const p = v.state.doc.toString().indexOf('## Tasks');
v.dispatch({ selection: { anchor: p + 3 } });
act('fold.toggle'); await sleep(200);
const n2 = visible();
R.t(n2 < n0 && n2 > n1, `fold.toggle on ## Tasks: ${n0} -> ${n2}`);
act('fold.toggle'); await sleep(200);
R.eq(visible(), n0, 'fold.toggle again unfolds');
return R.done();
