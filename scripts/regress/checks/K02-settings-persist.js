// id: K2
// title: toggles take effect at once and survive a relaunch (page reload)
// timeout: 40000
const R = checks();
if (PHASE === 1) {
  await open('README.md');
  act('view.toggleTypewriter'); act('view.toggleLineNumbers'); act('theme.set:nord');
  await sleep(300);
  const want = { typewriterMode: settings.typewriterMode, showLineNumbers: settings.showLineNumbers, theme: 'nord' };
  R.eq(document.documentElement.dataset.theme, 'nord', 'theme applied at once');
  R.eq(!!$('.cm-lineNumbers'), want.showLineNumbers, 'line numbers applied at once');
  setTimeout(() => location.reload(), 50);
  return { reload: true, next: { want, first: R.done() } };
}
const { want, first } = CARRY;
R.t(first.ok, first.detail);
await waitFor(() => V(), 6000);
await sleep(500);
for (const k of Object.keys(want)) R.eq(settings[k], want[k], k + ' restored after reload');
R.eq(document.documentElement.dataset.theme, 'nord', 'theme applied after reload');
return R.done();
