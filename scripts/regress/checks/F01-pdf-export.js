// id: F1
// title: export.pdfPrint (text PDF) and export.pdf (image PDF) write real PDF files
// timeout: 90000
const R = checks();
await open('notes/Math Note.md');
for (const [id, out] of [['export.pdfPrint', '_work/' + CHECK + '-text.pdf'], ['export.pdf', '_work/' + CHECK + '-image.pdf']]) {
  window.__solomdSavePathOverride = path(out);
  act(id);
  const ok = await waitFor(async () => { try { const b = await readBytes(out); return b.length > 3000 && String.fromCharCode(...b.slice(-6)).includes('EOF') ? b : null; } catch { return null; } }, 40000, 500);
  delete window.__solomdSavePathOverride;
  if (!R.t(!!ok, id + ' wrote a complete PDF')) continue;
  R.eq(String.fromCharCode(...ok.slice(0, 5)), '%PDF-', id + ' header');
  const s = new TextDecoder('latin1').decode(ok);
  const pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  R.t(pages >= 1 && pages <= 3, id + ' page count ' + pages + ' (no endless pages)');
  await sleep(500);
}
return R.done();
