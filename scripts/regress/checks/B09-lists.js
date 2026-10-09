// id: B9 F-7
// title: Enter continues and renumbers lists; Tab nests ordered items at marker width
const R = checks();
await fresh('list.md', '1. one\n');
const v = V();
v.focus();
const enterAt = async (text, pos) => { setDoc(text, pos); key(v.contentDOM, 'Enter'); await sleep(100); return doc(); };
R.eq(await enterAt('1. one\n2. two', 13), '1. one\n2. two\n3. ', 'Enter after 2. two -> 3. ');
R.eq(await enterAt('- a', 3), '- a\n- ', 'bullet continues');
R.eq(await enterAt('- [ ] t', 7), '- [ ] t\n- [ ] ', 'task continues unchecked');
// CodeMirror's insertNewlineContinueMarkup (nonTightLists): the 1st Enter on an empty
// item loosens the list, the 2nd ends it. Assert the end state, not the path.
{ await enterAt('- a\n- ', 6); key(v.contentDOM, 'Enter'); await sleep(100);
  const d2 = doc(); R.t(!/(^|\n)- *$/.test(d2.replace(/\n+$/, '')) && d2.startsWith('- a\n'), 'Enter on an empty bullet (twice at most) ends the list: ' + JSON.stringify(d2)); }
R.eq(await enterAt('1. a\n2. b\n3. c', 4), '1. a\n2. \n3. b\n4. c', 'Enter mid-list renumbers');
// Tab on a bullet nests by 2
setDoc('- a\n- b\n', 6); key(v.contentDOM, 'Tab'); await sleep(100);
R.eq(doc(), '- a\n  - b\n', 'Tab nests a bullet');
key(v.contentDOM, 'Tab', { shift: true }); await sleep(100);
R.eq(doc(), '- a\n- b\n', 'Shift+Tab unnests');
// F-7: Tab on ordered item nests at marker width (3) and renumbers
setDoc('1. one\n2. two\n3. three\n', 9); key(v.contentDOM, 'Tab'); await sleep(150);
const d = doc();
const m = d.match(/^1\. one\n( +)(\d+)\. two\n(\d+)\. three\n$/);
R.t(!!m && m[1].length >= 3, 'Tab on "2. two" indents by the marker width: ' + JSON.stringify(d));
if (m) R.eq([m[2], m[3]], ['1', '2'], 'nested item restarts at 1 and the next top-level item is renumbered');
// Rendered as a real nested list
const { renderMarkdown } = await import('/src/lib/markdown.ts');
const html = await renderMarkdown(d);
R.t(/<ol[^>]*>[\s\S]*<li[^>]*>[\s\S]*one[\s\S]*<ol/.test(String(html)), 'renderer sees a nested <ol>');
return R.done();
