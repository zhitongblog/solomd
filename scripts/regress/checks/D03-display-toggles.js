// id: D3
// title: focus mode / line numbers / wrap / typewriter / live preview toggle visibly and persist to localStorage
// timeout: 30000
const R = checks();
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
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
  act(id); await tick();
  R.t(settings[key] === !before, `${id}: ${key} ${before} -> ${settings[key]}`);
  R.eq(ls()[key], settings[key], `${id}: persisted`);
  if (visible) R.t(visible() !== b0, `${id}: visible change`);
  act(id); await tick();
  R.eq(settings[key], before, `${id}: back`);
}
// Decoupled alwaysShowMarkers & collapseBlockSource + Table source fold/unfold
settings.setViewMode('liveEdit');
await open('Table Note.md');
settings.alwaysShowMarkers = true;
settings.collapseBlockSource = true;
await tick();
R.t(!!$('.cm-live-block--table'), 'table stays rendered when alwaysShowMarkers=true and collapseBlockSource=true');
const srcBtn = $('.cm-table-source-btn');
if (R.t(!!srcBtn, 'rendered table has </> 源码 expand button')) {
  srcBtn.click(); await tick();
  const foldBtn = $('.cm-table-fold-btn');
  R.t(!!foldBtn && !$('.cm-live-block--table'), 'clicking </> 源码 expands table source and mounts fold toggle');
  foldBtn?.click(); await tick();
  R.t(!!$('.cm-live-block--table'), 'clicking fold toggle collapses table back into TableWidget');
  settings.collapseBlockSource = false; await tick();
  R.t(!$('.cm-live-block--table'), 'setting collapseBlockSource=false keeps table in raw source mode');
  settings.collapseBlockSource = true; await tick();
  R.t(!!$('.cm-live-block--table'), 'setting collapseBlockSource=true folds table back into TableWidget');
}
// Windows Plain Block Editor (?forcePlain + native engine): table/mermaid source fold + decoupled switches
history.replaceState(null, '', '?forcePlain');
settings.windowsEditorEngine = 'native';
await tick();
await waitFor(() => $('.plain-block--table'), 3000);
R.t(!!$('.plain-block--table'), 'Windows plain block editor renders table block when alwaysShowMarkers=true and collapseBlockSource=true');
const plainTblBtn = $('.plain-block--table .plain-block-source-btn');
if (R.t(!!plainTblBtn && !$('.plain-block--table .plain-block__textarea'), 'Windows plain table source is collapsed by default with </> 源码 button')) {
  plainTblBtn.click(); await tick();
  R.t(!!$('.plain-block--table .plain-block__textarea'), 'clicking </> 源码 in Windows plain editor reveals table source textarea');
  // #530: while table block (index 1) is active, heading/wikilink blocks are inactive and keep Markdown markers visible (.plain-md-marker)
  R.t($$('.plain-block-editor .plain-md-marker').length > 0, '#530: Windows plain block editor keeps Markdown markers visible when alwaysShowMarkers=true');
  $('.plain-block--table .plain-block-source-btn')?.click(); await tick();
  R.t(!$('.plain-block--table .plain-block__textarea'), 'clicking − 折叠源码 in Windows plain editor hides table source textarea again');
}
// #532: showLineNumbers in Windows Plain Block Editor (.plain-block-editor)
settings.showLineNumbers = true; await tick();
R.t($$('.plain-block-editor .plain-block__lineno').length > 0, '#532: Windows plain block editor renders line numbers when showLineNumbers=true');
settings.showLineNumbers = false; await tick();
history.replaceState(null, '', location.pathname);
settings.windowsEditorEngine = 'auto';
settings.alwaysShowMarkers = false;
await tick();
// #534: theme_get_dir returns <config_dir>/themes
const themesDir = await window.__TAURI_INTERNALS__.invoke('theme_get_dir');
R.t(typeof themesDir === 'string' && /themes$/i.test(themesDir), `#534: theme_get_dir ends with themes (${themesDir})`);
// #535 & #359: export.custom opens CustomExportDialog
act('export.custom');
const ced = await waitFor(() => $('.custom-export-dialog'), 3000);
R.t(!!ced && $$('.custom-export__select option').length === 4, '#535/#359: export.custom opens CustomExportDialog with 4 format options');
$('.custom-export__close')?.click();
await tick();
return R.done();
