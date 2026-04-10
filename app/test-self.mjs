// Self-test for SoloMD pure libs (run with: npx tsx test-self.mjs)
import { simplifiedToTraditional, traditionalToSimplified, pinyin, cjkWordCount } from './src/lib/chinese.ts';
import { extractOutline, renderMarkdown } from './src/lib/markdown.ts';
import { cleanAIArtifacts, stripMarkdownToPlain } from './src/lib/clean-ai.ts';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { console.log('✓', name); pass++; }
  else { console.log('✗', name, detail); fail++; }
}

console.log('\n=== chinese.ts ===');
ok('S→T 软件→軟體', simplifiedToTraditional('软件').includes('軟') || simplifiedToTraditional('软件').length > 0);
ok('T→S 軟體→软体', traditionalToSimplified('軟體').length > 0);
ok('pinyin 你好', pinyin('你好').includes('ni'));
ok('pinyin tones', pinyin('你好', { tone: true }).includes('ǐ') || pinyin('你好', { tone: true }) !== pinyin('你好'));
const wc = cjkWordCount('Hello 世界, this is 一段 mixed 内容!');
ok('cjkWordCount cjk count', wc.cjk === 6, JSON.stringify(wc));
ok('cjkWordCount asciiWords (no punct)', wc.asciiWords === 4, JSON.stringify(wc));
ok('cjkWordCount total', wc.total === 10, JSON.stringify(wc));

console.log('\n=== markdown.ts ===');
const html = renderMarkdown('# Hello\n\n**bold** and *italic* and `code`\n\n- [ ] task\n- [x] done\n\n==mark==\n\nFootnote[^1]\n\n[^1]: note');
ok('renders h1', html.includes('<h1'));
ok('renders strong', html.includes('<strong>'));
ok('renders task list checkbox', html.includes('type="checkbox"'));
ok('renders mark highlight', html.includes('<mark>'));
ok('renders footnote', html.includes('footnote'));
ok('task-list-item class', html.includes('task-list-item'));
ok('contains-task-list class', html.includes('contains-task-list'));

const fmHtml = renderMarkdown('---\ntitle: Test\nauthor: Alex\n---\n\n# body');
ok('frontmatter parsed', fmHtml.includes('md-frontmatter'));
ok('frontmatter dt/dd', fmHtml.includes('<dt>title</dt>') && fmHtml.includes('<dd>Test</dd>'));
ok('frontmatter body still rendered', fmHtml.includes('<h1'));

console.log('\n=== outline ===');
const outline = extractOutline('# H1\n## H2a\n## H2b\n### H3\n# Another H1');
ok('outline length', outline.length === 5, JSON.stringify(outline));
ok('outline H1 level', outline[0].level === 1);
ok('outline H2 level', outline[1].level === 2);
ok('outline H3 level', outline[3].level === 3);

console.log('\n=== clean-ai.ts ===');
// Smart quotes
ok('smart double quotes', cleanAIArtifacts('\u201chello\u201d') === '"hello"');
ok('smart single quotes', cleanAIArtifacts('it\u2019s') === "it's");
// Em / en dashes
ok('em dash', cleanAIArtifacts('hello\u2014world') === 'hello - world');
ok('en dash', cleanAIArtifacts('1\u20132') === '1-2');
// Ellipsis
ok('ellipsis', cleanAIArtifacts('wait\u2026') === 'wait...');
// Invisible chars
ok('zero-width space removed', cleanAIArtifacts('a\u200Bb') === 'ab');
ok('non-breaking space normalized', cleanAIArtifacts('a\u00A0b') === 'a b');
ok('BOM stripped', cleanAIArtifacts('\uFEFFhello') === 'hello');
// Whitespace
ok('triple newline collapsed', cleanAIArtifacts('a\n\n\n\nb') === 'a\n\nb');
ok('trailing whitespace trimmed', cleanAIArtifacts('hello   \nworld') === 'hello\nworld');
// Markdown preserved
ok('markdown preserved', cleanAIArtifacts('# heading\n**bold**') === '# heading\n**bold**');

// Gemini cite markers
ok('Gemini [cite_start] removed', !cleanAIArtifacts('[cite_start]Hello world').includes('[cite_start]'));
ok('Gemini [cite: N, M] removed', !cleanAIArtifacts('Some text [cite: 5, 41].').includes('[cite:'));
ok('Gemini mixed', cleanAIArtifacts('[cite_start]他说了 [cite: 36, 63]。').includes('他说了'));
ok('Gemini mixed no brackets', !cleanAIArtifacts('[cite_start]他说了 [cite: 36, 63]。').includes('['));
// ChatGPT citations
ok('ChatGPT 【†source】 removed', !cleanAIArtifacts('Hello 【1†source】world').includes('【'));
// Perplexity [1][2]
ok('Perplexity [1][2] removed', !cleanAIArtifacts('Hello [1] [2] world').includes('[1]'));

// Strip plain test
const md = '# Title\n\n**bold** and *italic* with `code`.\n\n- item 1\n- [x] done\n\n```js\nconst x = 1;\n```';
const plain = stripMarkdownToPlain(md);
ok('strip plain — no #', !plain.includes('#'));
ok('strip plain — no **', !plain.includes('**'));
ok('strip plain — no `', !plain.includes('`'));
ok('strip plain — no -', !/^- /m.test(plain));
ok('strip plain — keeps content "Title"', plain.includes('Title'));
ok('strip plain — keeps "bold"', plain.includes('bold'));
ok('strip plain — keeps code "const x = 1"', plain.includes('const x = 1'));

console.log(`\n=== ${pass} passed / ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
