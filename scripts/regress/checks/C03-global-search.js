// id: C3
// title: search.global finds hits across the vault and a click jumps to the line
const R = checks();
act('search.global');
const input = await waitFor(() => $$('.sp__input').find(vis), 3000);
if (!R.t(!!input, 'search panel input visible')) return R.done();
R.t(document.activeElement === input, 'input focused');
input.value = 'Back to';
input.dispatchEvent(new InputEvent('input', { bubbles: true }));
const hit = await waitFor(() => $$('.sp__hit').find((h) => h.textContent.includes('Back to')), 6000);
if (!R.t(!!hit, 'hit for "Back to" listed')) return R.done();
R.t(hit.querySelector('.sp__lineno')?.textContent === 'L13', 'hit line L13 (' + hit.querySelector('.sp__lineno')?.textContent + ')');
hit.click();
const ok = await waitFor(() => tabs.activeTab?.fileName === 'Table Note.md' && V() && lineOf(V().state.selection.main.head) === 13, 4000);
R.t(!!ok, 'click opens Table Note.md with the caret on line 13');
return R.done();
