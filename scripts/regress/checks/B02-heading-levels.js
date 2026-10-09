// id: B2
// title: heading.promote / demote / paragraph change the level
const R = checks();
await fresh('h.md', '## Title\n');
const step = async (id, want) => { act(id); await sleep(80); R.eq(doc(), want, id); };
setDoc('## Title\n', 4);
await step('heading.promote', '# Title\n');
await step('heading.promote', '# Title\n');
await step('heading.demote', '## Title\n');
await step('heading.demote', '### Title\n');
await step('heading.paragraph', 'Title\n');
return R.done();
