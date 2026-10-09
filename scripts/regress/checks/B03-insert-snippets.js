// id: B3
// title: insert.table / mathBlock / mathInline / mermaid / hr insert their snippet with the caret placed; the mermaid snippet parses
const R = checks();
await fresh('ins.md', 'x\n');
const cases = [
  ['insert.table', /\| *Header *\|/, (d, s) => d.slice(s.from - 2, s.from) === '| ' || d.lineAt?.(0)],
  ['insert.mathBlock', /\$\$\n\n?\$\$/, null],
  ['insert.mathInline', /\$\$/, null],
  ['insert.hr', /\n---\n/, null],
];
for (const [id, re] of cases) {
  setDoc('x\n', 1);
  act(id); await sleep(120);
  R.t(re.test(doc()), `${id} inserted: ${JSON.stringify(doc())}`);
}
setDoc('x\n', 1);
act('insert.table'); await sleep(120);
{ const v = V(); const line = v.state.doc.lineAt(v.state.selection.main.head); R.t(/^\| /.test(line.text) && v.state.selection.main.head > line.from, 'table: caret in the first cell (' + JSON.stringify(line.text) + ')'); }
setDoc('x\n', 1);
act('insert.mathInline'); await sleep(120);
{ const s = sel(); R.eq(doc().slice(s.from - 1, s.from + 1), '$$', 'mathInline: caret between the $'); }
// Mermaid: valid source, "Start" selected, and mermaid accepts it.
setDoc('x\n', 1);
act('insert.mermaid'); await sleep(150);
const d = doc();
const m = d.match(/```mermaid\n([\s\S]*?)```/);
R.t(!!m, 'mermaid fence inserted: ' + JSON.stringify(d));
R.eq(sel().text, 'Start', 'mermaid: placeholder label selected');
if (m) {
  const { loadMermaid } = await import('/src/lib/mermaid-lazy.ts');
  const mermaid = await loadMermaid();
  let parsed = false, err = '';
  try { parsed = !!(await mermaid.parse(m[1])); } catch (e) { err = String(e).slice(0, 120); }
  R.t(parsed, 'mermaid.parse accepts the snippet ' + err);
}
return R.done();
