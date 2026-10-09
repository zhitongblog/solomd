// id: G1 F-5
// title: cn.s2t / cn.t2s / cn.copyPinyin act on the current text, including text typed just before
const R = checks();
await fresh('cn.md', '发展头发后来，汉字转换测试。');
const v = V();
// type at the end and run at once (inside the 350 ms editor->tab sync debounce)
v.dispatch({ changes: { from: v.state.doc.length, insert: '尾巴' } });
act('cn.s2t');
await waitFor(() => doc().includes('發展'), 4000);
R.eq(doc(), '發展頭髮後來，漢字轉換測試。尾巴', 's2t converts and keeps the just-typed text');
act('cn.t2s');
await waitFor(() => doc().includes('发展'), 4000);
R.eq(doc(), '发展头发后来，汉字转换测试。尾巴', 't2s back');
const readClip = () => inv('plugin:clipboard-manager|read_text').catch(() => null);
const saved = await readClip();
try {
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '新文字' } });
  act('cn.copyPinyin');
  const p = await waitFor(async () => { const c = await readClip(); return c && /xin/.test(c) ? c : null; }, 4000);
  R.t(!!p && /xin\s*wen\s*zi/.test(p), 'copyPinyin copies the current text: ' + JSON.stringify(p || (await readClip())));
} finally {
  if (saved != null) await inv('plugin:clipboard-manager|write_text', { text: saved });
}
return R.done();
