// id: D2
// title: view.toggleReading shows the reading view and toggles back
const R = checks();
await open('README.md');
act('view.toggleReading');
const ok = await waitFor(() => settings.viewMode === 'reading' && $$('.reading-view').some(vis), 3000);
R.t(!!ok, 'reading view visible');
R.t($$('.reading-view h2').length >= 2, 'renders headings (' + $$('.reading-view h2').length + ' h2)');
act('view.toggleReading');
R.t(!!(await waitFor(() => settings.viewMode === 'liveEdit', 2000)), 'toggle back to liveEdit (' + settings.viewMode + ')');
return R.done();
