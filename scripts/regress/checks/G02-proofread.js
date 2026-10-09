// id: G2
// title: CJK proofread finds real issues, leaves file names / ellipses / URLs alone; fix all fixes
const R = checks();
const src = await readText('notes/Chinese.md');
const issues = await inv('cjk_proofread', { text: src });
const lines = src.split('\n');
const hits = issues.map((i) => ({ line: i.line, text: i.original, cat: i.category, sug: i.suggestion }));
R.note('issues: ' + JSON.stringify(hits));
R.t(hits.some((h) => h.line === 3 && h.text === ':'), 'half-width colon after CJK flagged');
R.t(hits.some((h) => h.line === 3 && h.text === ','), 'half-width comma flagged');
const line4 = hits.filter((h) => h.line === 4 && h.cat === 'punct_halfwidth');
R.eq(line4, [], 'report.pdf / 调试开关.ps1 / 压缩包.tar.gz not flagged');
R.eq(hits.filter((h) => h.line === 5 && h.cat === 'punct_halfwidth'), [], '…… and ... not flagged');
R.eq(hits.filter((h) => h.line === 6 && h.cat === 'punct_halfwidth'), [], 'URL not flagged');
// UI: open the panel, fix all
const t = await fresh('proof.md', src);
act('proofread.cjk');
const panel = await waitFor(() => APP.cjkProofreadOpen && $$('.proof__row').length > 0, 4000);
if (!R.t(!!panel, 'proofread panel lists issues')) return R.done();
const all = $$('button.btn--primary').find((b) => /全部/.test(b.textContent));
R.t(!!all, '全部修复 button');
all?.click();
await sleep(600);
const fixed = tabs.activeTab.content;
R.t(/这是测试：中文后面用了半角冒号，/.test(fixed), 'line 3 punctuation fixed');
R.t(fixed.includes('report.pdf') && fixed.includes('调试开关.ps1') && fixed.includes('压缩包.tar.gz'), 'file names untouched by fix all');
R.t(fixed.includes('...') && fixed.includes('https://example.com/a,b.html'), 'ellipsis and URL untouched');
return R.done();
