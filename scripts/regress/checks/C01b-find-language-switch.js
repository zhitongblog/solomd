// id: C1
// title: an open tab's find bar follows a language switch (en then back to zh)
const R = checks();
await fresh('findlang.md', 'abc\n');
settings.setLanguage('en');
await sleep(300);
act('edit.find');
const panel = await waitFor(() => $('.cm-find'), 2000);
if (!R.t(!!panel, 'find bar open')) return R.done();
R.eq($('input[name=search]', panel).placeholder, 'Find', 'en placeholder after switching to English');
key($('input[name=search]', panel), 'Escape'); await sleep(100);
settings.setLanguage('zh');
await sleep(300);
act('edit.find');
const p2 = await waitFor(() => $('.cm-find'), 2000);
R.eq(p2 && $('input[name=search]', p2).placeholder, '查找', 'zh placeholder after switching back');
return R.done();
