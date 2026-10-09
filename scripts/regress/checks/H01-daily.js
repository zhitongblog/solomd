// id: H1
// title: daily today / yesterday / tomorrow create and open notes in the daily folder
const R = checks();
const d = (off) => { const x = new Date(); x.setDate(x.getDate() + off); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const folder = settings.dailyNotesFolder || 'Daily';
for (const [id, off] of [['daily.openToday', 0], ['daily.openYesterday', -1], ['daily.openTomorrow', 1]]) {
  act(id);
  const ok = await waitFor(() => tabs.activeTab?.fileName === d(off) + '.md', 4000);
  R.t(!!ok, `${id} -> ${tabs.activeTab?.fileName}`);
  await sleep(300);
  R.t(await exists(folder + '/' + d(off) + '.md'), `${folder}/${d(off)}.md on disk`);
}
return R.done();
