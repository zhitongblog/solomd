// id: D1
// title: Live / Source / Split / Preview show the right panes; math + mermaid render in live, split and preview
// timeout: 30000
const R = checks();
await open('notes/Math Note.md');
const pane = () => $(`[data-pane-id="${tiles.focusedPaneId}"]`);
const visIn = (sel) => $$(sel, pane()).filter(vis);
const modes = {
  liveEdit: { cm: true, preview: false, katexIn: '.cm-content' },
  edit: { cm: true, preview: false, katexIn: null },
  split: { cm: true, preview: true, katexIn: '.preview-host' },
  preview: { cm: false, preview: true, katexIn: '.preview-host' },
};
for (const [mode, want] of Object.entries(modes)) {
  settings.setViewMode(mode);
  await sleep(300);
  V()?.dispatch({ selection: { anchor: 0 } });
  const ok = await waitFor(() => {
    const cm = visIn('.cm-editor').length > 0;
    const pv = visIn('.preview-host').length > 0;
    if (cm !== want.cm || pv !== want.preview) return false;
    if (!want.katexIn) return true;
    return $$(want.katexIn + ' .katex', pane()).length >= 2 && $$(want.katexIn + ' svg', pane()).some((s) => /Start|Finish/.test(s.textContent));
  }, 8000);
  R.t(!!ok, `${mode}: editor=${visIn('.cm-editor').length} preview=${visIn('.preview-host').length}` + (want.katexIn ? ` katex=${$$(want.katexIn + ' .katex', pane()).length} mermaid=${$$(want.katexIn + ' svg', pane()).filter((s) => /Start|Finish/.test(s.textContent)).length}` : ''));
  if (mode === 'edit') R.t(!$('.cm-content .katex', pane()), 'source mode shows raw TeX (no .katex in the editor)');
}
settings.setViewMode('liveEdit');
return R.done();
