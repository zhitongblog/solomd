// id: F3
// title: export.html writes a standalone file with math, mermaid svg and the image inlined
// timeout: 40000
const R = checks();
await writeText('_work/' + CHECK + '.md', '# Html\n\n![logo](../assets/logo.png)\n\n$$\nx^2\n$$\n\n```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
await open('_work/' + CHECK + '.md');
const out = '_work/' + CHECK + '.html';
window.__solomdSavePathOverride = path(out);
act('export.html');
const ok = await waitFor(async () => { try { return (await readText(out)).length > 1000; } catch { return false; } }, 20000, 250);
if (!R.t(!!ok, 'html written')) return R.done();
const html = await readText(out);
R.t(html.includes('<table'), 'table');
R.t(/class="katex/.test(html), 'katex math');
R.t(/<svg[\s\S]*Start[\s\S]*Finish/.test(html), 'mermaid svg');
R.t(/src="data:image\/png;base64,/.test(html), 'image inlined as data: PNG');
R.t(!/^---\n/.test(html), 'no front matter leak');
return R.done();
