// id: C4
// title: quick switcher — fuzzy match, Enter opens, renamed and deleted files are no longer offered
// timeout: 30000
const R = checks();
const qs = async (q) => {
  APP.quickSwitcherOpen = false; await sleep(100);
  act('quickSwitcher.open');
  const input = await waitFor(() => $('.quick-switcher__input'), 3000);
  if (!input) return null;
  input.value = q; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(500);
  return { input, names: $$('.quick-switcher__item').map((e) => e.querySelector('.quick-switcher__name')?.textContent.trim()) };
};
if (PHASE === 1) {
  await writeText('_work/qs-gone.md', 'gone\n');
  await writeText('_work/qs-before.md', 'before\n');
  await open('_work/qs-gone.md'); await open('_work/qs-before.md'); await open('notes/Math Note.md');
  // close them so the switcher must look at recents, not open tabs
  for (const t of [...tabs.tabs]) { t.savedContent = t.content; tabs.closeTab(t.id); }
  let r = await qs('mth');
  R.t(r && r.names[0] === 'Math Note.md', 'fuzzy "mth" ranks Math Note.md first: ' + (r && r.names.slice(0, 3).join(',')));
  key(r.input, 'Enter');
  R.t(!!(await waitFor(() => tabs.activeTab?.fileName === 'Math Note.md', 3000)), 'Enter opens it');
  r = await qs('qs-');
  R.t(r && r.names.includes('qs-gone.md') && r.names.includes('qs-before.md'), 'both work files offered before: ' + (r && r.names.join(',')));
  APP.quickSwitcherOpen = false;
  return { next: R.done(), host: { delete: ['_work/qs-gone.md'], rename: { '_work/qs-before.md': '_work/qs-after.md' } }, wait: 1500 };
}
R.t(CARRY.ok, CARRY.detail);
const r = await qs('qs-');
R.t(r && !r.names.includes('qs-gone.md'), 'deleted file not offered: ' + (r && r.names.join(',')));
R.t(r && !r.names.includes('qs-before.md'), 'renamed-away name not offered');
APP.quickSwitcherOpen = false;
return R.done();
