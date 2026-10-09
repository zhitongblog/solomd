// id: A11
// title: window.new opens a second window that loads the app; closing it leaves the main window alone
// timeout: 30000
const R = checks();
const { getAllWebviewWindows } = await import('/node_modules/@tauri-apps/api/webviewWindow.js');
const before = (await getAllWebviewWindows()).map((w) => w.label);
await open('README.md');
const mainTabs = tabs.tabs.length;
act('window.new');
const w = await waitFor(async () => (await getAllWebviewWindows()).find((x) => !before.includes(x.label)), 8000, 200);
if (!R.t(!!w, 'second window created (' + (w && w.label) + ')')) return R.done();
await sleep(2500);
R.t(await w.isVisible(), 'second window visible');
R.t(/SoloMD/.test(await w.title()), 'title ' + (await w.title()));
await w.close();
await sleep(500);
R.t(!(await getAllWebviewWindows()).some((x) => x.label === w.label), 'second window closed');
R.eq(tabs.tabs.length, mainTabs, 'main window tabs unaffected');
return R.done();
