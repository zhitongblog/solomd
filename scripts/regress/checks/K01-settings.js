// id: K1
// title: settings — 7 sections open, search finds items in zh and en, deep link lands on 快捷键
const R = checks();
act('settings.open');
const panel = await waitFor(() => $$('.settings__nav-item').length >= 7 && $('.settings__body'), 3000);
if (!R.t(!!panel, 'settings open with nav')) return R.done();
const navs = $$('.settings__nav-item:not(.settings__nav-supporter)').filter(vis);
R.eq(navs.map((n) => n.textContent.trim()), ['基础', '写作', '同步', '集成', '导出', '快捷键', '高级'], 'sections');
for (const n of navs) {
  n.click(); await sleep(120);
  const title = $('.settings__page-title')?.textContent.trim();
  const shown = $$('.settings__body section').filter(vis).length;
  R.t(title === n.textContent.trim() && shown > 0, `${n.textContent.trim()}: title "${title}", ${shown} sections`);
  if (n.textContent.trim() === '同步') {
    const subs = $$('.settings__sync-subnav-tab').filter(vis).map((s) => s.textContent.trim());
    R.eq(subs, ['Git 同步', '笔记库管理', '网盘直连 API', '本地网盘目录', 'WebDAV 同步', '历史版本快照'], 'sync secondary nav items (#524, #528, #531)');
    const webdavSub = $$('.settings__sync-subnav-tab').find((s) => s.textContent.includes('WebDAV'));
    webdavSub?.click(); await sleep(120);
    const fs = $('.webdav-sync__fieldset');
    R.t(!!fs && fs.disabled === !settings.webdavEnabled, 'webdav fieldset disabled state follows webdavEnabled (#525)');
  }
}
const search = $('.settings__search-input');
for (const q of ['行号', 'line numbers']) {
  search.value = q; search.dispatchEvent(new InputEvent('input', { bubbles: true })); await sleep(300);
  const hit = $$('.settings__body label, .settings__body .settings__row').filter(vis).some((e) => /显示行号/.test(e.textContent));
  R.t(hit, `search "${q}" finds 显示行号`);
}
search.value = ''; search.dispatchEvent(new InputEvent('input', { bubbles: true }));
APP.settingsOpen = false; await sleep(200);
APP.openSettingsAt('keys');
await waitFor(() => $('.settings__page-title'), 2000);
await sleep(200);
R.eq($('.settings__page-title')?.textContent.trim(), '快捷键', 'deep link "keys" lands on 快捷键');
APP.settingsOpen = false;
return R.done();
