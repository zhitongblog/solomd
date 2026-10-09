// id: D8
// title: narrow window (760 / 640 px) — toolbar does not overflow, menus stay on screen
// timeout: 25000
const R = checks();
const { getCurrentWindow, LogicalSize } = await import('/node_modules/@tauri-apps/api/window.js');
const w = getCurrentWindow();
const size0 = await w.innerSize();
const scale = await w.scaleFactor();
try {
  await open('README.md');
  for (const width of [760, 640]) {
    await w.setSize(new LogicalSize(width, 700));
    await waitFor(() => Math.abs(window.innerWidth - width) < 40, 3000);
    await sleep(400);
    const tb = $$('.toolbar, header, [class*=toolbar]').filter(vis)[0];
    if (tb) R.t(tb.scrollWidth <= tb.clientWidth + 1, `${width}px: toolbar scrollWidth ${tb.scrollWidth} <= ${tb.clientWidth}`);
    R.t(document.documentElement.scrollWidth <= window.innerWidth + 1, `${width}px: no horizontal page overflow (${document.documentElement.scrollWidth}/${window.innerWidth})`);
    const offscreen = $$('button').filter(vis).filter((b) => { const r = b.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; });
    R.t(offscreen.length === 0, `${width}px: no visible button off-screen (${offscreen.slice(0, 3).map((b) => b.title || b.textContent.trim()).join(',')})`);
  }
} finally {
  await w.setSize(new LogicalSize(size0.width / scale, size0.height / scale));
}
return R.done();
