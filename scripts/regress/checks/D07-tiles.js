// id: D7
// title: tile.splitRight / splitDown / focusNext / focusPrev / closePane; the new pane's editor has the keyboard
const R = checks();
await open('README.md');
const editors = () => $$('.cm-editor').filter(vis).length;
act('tile.splitRight'); await sleep(400);
R.eq(tiles.allLeaves.length, 2, 'splitRight -> 2 panes');
R.t(editors() >= 2, 'two editors visible');
R.t(!!(await waitFor(() => document.activeElement?.closest?.(`[data-pane-id="${tiles.focusedPaneId}"] .cm-content`), 1500)), 'focus in the new pane\'s editor');
act('tile.splitDown'); await sleep(400);
R.eq(tiles.allLeaves.length, 3, 'splitDown -> 3 panes');
const order = tiles.allLeaves.map((l) => l.id);
const f0 = tiles.focusedPaneId;
act('tile.focusNext'); await sleep(100);
const f1 = tiles.focusedPaneId;
act('tile.focusPrev'); await sleep(100);
R.t(f1 !== f0 && tiles.focusedPaneId === f0, 'focusNext/focusPrev cycle');
act('tile.closePane'); await sleep(200); act('tile.closePane'); await sleep(200);
R.eq(tiles.allLeaves.length, 1, 'closePane x2 -> 1 pane');
return R.done();
