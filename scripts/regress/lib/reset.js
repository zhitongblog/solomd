// Runs before every check: put the app back to the baseline taken by setup.js
// so checks stay independent of each other and of their order.
const snap = window.__regressSettings;
// 1. Close every App-level overlay / dialog (App.vue refs named *Open).
for (const k of Object.keys(APP)) {
  if (/Open$/.test(k) && typeof APP[k] === 'boolean' && APP[k]) { try { APP[k] = false; } catch {} }
}
const pomo = st('pomodoro');
try { if (pomo.active) pomo.stop(); } catch {}
// 2. Dev-only hooks a check may have left behind.
delete window.__solomdSavePathOverride;
window.__regressToasts = [];
// 3. Settings back to the baseline (replace, don't merge: keybindings is an object).
if (snap) {
  settings.$patch((s) => { for (const k of Object.keys(snap)) s[k] = JSON.parse(JSON.stringify(snap[k])); });
  settings.persist();
}
// 4. Workspace back to the fixture vault.
if (workspace.currentFolder !== VAULT) workspace.setFolder(VAULT);
// 5. One pane, no tabs except a blank untitled one.
for (let i = 0; i < 8 && tiles.allLeaves.length > 1; i++) {
  const leaves = tiles.allLeaves;
  tiles.closePane(leaves[leaves.length - 1].id);
}
for (const t of [...tabs.tabs]) { t.savedContent = t.content; tabs.closeTab(t.id); }
// closeTab leaves one fresh Untitled tab when the last one goes.
for (const t of [...tabs.tabs]) if (t.filePath || t.content) { t.content = ''; t.savedContent = ''; }
await sleep(250);
// 6. Escape anything still floating (menus, popovers) — aimed at <body>, not the editor.
key(document.body, 'Escape');
document.activeElement && document.activeElement.blur && document.activeElement.blur();
await sleep(100);
return 'ok';
