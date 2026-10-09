// id: F2 A8
// title: DOCX export (tables, lists, images, math) then import: bold stays put, lists, tasks [ ]/[x], links come back
// timeout: 45000
const R = checks();
const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
async function exportDocx(rel, out) {
  await open(rel);
  window.__solomdSavePathOverride = path(out);
  act('export.docx');
  const ok = await waitFor(async () => { try { return (await readBytes(out)).length > 1000; } catch { return false; } }, 15000, 200);
  delete window.__solomdSavePathOverride;
  return ok;
}
// 1) Round trip of the docx fixture
const out1 = '_work/' + CHECK + '-rt.docx';
if (!R.t(await exportDocx('docx-src.md', out1), 'docx written')) return R.done();
await sleep(300);
const md = await inv('convert_file_to_markdown', { path: path(out1) });
R.note('import: ' + JSON.stringify(md).slice(0, 300));
R.t(/Intro with \*\*bold\*\* and a \[link\]\(https:\/\/example\.com\/x\) here\./.test(md), 'bold stays on "bold" only and the link keeps its URL');
R.t(!/\*\*[^*\n]*\*\*\*\*/.test(md) && !/bold\*\* and a \*\*/.test(md), 'no bold bleeding into the rest');
R.t(/^[-*] bullet one$/m.test(md) && /^[-*] bullet two$/m.test(md), 'bullets');
R.t(/^1\. first$/m.test(md) && /^2\. second$/m.test(md) && /^3\. third$/m.test(md), 'numbered list');
R.t(/^[-*] \[ \] open task$/m.test(md) && /^[-*] \[x\] done task$/m.test(md), 'tasks [ ] / [x]');
R.t(/^# Docx Round Trip$/m.test(md), 'heading');
// 2) Rich document: table, image, math
await writeText('_work/' + CHECK + '-rich.md', '# Rich\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![logo](../assets/logo.png)\n\nInline $a^2+b^2=c^2$ math.\n\n$$\n\\int_0^1 x^2\\,dx\n$$\n\n- one\n  - nested\n');
const out2 = '_work/' + CHECK + '-rich.docx';
if (R.t(await exportDocx('_work/' + CHECK + '-rich.md', out2), 'rich docx written')) {
  const z = unzipSync(await readBytes(out2));
  const xml = strFromU8(z['word/document.xml']);
  R.t(xml.includes('<w:tbl>') || xml.includes('<w:tbl '), 'table present');
  R.t(/<w:drawing>|<w:drawing /.test(xml) && Object.keys(z).some((k) => k.startsWith('word/media/')), 'image embedded');
  // c66bee7e: math is kept as LaTeX source in Cambria Math runs (block centred), not dropped.
  const text = xml.replace(/<[^>]+>/g, '');
  R.t(/\\int_0\^1/.test(text), 'block math kept (\\int_0^1 present)');
  R.t(/a\^2\+b\^2=c\^2/.test(text), 'inline math kept');
  R.t((xml.match(/Cambria Math/g) || []).length >= 2, 'math runs in Cambria Math');
  R.t((xml.match(/<w:numPr>/g) || []).length >= 2, 'list numbering present');
}
return R.done();
