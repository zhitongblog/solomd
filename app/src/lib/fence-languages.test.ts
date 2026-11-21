import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { createHljs } from './hljs-setup.ts';

const hljs = createHljs();

import { fenceLanguageComplete } from './cm-fence-completion.ts';
import { codeLanguages } from './code-languages.ts';
import {
  FENCE_LANGUAGES,
  filterFenceLanguages,
  isInsideFenceBefore,
  matchFenceOpener,
} from './fence-languages.ts';

const catalogueNames = () => FENCE_LANGUAGES.map((l) => l.name);

// ---- the catalogue ------------------------------------------------------

test('every language the code editor highlights is offered', () => {
  for (const lang of codeLanguages) {
    const row = FENCE_LANGUAGES.find((l) => l.name === lang.name);
    assert.ok(row, `${lang.name} is missing from the fence catalogue`);
    for (const alias of lang.alias ?? []) {
      if (alias === lang.name) continue;
      assert.ok(row.aliases.includes(alias), `${lang.name} lost its ${alias} alias`);
    }
  }
});

test('no row lists its own name as an alias', () => {
  // LanguageDescription.of() appends the name to `alias`, so the derivation has
  // to drop it — otherwise the hint reads "python, python".
  for (const lang of FENCE_LANGUAGES) {
    assert.ok(!lang.aliases.includes(lang.name), `${lang.name} lists itself as an alias`);
    if (lang.hint) assert.ok(!lang.hint.includes(`${lang.name},`), `${lang.name} hint repeats itself`);
  }
});

test('the preview-only rows are languages highlight.js really resolves', () => {
  const core = new Set(codeLanguages.map((l) => l.name));
  const extra = FENCE_LANGUAGES.filter((l) => !l.special && !core.has(l.name));
  assert.ok(extra.length >= 15, 'expected the preview-only group to be present');
  for (const lang of extra) {
    assert.ok(hljs.getLanguage(lang.name), `highlight.js cannot render ${lang.name}`);
    for (const alias of lang.aliases) {
      assert.ok(hljs.getLanguage(alias), `highlight.js cannot render ${alias} (${lang.name})`);
    }
  }
});

test('the SoloMD-specific fences come first, before anything is typed', () => {
  assert.deepEqual(
    filterFenceLanguages('').slice(0, 3).map((l) => l.name),
    ['mermaid', 'tldraw', 'plantuml'],
  );
});

test('an empty query leaves the catalogue in its own order', () => {
  assert.deepEqual(filterFenceLanguages('').map((l) => l.name), catalogueNames());
});

test('an alias finds its language instead of only its prefix', () => {
  // CM's own filter would drop every one of these: no label starts with them.
  assert.equal(filterFenceLanguages('py')[0].name, 'python');
  assert.equal(filterFenceLanguages('rs')[0].name, 'rust');
  assert.equal(filterFenceLanguages('yml')[0].name, 'yaml');
  assert.equal(filterFenceLanguages('js')[0].name, 'javascript');
  assert.equal(filterFenceLanguages('golang')[0].name, 'go');
  assert.equal(filterFenceLanguages('objc')[0].name, 'objectivec');
});

test('keywords surface a fence the user cannot name', () => {
  assert.equal(filterFenceLanguages('flowchart')[0].name, 'mermaid');
  assert.equal(filterFenceLanguages('whiteboard')[0].name, 'tldraw');
  assert.equal(filterFenceLanguages('uml')[0].name, 'plantuml');
});

