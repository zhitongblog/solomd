// One-time setup per run. Returns 'reload' after wiping this origin's storage
// (the runner then waits and calls setup again), 'ready' when done.
if (sessionStorage.getItem('regressVault') !== VAULT) {
  sessionStorage.setItem('regressVault', VAULT);
  sessionStorage.removeItem('regressBaseline');
  // Session restore writes tabs on unload; drop them so the reload starts clean.
  for (const t of st('tabs').tabs) t.savedContent = t.content;
  localStorage.clear();
  setTimeout(() => { localStorage.clear(); location.reload(); }, 50);
  return 'reload';
}
await waitFor(() => document.querySelector('.cm-content') || document.querySelector('.app'), 15000);
// The checks assert on Chinese UI strings (zh is the primary audience).
settings.setLanguage('zh');
settings.telemetryEnabled = false;
// Never hit the network for update checks during a run.
if ('autoCheckUpdates' in settings) settings.autoCheckUpdates = false;
settings.persist();
// Capture every toast message (they expire after ~2s).
if (!toasts.__regressHooked) {
  const orig = toasts.push.bind(toasts);
  toasts.push = (msg, ...rest) => { (window.__regressToasts ||= []).push(String(msg)); return orig(msg, ...rest); };
  toasts.__regressHooked = true;
}
// Open the fixture vault as the workspace.
workspace.setFolder(VAULT);
const idx = st('workspaceIndex');
await waitFor(() => idx.folder === VAULT && idx.ready && idx.entries.length >= 5, 15000);
if (!(idx.ready && idx.entries.length >= 5)) return 'index not ready: ' + idx.entries.length;
await waitFor(() => document.querySelector('.ftree, [class*="ftree"]'), 5000);
// Baseline settings every check starts from (see reset.js). Kept in
// sessionStorage so a reload inside a check (restart simulation) does not
// re-baseline on whatever that check changed.
const savedBase = sessionStorage.getItem('regressBaseline');
window.__regressSettings = savedBase ? JSON.parse(savedBase) : JSON.parse(JSON.stringify(settings.$state));
if (!savedBase) sessionStorage.setItem('regressBaseline', JSON.stringify(window.__regressSettings));
window.__regressTiles = JSON.parse(JSON.stringify(tiles.$state));
return 'ready';
