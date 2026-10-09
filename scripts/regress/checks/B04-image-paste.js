// id: B4
// title: pasting an image saves it to the vault assets folder and inserts a link that renders
// timeout: 25000
const R = checks();
await fresh('img.md', 'Image:\n');
const v = V();
v.focus();
v.dispatch({ selection: { anchor: v.state.doc.length } });
const png = await readBytes('assets/logo.png');
const file = new File([png], 'paste.png', { type: 'image/png' });
const dt = new DataTransfer();
dt.items.add(file);
const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
v.contentDOM.dispatchEvent(ev);
const linked = await waitFor(() => /!\[[^\]]*\]\(([^)]+\.png)\)/.exec(doc()), 6000);
if (!R.t(!!linked, 'image link inserted: ' + JSON.stringify(doc()))) return R.done();
const rel = decodeURIComponent(linked[1]);
const abs = rel.startsWith('/') ? rel : path('_work/' + rel);
let bytes = null;
try { bytes = new Uint8Array(await inv('read_binary_file', { path: abs })); } catch (e) { R.note('read ' + abs + ' failed: ' + e); }
R.t(!!bytes && bytes.length === png.length, 'image file saved with the same bytes (' + abs + ')');
settings.setViewMode('preview');
const img = await waitFor(() => $$('.preview-host img').find((i) => i.complete && i.naturalWidth > 0), 5000);
R.t(!!img, 'image renders in the preview');
settings.setViewMode('liveEdit');
return R.done();
