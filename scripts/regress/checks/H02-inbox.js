// id: H2
// title: inbox lists inbox notes with a sane age; organize & advance saves inbox:false to disk and moves on
const R = checks();
await writeText('_work/inboxA.md', '---\ninbox: true\n---\n# Inbox Alpha\n');
await writeText('_work/inboxB.md', '---\ninbox: true\n---\n# Inbox Beta\n');
await st('workspaceIndex').rescan?.();
await sleep(800);
act('inbox.open');
const view = await waitFor(() => APP.inboxViewOpen && $$('[class*=inbox]').some(vis), 3000);
if (!R.t(!!view, 'inbox view opens')) return R.done();
await sleep(500);
const txt = $$('[class*=inbox]').filter(vis).map((e) => e.innerText).join(' ');
R.t(/inboxA|Inbox Alpha/.test(txt) && /inboxB|Inbox Beta/.test(txt), 'both inbox notes listed: ' + txt.replace(/\s+/g, ' ').slice(0, 160));
R.t(!/\d{2,}\s*年前/.test(txt), 'no absurd "N年前" ages: ' + (txt.match(/\S*年前/) || ['none'])[0]);
APP.inboxViewOpen = false;
await open('_work/inboxA.md');
act('inbox.organizeAndAdvance');
await sleep(800);
const disk = await readText('_work/inboxA.md');
R.t(/inbox:\s*false/.test(disk) || !/inbox:\s*true/.test(disk), 'inbox flag cleared ON DISK: ' + JSON.stringify(disk.slice(0, 40)));
R.t(!tabs.tabs.some((t) => t.filePath === path('_work/inboxA.md') && tabs.isDirty(t.id)), 'tab not left dirty');
return R.done();
