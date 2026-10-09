// id: D1
// title: split view scroll sync — 10 positions each direction (incl. a list at the top), panes within 20 px
// timeout: 60000
const R = checks();
// rAF must run for the sync (its guard clears on the next frame).
let frames = 0; const tf = performance.now();
await new Promise((r) => { const f = () => { frames++; if (performance.now() - tf < 300) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); setTimeout(r, 1000); });
if (!R.t(frames > 3, 'window is rendering (rAF frames in 300 ms: ' + frames + ') — a locked screen stops the sync')) return R.done();
await open('long.md');
settings.splitLiveSync = true;
settings.setViewMode('split');
const pane = $(`[data-pane-id="${tiles.focusedPaneId}"]`);
const ed = await waitFor(() => $('.pane--editor .cm-scroller', pane), 4000);
const pv = await waitFor(() => $('.pane--preview .preview-host', pane), 4000);
if (!R.t(ed && pv, 'split panes present')) return R.done();
await waitFor(() => pv.querySelectorAll('[data-source-line]').length > 50, 6000);
await sleep(500);
const v = V();
const docTop = () => v.documentTop - v.scrollDOM.getBoundingClientRect().top + v.scrollDOM.scrollTop;
const yLine = (n) => v.lineBlockAt(v.state.doc.line(Math.max(1, Math.min(n, v.state.doc.lines))).from).top + docTop();
// Where (in editor scrollTop space) the content at the preview's top belongs,
// from the preview's own data-source-line anchors.
function previewTopInEditor() {
  const anchors = $$('[data-source-line]', pv).map((el) => ({ line: +el.dataset.sourceLine, el })).filter((a) => a.line > 0).sort((a, b) => a.line - b.line);
  const top = pv.getBoundingClientRect().top + 8;
  let i = 0;
  for (let k = 0; k < anchors.length; k++) { if (anchors[k].el.getBoundingClientRect().top <= top) i = k; else break; }
  const a = anchors[i];
  const b = anchors.find((e, k) => k > i && e.line > a.line);
  const aTop = a.el.getBoundingClientRect().top;
  if (!b || aTop >= top) return { y: yLine(a.line) + (aTop - top), line: a.line };
  const bTop = b.el.getBoundingClientRect().top;
  const t = Math.max(0, Math.min(1, (top - aTop) / (bTop - aTop)));
  return { y: yLine(a.line) + t * (yLine(b.line) - yLine(a.line)), line: a.line, tag: a.el.tagName };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r)); await sleep(120); };
const gap = () => Math.round(previewTopInEditor().y - (ed.scrollTop + 8));
const results = { editor: [], preview: [] };
const emax = ed.scrollHeight - ed.clientHeight;
// Editor positions: 9 spread out + one with a list item at the top.
const listLine = v.state.doc.toString().split('\n').indexOf('- list 6 item b') + 1;
const edPositions = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => Math.round((emax * k) / 10.5)).concat([Math.round(yLine(listLine) - 8)]);
for (const y of edPositions) {
  ed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
  ed.scrollTop = y;
  await settle();
  results.editor.push(gap());
}
await sleep(400); // let the editor driver lock expire
const pmax = pv.scrollHeight - pv.clientHeight;
const li = $$('li', pv).find((e) => /list 9 item c/.test(e.textContent) && !e.querySelector('li'));
const pvPositions = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => Math.round((pmax * k) / 10.5));
if (li) pvPositions.push(Math.round(pv.scrollTop + li.getBoundingClientRect().top - pv.getBoundingClientRect().top - 4));
for (const y of pvPositions) {
  pv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
  pv.scrollTop = y;
  await settle();
  results.preview.push(gap());
}
const bad = (arr) => arr.filter((g) => Math.abs(g) > 20).length;
R.t(bad(results.editor) === 0, 'editor-driven gaps px ' + JSON.stringify(results.editor) + ' (last = list item at top)');
R.t(bad(results.preview) === 0, 'preview-driven gaps px ' + JSON.stringify(results.preview) + ' (last = inside a list)');
R.t(results.editor.length === 10 && results.preview.length === 10, '10 positions each way');
settings.setViewMode('liveEdit');
return R.done();
