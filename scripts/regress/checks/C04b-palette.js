// id: C4
// title: command palette — fuzzy ("togl line", "exprt pdf", 行号) and Enter runs the command
const R = checks();
const pal = async (q) => {
  APP.paletteOpen = false; await sleep(100);
  act('palette.open');
  const input = await waitFor(() => $('.palette__input'), 3000);
  if (!input) return null;
  input.value = q; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(250);
  return { input, titles: $$('.palette__item .palette__title').map((e) => e.textContent.trim()) };
};
for (const [q, re] of [['togl line', /行号/], ['exprt pdf', /PDF/i], ['行号', /行号/], ['line num', /行号/]]) {
  const r = await pal(q);
  R.t(r && r.titles.length && re.test(r.titles[0]), `"${q}" -> ${r && r.titles.slice(0, 2).join(' | ')}`);
}
const r = await pal('行号');
const before = settings.showLineNumbers;
key(r.input, 'Enter'); await sleep(300);
R.t(settings.showLineNumbers !== before, 'Enter runs 切换行号显示');
R.t(!APP.paletteOpen, 'palette closes after running');
return R.done();
