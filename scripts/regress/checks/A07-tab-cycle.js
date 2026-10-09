// id: A7
// title: tab.next / tab.prev wrap; clicking a tab activates it
const R = checks();
await open('README.md'); await open('Table Note.md'); await open('long.md');
const ids = tabs.tabs.map((t) => t.id);
const n = ids.length;
tabs.activate(ids[n - 1]);
act('tab.next');
await sleep(100);
R.eq(tabs.activeId, ids[0], 'tab.next wraps last->first');
act('tab.prev');
await sleep(100);
R.eq(tabs.activeId, ids[n - 1], 'tab.prev wraps first->last');
const tabEls = $$('[role=tab]').filter(vis);
const target = tabEls.find((e) => e.textContent.includes('README'));
if (R.t(!!target, 'README tab element visible')) {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }));
  }
  await sleep(200);
  R.t(tabs.activeTab?.fileName === 'README.md', 'click activates README (active ' + tabs.activeTab?.fileName + ')');
}
return R.done();
