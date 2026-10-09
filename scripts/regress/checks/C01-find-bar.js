// id: C1
// title: ⌘F find bar — zh labels, focus in the query, n/m count, Enter / Shift+Enter cycle, Esc closes back to the editor
const R = checks();
await fresh('find.md', 'Task one\ntask two\nanother task\nTASK four\n');
const v = V();
v.focus();
v.dispatch({ selection: { anchor: v.state.doc.length } });
key(v.contentDOM, 'f', { meta: true });
const panel = await waitFor(() => $('.cm-find'), 2000);
if (!R.t(!!panel, '⌘F opens .cm-find')) return R.done();
const input = $('input[name=search]', panel);
R.t(document.activeElement === input, 'query field focused');
R.eq([input.placeholder, $('input[name=replace]', panel)?.placeholder], ['查找', '替换为'], 'zh placeholders');
const titles = $$('button', panel).map((b) => b.title || b.textContent.trim());
R.t(['区分大小写', '正则表达式', '全词匹配', '全部替换'].every((x) => titles.some((t) => t.includes(x))), 'zh button labels: ' + titles.join('|'));
input.value = 'task';
input.dispatchEvent(new InputEvent('input', { bubbles: true }));
await sleep(150);
const count = () => $('.cm-find__count', panel).textContent;
R.eq(count(), '0/4', 'count before the first Enter (caret at the end)');
const seq = [];
for (let i = 0; i < 5; i++) { key(input, 'Enter'); await sleep(80); seq.push(count()); }
R.eq(seq, ['1/4', '2/4', '3/4', '4/4', '1/4'], 'Enter cycles and wraps');
key(input, 'Enter', { shift: true }); await sleep(80);
R.eq(count(), '4/4', 'Shift+Enter goes back (wraps)');
R.t(document.activeElement === input, 'focus stays in the query while cycling');
key(input, 'Escape'); await sleep(150);
R.t(!$('.cm-find'), 'Esc closes the bar');
R.t(!!document.activeElement?.closest?.('.cm-content'), 'focus back in the editor');
// Menu route opens it too
act('edit.find');
R.t(!!(await waitFor(() => $('.cm-find'), 2000)), 'menu edit.find opens the bar');
return R.done();
