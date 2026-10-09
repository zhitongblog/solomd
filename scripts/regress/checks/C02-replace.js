// id: C2
// title: replace — first click replaces, replace all, Aa / W / .* options
const R = checks();
await fresh('repl.md', 'cat Cat cat1 cat\n');
act('editor.replace');
const panel = await waitFor(() => $('.cm-find'), 2000);
if (!R.t(!!panel, 'replace bar open')) return R.done();
const find = $('input[name=search]', panel), rep = $('input[name=replace]', panel);
R.t(document.activeElement === find || document.activeElement === rep, 'focus in a find/replace field');
const setF = async (el, val) => { el.value = val; el.dispatchEvent(new InputEvent('input', { bubbles: true })); await sleep(120); };
const count = () => $('.cm-find__count', panel).textContent;
const btn = (n) => $(`button[name=${n}]`, panel);
await setF(find, 'cat'); await setF(rep, 'dog');
R.t(/\/4$/.test(count()), 'case-insensitive: 4 matches (' + count() + ')');
btn('case').click(); await sleep(120);
R.t(/\/3$/.test(count()), 'Aa: 3 matches (' + count() + ')');
btn('word').click(); await sleep(120);
R.t(/\/2$/.test(count()), 'Aa+W: 2 matches (' + count() + ')');
// Replace one: the FIRST click must replace (round-1 C2 needed two clicks)
key(find, 'Enter'); await sleep(80);
const before = doc();
btn('replace').click(); await sleep(150);
R.t(doc() !== before, 'first 替换 click replaces: ' + JSON.stringify(doc()));
btn('replaceAll').click(); await sleep(150);
R.eq(doc(), 'dog Cat cat1 dog\n', '全部替换 respects Aa + W');
btn('word').click(); btn('case').click(); await sleep(80);
btn('re').click(); await setF(find, 'c.t\\d'); await setF(rep, 'X');
R.t(/\/1$/.test(count()), '.*: c.t\\d 1 match (' + count() + ')');
btn('replaceAll').click(); await sleep(150);
R.eq(doc(), 'dog Cat X dog\n', 'regex replace all');
return R.done();
