// id: B1 F-6
// title: fmt.* toggle on and off, keep the selection, toggle off from inside (incl. CJK and code block)
const R = checks();
await fresh('fmt.md', 'hello world\n');
const inline = { 'fmt.bold': '**world**', 'fmt.italic': ['*world*', '_world_'], 'fmt.strike': '~~world~~', 'fmt.code': '`world`' };
for (const [id, want] of Object.entries(inline)) {
  setDoc('hello world\n', 6, 11);
  act(id); await sleep(80);
  const on = doc();
  const wants = [].concat(want);
  R.t(wants.some((w) => on === 'hello ' + w + '\n'), `${id} on -> ${JSON.stringify(on)}`);
  R.eq(sel().text, 'world', `${id}: selection kept`);
  act(id); await sleep(80);
  R.eq(doc(), 'hello world\n', `${id} off`);
}
// Link
setDoc('hello world\n', 6, 11);
act('fmt.link'); await sleep(80);
R.t(/^hello \[world\]\(.*\)\n$/.test(doc()), 'fmt.link -> ' + JSON.stringify(doc()));
// Line formats on/off with a bare caret
const lines = { 'fmt.h1': '# line one', 'fmt.h2': '## line one', 'fmt.h3': '### line one', 'fmt.h6': '###### line one', 'fmt.ul': '- line one', 'fmt.ol': '1. line one', 'fmt.task': '- [ ] line one', 'fmt.quote': '> line one' };
for (const [id, want] of Object.entries(lines)) {
  setDoc('line one\n', 3);
  act(id); await sleep(80);
  R.eq(doc(), want + '\n', `${id} on`);
  act(id); await sleep(80);
  R.eq(doc(), 'line one\n', `${id} off`);
}
// F-6a: code block toggles off on the second press (caret ends on the fence line)
setDoc('line one\n', 3);
act('fmt.codeblock'); await sleep(80);
R.t(/^```[^\n]*\nline one\n```\n?/.test(doc()), 'fmt.codeblock on -> ' + JSON.stringify(doc()));
act('fmt.codeblock'); await sleep(80);
R.eq(doc().replace(/\n+$/, '\n'), 'line one\n', 'fmt.codeblock pressed twice removes the fence');
// F-6b: caret inside existing bold, CJK and Latin
setDoc('这是**粗体**文字\n', 5);
act('fmt.bold'); await sleep(80);
R.eq(doc(), '这是粗体文字\n', 'CJK caret inside **粗体** + fmt.bold removes the bold');
setDoc('a **bold** b\n', 6);
act('fmt.bold'); await sleep(80);
R.eq(doc(), 'a bold b\n', 'Latin caret inside **bold** removes the bold');
setDoc('a *it* b\n', 4);
act('fmt.italic'); await sleep(80);
R.eq(doc(), 'a it b\n', 'caret inside *it* + fmt.italic removes the italic');
// CJK caret without markup must not swallow the whole run
setDoc('中文段落\n', 2);
act('fmt.bold'); await sleep(80);
R.t(doc() === '中文****段落\n' || doc() === '中文**段落\n'.replace('**', '****'), 'CJK bare caret inserts an empty pair, no over-extension -> ' + JSON.stringify(doc()));
return R.done();
