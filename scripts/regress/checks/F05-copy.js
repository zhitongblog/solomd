// id: F5
// title: copy as Markdown / plain text put the right text on the clipboard (user clipboard restored)
const R = checks();
const readClip = () => inv('plugin:clipboard-manager|read_text').catch(() => null);
const writeClip = (text) => inv('plugin:clipboard-manager|write_text', { text });
const saved = await readClip();
try {
  await fresh('copy.md', '# Title\n\nSome **bold** and [link](http://x.y).\n\n- item\n');
  act('export.copyMd');
  const md = await waitFor(async () => { const c = await readClip(); return c && c.includes('**bold**') ? c : null; }, 3000);
  R.t(!!md && md.startsWith('# Title'), 'copyMd = markdown source');
  act('export.copyPlain');
  const pl = await waitFor(async () => { const c = await readClip(); return c && !c.includes('**') && c.includes('bold') ? c : null; }, 3000);
  R.t(!!pl, 'copyPlain strips markup: ' + JSON.stringify(pl || (await readClip()) || '').slice(0, 80));
} finally {
  if (saved != null) await writeClip(saved);
}
return R.done();
