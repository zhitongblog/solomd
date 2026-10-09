// id: A15 F-2
// title: GBK / Big5 / UTF-16LE / UTF-16BE open correctly and save back in the same encoding (+BOM)
const R = checks();
const cases = [
  ['enc/gbk.txt', 'GBK', '编码测试', null],
  ['enc/big5.txt', 'Big5', '編碼測試', null],
  ['enc/utf16le.txt', 'UTF-16LE', '编码测试', [0xff, 0xfe]],
  ['enc/utf16be.txt', 'UTF-16BE', '编码测试', [0xfe, 0xff]],
];
for (const [rel, enc, probe, bom] of cases) {
  // Work on a copy so the check is idempotent.
  const copy = '_work/' + CHECK + '-' + rel.split('/').pop();
  await inv('write_binary_file', { path: path(copy), data: Array.from(await readBytes(rel)) });
  const t = await open(copy);
  R.t(t.encoding.toUpperCase().replace(/[-_]/g, '') === enc.toUpperCase().replace(/[-_]/g, ''), `${enc}: detected as ${t.encoding}`);
  R.t(doc().startsWith(probe), `${enc}: text decoded`);
  V().dispatch({ changes: { from: V().state.doc.length, insert: '追加' + enc + '\n' } });
  await sleep(500);
  act('file.save');
  await waitFor(() => !tabs.isDirty(t.id), 3000);
  const b = await readBytes(copy);
  const want = bom ? bom : [];
  const head = [...b.slice(0, 2)];
  if (bom) R.eq(head, want, `${enc}: BOM kept`);
  // Decode with the expected encoding and compare to the editor text.
  const label = { GBK: 'gbk', Big5: 'big5', 'UTF-16LE': 'utf-16le', 'UTF-16BE': 'utf-16be' }[enc];
  let decoded = '';
  try { decoded = new TextDecoder(label).decode(bom ? b.slice(2) : b); } catch (e) { decoded = 'decoder error ' + e; }
  R.t(decoded === V().state.doc.toString(), `${enc}: saved bytes decode back to the editor text`);
  R.t(!(b[0] === 0xef && b[1] === 0xbb) && !(bom == null && decoded.includes('�')), `${enc}: not rewritten as UTF-8`);
}
return R.done();
