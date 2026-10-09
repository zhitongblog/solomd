// id: D5 F-9
// title: editor / preview / UI zoom in, out and reset to the 5.0 defaults (16 / 16 / 1)
const R = checks();
await open('README.md');
const fs0 = settings.fontSize, pf0 = settings.previewFontSize;
R.eq([fs0, pf0], [16, 16], 'fresh 5.0 defaults');
act('view.zoomEditorIn'); await sleep(100);
R.eq(settings.fontSize, fs0 + 1, 'editor zoom in');
R.t(parseFloat(getComputedStyle($('.cm-content')).fontSize) === fs0 + 1, 'editor font size follows (' + getComputedStyle($('.cm-content')).fontSize + ')');
act('view.zoomEditorOut'); act('view.zoomEditorOut'); await sleep(100);
R.eq(settings.fontSize, fs0 - 1, 'editor zoom out');
act('view.zoomEditorReset'); await sleep(100);
R.eq(settings.fontSize, 16, 'editor reset -> 16');
for (const id of ['view.zoomPreviewIn', 'view.zoomPreviewIn']) act(id);
await sleep(100);
R.eq(settings.previewFontSize, pf0 + 2, 'preview zoom in');
act('view.zoomPreviewReset'); await sleep(100);
R.eq(settings.previewFontSize, 16, 'preview reset -> 16');
const z0 = settings.globalZoom ?? 1;
act('view.zoomUiIn'); await sleep(200);
R.t((settings.globalZoom ?? 1) > z0, 'UI zoom in (' + settings.globalZoom + ')');
act('view.zoomUiReset'); await sleep(200);
R.eq(settings.globalZoom ?? 1, 1, 'UI reset -> 1');
return R.done();
