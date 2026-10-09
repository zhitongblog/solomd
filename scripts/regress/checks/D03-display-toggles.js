// id: D3
// title: focus mode / line numbers / wrap / typewriter / live preview toggle visibly and persist to localStorage
const R = checks();
await open('README.md');
const v = V();
v.dispatch({ selection: { anchor: 5 } }); v.focus();
const ls = () => JSON.parse(localStorage.getItem('solomd.settings.v1') || '{}');
const cases = [
  ['view.toggleFocusMode', 'focusMode', () => $$('.cm-line-dimmed').length > 0],
  ['view.toggleTypewriter', 'typewriterMode', null],
  ['view.toggleLineNumbers', 'showLineNumbers', () => !!$('.cm-lineNumbers')],
  ['view.toggleWrap', 'wordWrap', () => !!$('.cm-content.cm-lineWrapping')],
  ['view.toggleLivePreview', 'livePreview', null],
  ['view.toggleFitWidth', 'previewFitWidth', null],
];
for (const [id, key, visible] of cases) {
  const before = settings[key];
  const b0 = visible ? visible() : null;
  act(id); await sleep(250);
  R.t(settings[key] === !before, `${id}: ${key} ${before} -> ${settings[key]}`);
  R.eq(ls()[key], settings[key], `${id}: persisted`);
  if (visible) R.t(visible() !== b0, `${id}: visible change`);
  act(id); await sleep(250);
  R.eq(settings[key], before, `${id}: back`);
}
return R.done();
