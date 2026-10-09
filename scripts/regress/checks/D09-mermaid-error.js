// id: D1
// title: a broken mermaid diagram shows an inline error and leaves nothing under <body>
// timeout: 20000
const R = checks();
const bodyKids = () => [...document.body.children].map((e) => e.tagName + '#' + e.id + '.' + e.className).join(' ');
const before = new Set([...document.body.children]);
await fresh('bad-mermaid.md', '# Bad\n\n```mermaid\ngraph TD\n  A[ --> \n```\n\nafter\n');
settings.setViewMode('split');
await sleep(2500);
const err = await waitFor(() => $$('.preview-host').some((h) => /error/i.test(h.textContent)), 5000);
R.t(!!err, 'inline mermaid error shown in the preview');
await sleep(500);
const added = [...document.body.children].filter((e) => !before.has(e) && !e.matches('.toast, .toasts, [class*=toast]'));
R.t(added.every((e) => !/^d|^i|mermaid/.test(e.id) && !/Syntax error/i.test(e.textContent)), 'no stray mermaid nodes in <body> (added: ' + added.map((e) => e.tagName + '#' + e.id).join(',') + ')');
R.eq(document.scrollingElement.scrollTop, 0, 'document not scrolled');
settings.setViewMode('liveEdit');
return R.done();