test('every word a row shows is also a word that finds it', () => {
  // Hints and aliases are the only searchable text a user can see, so a hint
  // that does not match is a dead end ("whiteboard" used to find nothing).
  for (const lang of FENCE_LANGUAGES) {
    const words = [
      ...lang.aliases,
      ...(lang.hint ? lang.hint.split(/[^A-Za-z0-9_+#.]+/).filter(Boolean) : []),
    ]
      .map((w) => w.toLowerCase())
      .filter((w) => w !== lang.name);
    for (const word of words) {
      // `some`, not "is first": a word can legitimately fit two languages
      // (both diagram fences claim "diagram"), as long as it reaches this one.
      assert.ok(
        filterFenceLanguages(word).some((l) => l.name === lang.name),
        `"${word}" does not find ${lang.name}`,
      );
    }
  }
});

test('a half-remembered spelling still lands', () => {
  assert.equal(filterFenceLanguages('tldr')[0].name, 'tldraw');
  assert.equal(filterFenceLanguages('pyth')[0].name, 'python');
});

test('the limit bounds what a popup has to render', () => {
  assert.equal(filterFenceLanguages('', 5).length, 5);
  assert.ok(filterFenceLanguages('').length > 30, 'the catalogue should be worth filtering');
});

// ---- recognising the opener ---------------------------------------------

test('a fence opener is recognised where it should be', () => {
  assert.deepEqual(matchFenceOpener('```'), { marker: '```', query: '', queryStart: 3 });
  assert.deepEqual(matchFenceOpener('```py'), { marker: '```', query: 'py', queryStart: 3 });
  assert.deepEqual(matchFenceOpener('  ```js'), { marker: '```', query: 'js', queryStart: 5 });
  assert.deepEqual(matchFenceOpener('text\n```ru'), { marker: '```', query: 'ru', queryStart: 8 });
  assert.deepEqual(matchFenceOpener('````ts'), { marker: '````', query: 'ts', queryStart: 4 });
  assert.deepEqual(matchFenceOpener('```c++'), { marker: '```', query: 'c++', queryStart: 3 });
});

test('a fence opener is ignored where it should be', () => {
  assert.equal(matchFenceOpener(''), null);
  assert.equal(matchFenceOpener('``'), null);
  assert.equal(matchFenceOpener('use ```'), null, 'not at the start of a line');
  assert.equal(matchFenceOpener('```py '), null, 'the info string is finished');
  assert.equal(matchFenceOpener('```py x'), null);
  assert.equal(matchFenceOpener('~~~py'), null, 'only backticks drive the live blocks');
});

test('a closing fence is never mistaken for an opener', () => {
  assert.equal(isInsideFenceBefore(''), false);
  assert.equal(isInsideFenceBefore('prose\n'), false);
  assert.equal(isInsideFenceBefore('```py\nx = 1\n'), true);
  assert.equal(isInsideFenceBefore('```py\nx = 1\n```\n'), false);
  assert.equal(isInsideFenceBefore('  ```\ncode\n'), true);
});

test('closing rules follow CommonMark, not backtick counting', () => {
  // A closing fence may not carry an info string, so this line is content and
  // the block is still open. Counting runs would call it a closer and then let
  // the popup's Enter insert a language into the real closing fence.
  assert.equal(isInsideFenceBefore('```py\n```pyt\n'), true);
  assert.equal(isInsideFenceBefore('```py\n``\n'), true, 'shorter than the opener');
  assert.equal(isInsideFenceBefore('````py\n```\n'), true, 'shorter than a four-backtick opener');
  assert.equal(isInsideFenceBefore('````py\n````\n'), false);
  assert.equal(isInsideFenceBefore('```py\n```   \n'), false, 'trailing spaces still close');
});

// ---- the CodeMirror source ----------------------------------------------

const contextFor = (doc: string) =>
  new CompletionContext(EditorState.create({ doc }), doc.length, true);

test('the CodeMirror source completes the info string in place', () => {
  const result = fenceLanguageComplete(contextFor('```py'));
  assert.ok(result, 'expected the source to offer something for ```py');
  assert.equal(result.from, 3, 'the replaced range starts just past the backticks');
  assert.equal(result.to, 5, 'and ends at the caret');
  assert.equal(result.filter, false, 'the catalogue already filtered by alias and keyword');
  assert.equal(result.options[0].label, 'python');
});

test('the CodeMirror source stays quiet on a closing fence', () => {
  // Enter belongs to the newline here; offering a language would let the popup
  // insert one into the closing fence and break the block.
  assert.equal(fenceLanguageComplete(contextFor('```py\nx = 1\n```')), null);
});

test('the CodeMirror source ignores backticks that are not a fence', () => {
  assert.equal(fenceLanguageComplete(contextFor('a ```')), null);
  assert.equal(fenceLanguageComplete(contextFor('``py')), null);
  assert.equal(fenceLanguageComplete(contextFor('```py ')), null);
});
