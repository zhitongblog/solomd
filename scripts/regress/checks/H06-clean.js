// id: H6
// title: clean.stripMarkdown / clean.aiArtifacts / format.markdown clean the text
const R = checks();
await fresh('clean.md', '# Title\n\nSome **bold** and *it* with [link](http://x) and `code`.\n\n- item\n> quote\n');
act('clean.stripMarkdown'); await sleep(300);
const s = doc();
R.t(!/[*#`\[\]>]/.test(s) && /Title/.test(s) && /bold/.test(s) && /link/.test(s), 'stripMarkdown -> ' + JSON.stringify(s));
setDoc('A​B “quoted” — dash\n');
await sleep(400);
act('clean.aiArtifacts'); await sleep(300);
R.t(!doc().includes('​') && doc().includes('"quoted"'), 'aiArtifacts -> ' + JSON.stringify(doc()));
// No pause: the transforms must read the editor, not the 350 ms-stale tab copy (F-5 family).
setDoc('*   item\n\n\n\npara\n');
act('format.markdown'); await sleep(300);
R.t(/^- item\n\npara\n$/.test(doc()), 'format.markdown -> ' + JSON.stringify(doc()));
return R.done();
