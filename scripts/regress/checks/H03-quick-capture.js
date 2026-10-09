// id: H3
// title: quick capture writes the captured text into the vault inbox (backend of the capture box)
const R = checks();
await inv('capture_set_workspace', { folder: VAULT });
const marker = 'qc-' + Date.now();
let res = '';
try { res = await inv('quick_capture_write', { content: marker + ' captured text' }); } catch (e) { R.t(false, 'quick_capture_write failed: ' + e); return R.done(); }
R.t(typeof res === 'string' && res.startsWith(VAULT), 'written inside the fixture vault: ' + res);
const txt = await inv('read_file', { path: res }).then((r) => r.content).catch(() => '');
R.t(txt.includes(marker) && /inbox:\s*true/.test(txt), 'file has the text and inbox: true');
return R.done();
