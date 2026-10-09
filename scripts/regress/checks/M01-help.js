// id: M1
// title: help.about / shortcuts / markdown / cli / checkUpdate
const R = checks();
act('help.about');
const about = await waitFor(() => $('.about__version'), 3000);
R.t(!!about, 'about opens: ' + about?.textContent.trim());
const pkgVer = (await (await fetch('/package.json')).json().catch(() => ({}))).version;
if (pkgVer) R.eq(about?.textContent.trim(), 'v' + pkgVer, 'about version = package.json');
APP.aboutOpen = false; await sleep(200);
for (const [id, re] of [['help.shortcuts', /快捷键/], ['help.markdown', /Markdown/], ['help.cli', /CLI|solomd/i]]) {
  act(id);
  const ok = await waitFor(() => APP.helpOpen && $('.help__body') && re.test($('.help__hdr')?.innerText + $('.help__body').innerText), 3000);
  R.t(!!ok, id + ' opens the right help tab (' + APP.helpTab + ')');
  APP.helpOpen = false; await sleep(150);
}
return R.done();
