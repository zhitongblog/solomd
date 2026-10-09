// id: B5
// title: table editor and formula editor open on the element at the caret and write edits back
const R = checks();
await fresh('tbl.md', '| Name | Qty |\n| --- | ---: |\n| Apple | 3 |\n\n$$\nx^2\n$$\n');
const v = V();
v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('Apple') + 1 } });
act('editor.tableEditor');
const modal = await waitFor(() => $$('.tbl__grid [contenteditable]').filter(vis).find((i) => i.textContent.trim() === 'Apple'), 3000);
if (R.t(!!modal, 'table editor shows the cell "Apple"')) {
  modal.textContent = 'Banana'; modal.dispatchEvent(new InputEvent('input', { bubbles: true })); modal.dispatchEvent(new Event('blur'));
  const apply = $$('button').filter(vis).find((b) => /^应用$|^Apply$/.test(b.textContent.trim()));
  R.t(!!apply, '应用 button'); apply?.click(); await sleep(300);
  R.t(/\| Banana \|/.test(doc()) && /\| *-+: *\|/.test(doc()), 'table rewritten, alignment kept: ' + JSON.stringify(doc().split('\n').slice(0, 3)));
}
v.dispatch({ selection: { anchor: doc().indexOf('x^2') + 1 } });
act('editor.formulaEditor');
const ta = await waitFor(() => $$('textarea').filter(vis).find((t) => t.value.includes('x^2')), 3000);
if (R.t(!!ta, 'formula editor shows the TeX')) {
  ta.value = 'y^3'; ta.dispatchEvent(new Event('input', { bubbles: true }));
  const apply = $$('button').filter(vis).find((b) => /^应用$|^Apply$|^插入$/.test(b.textContent.trim()));
  R.t(!!apply, 'formula apply button (' + $$('button').filter(vis).map((b) => b.textContent.trim()).filter(Boolean).slice(-4).join('|') + ')');
  apply?.click(); await sleep(300);
  R.t(/\$\$\ny\^3\n\$\$/.test(doc()), 'formula written back: ' + JSON.stringify(doc().slice(-20)));
}
return R.done();
