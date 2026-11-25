import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown, extractOutline } from './markdown.ts';
import { applyFormat } from './md-format.ts';
import {
  ALL_TOOLBAR_ITEMS,
  DEFAULT_TOOLBAR_ITEMS,
  normalizeToolbarItems,
} from './toolbar-items.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('v5.3.3 issue fixes (#620, #622, #626, #628, #629, #630, #631)', () => {
  it('#626: preview renders YAML frontmatter with formatted dates, tag chips, booleans, and collapsible details', () => {
    const md = [
      '---',
      'title: SoloMD Guide',
      'date: 2026-11-21',
      'published: true',
      'tags:',
      '  - markdown',
      '  - yaml',
      'url: https://solomd.app',
      '---',
      '',
      '# Body',
    ].join('\n');
    const html = renderMarkdown(md);
    assert.match(html, /<details class="md-frontmatter" open>/);
    assert.match(html, /md-frontmatter-date[^>]*>2026-11-21</);
    assert.match(html, /md-frontmatter-chip[^>]*>markdown</);
    assert.match(html, /md-frontmatter-chip[^>]*>yaml</);
    assert.match(html, /md-frontmatter-bool--true/);
    assert.match(html, /href="https:\/\/solomd\.app"/);
  });

  it('#622: normalizeToolbarItems preserves valid unique order and falls back to defaults', () => {
    assert.deepEqual(normalizeToolbarItems(null), DEFAULT_TOOLBAR_ITEMS);
    assert.deepEqual(
      normalizeToolbarItems(['newFile', 'gitAdd', 'gitPull', 'gitPush', 'invalid', 'gitAdd']),
      ['newFile', 'gitAdd', 'gitPull', 'gitPush'],
    );
    const ids = new Set(ALL_TOOLBAR_ITEMS.map((i) => i.id));
    for (const def of DEFAULT_TOOLBAR_ITEMS) {
      assert.ok(ids.has(def), `default item ${def} must exist in registry`);
    }
  });

  it('#630, #631 & #657: PaneTabBar has no data-tauri-drag-region and keeps clean bottom-accent active tab', () => {
    const tabBar = fs.readFileSync(path.join(root, 'components/PaneTabBar.vue'), 'utf8');
    assert.doesNotMatch(tabBar, /:data-tauri-drag-region=/);
    assert.match(tabBar, /\.tab--active\s*\{[\s\S]*?background:\s*transparent/);
    assert.match(tabBar, /\.tab--active::after\s*\{[\s\S]*?background:\s*var\(--accent\)/);
  });

  it('#628 & #629: FileTree guards refresh generation, keys recursive nodes, and exposes batch new files', () => {
    const tree = fs.readFileSync(path.join(root, 'components/FileTree.vue'), 'utf8');
    assert.match(tree, /let refreshGen = 0;/);
    assert.match(tree, /key:\s*c\.path/);
    assert.match(tree, /openBatchCreate\(/);
    assert.match(tree, /confirmBatchCreate/);
  });

  it('#635: highlight.js registers ahk (autohotkey), awk, bash, and lua grammars', async () => {
    const { createHljs } = await import('./hljs-setup.ts');
    const hljs = createHljs();
    for (const lang of ['ahk', 'autohotkey', 'awk', 'bash', 'lua']) {
      assert.ok(hljs.getLanguage(lang), `hljs must resolve ${lang}`);
    }
    const ahkOut = hljs.highlight('MsgBox, Hello\nreturn', { language: 'ahk' }).value;
    assert.match(ahkOut, /hljs-/);
    const awkOut = hljs.highlight('BEGIN { print $1 }', { language: 'awk' }).value;
    assert.match(awkOut, /hljs-/);
  });

  it('#634 / #643: AIRewriteOverlay persists up to 15 custom prompts without an extra bottom menu item', () => {
    const overlay = fs.readFileSync(path.join(root, 'components/AIRewriteOverlay.vue'), 'utf8');
    assert.match(overlay, /MAX_PROMPT_HISTORY\s*=\s*15/);
    assert.match(overlay, /:title="item"/);
    assert.doesNotMatch(overlay, /ai-overlay__history-bubble/);
    assert.match(overlay, /recordPromptHistory/);
  });

  it('#638: hljs-theme.css scopes .cm-line .hljs-* so CodeMirror monospace color cannot override hljs colors', () => {
    const css = fs.readFileSync(path.join(root, 'styles/hljs-theme.css'), 'utf8');
    assert.match(css, /\.cm-line\s+\.hljs-keyword/);
    assert.match(css, /\.cm-line\s+\.hljs-string/);
    assert.match(css, /\.cm-line\s+\.hljs-comment/);
  });

  it('#640: live list rendering separates leading indent from fixed-width marker and cycles per-level bullets', () => {
    const cm = fs.readFileSync(path.join(root, 'lib/cm-live-render.ts'), 'utf8');
    assert.match(cm, /BULLET_SYMBOLS\s*=\s*\['•',\s*'◦',\s*'▪'\]/);
    assert.match(cm, /cm-md-list-indent/);
  });

  it('#644: SettingsPanel closes before opening ToolbarCustomizeModal and Toolbar uses deferred Teleport', () => {
    const settings = fs.readFileSync(path.join(root, 'components/SettingsPanel.vue'), 'utf8');
    const toolbar = fs.readFileSync(path.join(root, 'components/Toolbar.vue'), 'utf8');
    assert.match(settings, /function openToolbarCustomize\(\)[\s\S]*?emit\('close'\)/);
    assert.match(toolbar, /<Teleport to="#titlebar-toolbar-slot" :disabled="!dockInTitlebar" defer>/);
  });

  it('#648: GlobalSearch matches YAML frontmatter tags on #tag / tag: queries', () => {
    const search = fs.readFileSync(path.join(root, 'components/GlobalSearch.vue'), 'utf8');
    assert.match(search, /q\.match\(\/\^\(\?:#\|tag:#\?\)/);
    assert.match(search, /wsIndex\.entries/);
  });

  it('code-review fixes: extractOutline ignores headings inside ~~~ tilde fences and 4-backtick outer fences', () => {
    const doc = [
      '# Real H1',
      '~~~bash',
      '# Not a heading inside tilde fence',
      '~~~',
      '````markdown',
      '```',
      '# Not a heading inside 4-backtick fence',
      '```',
      '````',
      '## Real H2',
    ].join('\n');
    const items = extractOutline(doc);
    assert.deepEqual(
      items.map((i) => ({ level: i.level, text: i.text })),
      [
        { level: 1, text: 'Real H1' },
        { level: 2, text: 'Real H2' },
      ],
    );
  });

  it('code-review fixes: applyFormat unwraps enclosing <u>/<sub>/<sup> when bare caret is inside CJK or multi-word text', () => {
    const doc = '前缀 <u>中文下划线内容</u> 后缀';
    const caret = doc.indexOf('下划线');
    const res = applyFormat(doc, caret, caret, 'underline');
    assert.ok(res);
    const out = doc.slice(0, res.from) + res.insert + doc.slice(res.to);
    assert.equal(out, '前缀 中文下划线内容 后缀');
  });

  it('code-review fixes: Icons.vue defines every icon referenced by ALL_TOOLBAR_ITEMS, SyncConflictModal loads immediately', () => {
    const iconsVue = fs.readFileSync(path.join(root, 'components/Icons.vue'), 'utf8');
    for (const item of ALL_TOOLBAR_ITEMS) {
      assert.ok(
        iconsVue.includes(`'${item.icon}'`),
        `Icons.vue must define icon "${item.icon}" for toolbar item "${item.id}"`,
      );
    }
    const syncModal = fs.readFileSync(path.join(root, 'components/SyncConflictModal.vue'), 'utf8');
    assert.match(syncModal, /immediate:\s*true/);
    assert.match(syncModal, /let diffSeq = 0;/);
  });
});

describe('v5.3.5 issue fixes (#649-#677)', () => {
  it('#660: hljsFallbackExtension wraps ViewPlugin in Prec.highest so hljs marks nest inside CM monospace spans', () => {
    const hljsFallback = fs.readFileSync(path.join(root, 'lib/cm-hljs-fallback.ts'), 'utf8');
    assert.match(hljsFallback, /Prec\.highest\(/);
  });

  it('#659: ai_proxy attaches OpenCode Go session and user-agent headers', () => {
    const aiProxy = fs.readFileSync(path.join(root, '../src-tauri/src/ai_proxy.rs'), 'utf8');
    assert.match(aiProxy, /fn with_provider_headers\(/);
    assert.match(aiProxy, /x-opencode-session/);
    assert.match(aiProxy, /opencode\/1\.0 SoloMD/);
  });

  it('#664: WebDAV categorizeFiles defaults to false and sync UI labels it accurately', () => {
    const settings = fs.readFileSync(path.join(root, 'stores/settings.ts'), 'utf8');
    const syncVue = fs.readFileSync(path.join(root, 'components/WebdavSyncSettings.vue'), 'utf8');
    assert.match(settings, /webdavCategorizeFiles:\s*false/);
    assert.doesNotMatch(syncVue, /'保持目录结构'/);
    assert.match(syncVue, /'根目录文件自动分类'/);
  });

  it('#667: openRenderedLink and openMarkdownHref dispatch solomd:anchor-goto for #hash links', () => {
    const linkOpen = fs.readFileSync(path.join(root, 'lib/link-open.ts'), 'utf8');
    const pane = fs.readFileSync(path.join(root, 'components/PaneContent.vue'), 'utf8');
    assert.match(linkOpen, /solomd:anchor-goto/);
    assert.match(pane, /onAnchorGotoEvent/);
  });

  it('#662: circled numerals font-face is declared top-level with unicode-range and spliced into font stacks', () => {
    const css = fs.readFileSync(path.join(root, 'styles/main.css'), 'utf8');
    const settings = fs.readFileSync(path.join(root, 'stores/settings.ts'), 'utf8');
    assert.match(css, /@font-face\s*\{\s*font-family:\s*["']SoloMD Circled["']/);
    assert.match(css, /unicode-range:\s*U\+2460-24FF/);
    assert.match(settings, /SoloMD Circled/);
  });

  it('#656: GlobalSearch clears prefill on close and dispatches solomd:clear-search-highlight', () => {
    const appVue = fs.readFileSync(path.join(root, 'App.vue'), 'utf8');
    const searchVue = fs.readFileSync(path.join(root, 'components/GlobalSearch.vue'), 'utf8');
    const editorVue = fs.readFileSync(path.join(root, 'components/Editor.vue'), 'utf8');
    assert.match(appVue, /function closeGlobalSearch\(\)/);
    assert.match(searchVue, /solomd:clear-search-highlight/);
    assert.match(editorVue, /solomd:clear-search-highlight/);
  });

  it('#652 & #650: Editor attaches cm-live-edit class and skips initial caret past YAML frontmatter', () => {
    const editorVue = fs.readFileSync(path.join(root, 'components/Editor.vue'), 'utf8');
    assert.match(editorVue, /class:\s*'cm-live-edit'/);
    assert.match(editorVue, /defaultStartAfterFrontmatter/);
  });

  it('#654 & #655: HTML live blocks reset white-space to normal with compact vertical padding', () => {
    const liveBlocks = fs.readFileSync(path.join(root, 'lib/cm-live-blocks.ts'), 'utf8');
    assert.match(liveBlocks, /'\.cm-live-block--html':\s*\{[\s\S]*?whiteSpace:\s*'normal'/);
    assert.match(liveBlocks, /'\.cm-live-block--html pre':\s*\{[\s\S]*?whiteSpace:\s*'pre-wrap'/);
  });

  it('#649: openFromDisk replaces disposable blank Untitled.md tab in-place', () => {
    const tabs = fs.readFileSync(path.join(root, 'stores/tabs.ts'), 'utf8');
    assert.match(tabs, /!t\.filePath && t\.content === '' && t\.savedContent === '' && !t\.pinned/);
  });

  it('#670 & #677: Windows titlebar keeps win-controls flex-shrink: 0 and SyncConflictModal confirms before destructive resolve', () => {
    const toolbar = fs.readFileSync(path.join(root, 'components/Toolbar.vue'), 'utf8');
    const syncModal = fs.readFileSync(path.join(root, 'components/SyncConflictModal.vue'), 'utf8');
    assert.match(toolbar, /\.win-controls\s*\{[\s\S]*?flex-shrink:\s*0/);
    assert.match(toolbar, /\.titlebar__toolbar-slot\s*\{[\s\S]*?min-width:\s*0/);
    assert.match(syncModal, /width="1120px"/);
    assert.match(syncModal, /tauriConfirm\(confirmMsg/);
  });
});

describe('v5.3.6 feedback: table drag-select, Mermaid zoom, non-MD highlighting & CPU optimization', () => {
  it('non-MD syntax highlighting resolves native CM grammars (.xml, .py, .json, .yaml) and hljs (.sh, .lua, .toml, Makefile)', async () => {
    const { codeLanguages } = await import('./code-languages.ts');
    const { LanguageDescription } = await import('@codemirror/language');
    const { resolveHljsLangForFile } = await import('./cm-hljs-fallback.ts');

    for (const f of ['config.xml', 'app.py', 'data.json', 'ci.yml', 'main.ts', 'index.html', 'style.css', 'lib.rs', 'query.sql']) {
      assert.ok(LanguageDescription.matchFilename(codeLanguages, f), `${f} should match a CodeMirror grammar`);
    }
    assert.equal(resolveHljsLangForFile('deploy.sh'), 'bash');
    assert.equal(resolveHljsLangForFile('init.lua'), 'lua');
    assert.equal(resolveHljsLangForFile('Cargo.toml'), 'ini');
    assert.equal(resolveHljsLangForFile('Makefile'), 'makefile');
    assert.equal(resolveHljsLangForFile('notes.txt'), null);
  });

  it('Live Edit MermaidWidget and Windows plain mermaid blocks wire openImageOverlay zoom button and dblclick', () => {
    const liveBlocks = fs.readFileSync(path.join(root, 'lib/cm-live-blocks.ts'), 'utf8');
    const editorVue = fs.readFileSync(path.join(root, 'components/Editor.vue'), 'utf8');
    assert.match(liveBlocks, /openMermaidZoomOverlay/);
    assert.match(liveBlocks, /cm-mermaid-zoom-btn/);
    assert.match(editorVue, /openImageOverlay/);
    assert.match(editorVue, /plain-mermaid-block/);
  });

  it('Live Edit tables support multi-cell/row rectangular drag selection, copy, and clear', () => {
    const liveBlocks = fs.readFileSync(path.join(root, 'lib/cm-live-blocks.ts'), 'utf8');
    assert.match(liveBlocks, /cm-live-table__cell--selected/);
    assert.match(liveBlocks, /applyCellRangeHighlight/);
    assert.match(liveBlocks, /document\.elementFromPoint/);
  });

  it('CPU hotpaths are guarded: hljs LRU cache, watcher coalescing & ignore list, intra-line selection skip, and tableSearchHighlighter short-circuit', () => {
    const hljsFallback = fs.readFileSync(path.join(root, 'lib/cm-hljs-fallback.ts'), 'utf8');
    const wsIndexRs = fs.readFileSync(path.join(root, '../src-tauri/src/workspace_index.rs'), 'utf8');
    const liveRender = fs.readFileSync(path.join(root, 'lib/cm-live-render.ts'), 'utf8');
    const liveBlocks = fs.readFileSync(path.join(root, 'lib/cm-live-blocks.ts'), 'utf8');
    const spell = fs.readFileSync(path.join(root, 'lib/cm-spellcheck.ts'), 'utf8');

    assert.match(hljsFallback, /cachedHljsSpans/);
    assert.match(hljsFallback, /MAX_AUTO_DETECT_CHARS/);
    assert.match(wsIndexRs, /WATCHER_FLUSH_RUNNING/);
    assert.match(wsIndexRs, /should_ignore_watch_path/);
    assert.match(liveRender, /prevFromLine === nextFromLine && prevToLine === nextToLine/);
    assert.match(liveBlocks, /private hadActiveQuery = false;/);
    assert.doesNotMatch(spell, /update\.geometryChanged/);
  });

  it('#678, #679, #682, #683, #684, #686, #687, #689, #690, #691: v5.3.6 bug & polish checks', async () => {
    const { buildPandocFromArg } = await import('./pandoc-markdown.ts');
    const { exportMediaAlignCss } = await import('./html-export.ts');

    // #683: Pandoc reader enables lists_without_preceding_blankline & disables blank_before_blockquote
    const fromArg = buildPandocFromArg(true);
    assert.match(fromArg, /\+lists_without_preceding_blankline/);
    assert.match(fromArg, /-blank_before_blockquote/);

    // #686: exportMediaAlignCss targets actual .mermaid-block / .plantuml-block / standalone img classes
    const centerCss = exportMediaAlignCss('center');
    assert.match(centerCss, /\.mermaid-block/);
    assert.match(centerCss, /justify-content:\s*center\s*!important/);
    assert.match(centerCss, /p:has\(> a:only-child > img:only-child\)/);

    // #682: git_history.rs uses chrono::Local::now() instead of UTC
    const gitHistRs = fs.readFileSync(path.join(root, '../src-tauri/src/git_history.rs'), 'utf8');
    assert.match(gitHistRs, /chrono::Local::now\(\)/);

    // #687 & #689: SyncConflictModal has fixed height, side-by-side split, and inline <<<<<<<< merge
    const syncModal = fs.readFileSync(path.join(root, 'components/SyncConflictModal.vue'), 'utf8');
    assert.match(syncModal, /height:\s*78vh;/);
    assert.match(syncModal, /scm__split/);
    assert.match(syncModal, /buildInlineDiffMerge/);
    assert.match(syncModal, /<<<<<<<</);

    // #690 & #691: docx-export detects template-numbered heading levels & supports firstLineIndent
    const docxExport = fs.readFileSync(path.join(root, 'lib/docx-export.ts'), 'utf8');
    assert.match(docxExport, /detectTemplateNumberedHeadingLevels/);
    assert.match(docxExport, /firstLineIndentTwipsForRun/);

    // #684: editorMediaAlign CSS vars wired in App.vue & settings.ts
    const appVue = fs.readFileSync(path.join(root, 'App.vue'), 'utf8');
    assert.match(appVue, /--media-align/);
    assert.match(appVue, /--media-justify/);
  });

  it('LaTeX $$ block + Enter + IME input: no overlapping live-render decorations inside math blocks, MathWidget is contentEditable=false, and plain-blocks keeps single-line $$ isolated', async () => {
    const { EditorState } = await import('@codemirror/state');
    const { markdown } = await import('@codemirror/lang-markdown');
    const { GFM } = await import('@lezer/markdown');
    const { buildDecorations } = await import('./cm-live-render.ts');
    const { splitPlainMarkdownBlocks } = await import('./plain-blocks.ts');

    const doc = [
      '最后联立方程',
      '$$',
      '\\begin{cases}',
      'Ax+By+C=0 \\\\',
      'Bx-Ay=Bx_0-Ay_0',
      '\\end{cases}',
      '$$',
      'j',
    ].join('\n');
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdown({ extensions: [GFM] })],
    });
    const fakeView = {
      state,
      visibleRanges: [{ from: 0, to: doc.length }],
    } as unknown as import('@codemirror/view').EditorView;

    const deco = buildDecorations(fakeView, false, false);
    const mathStart = doc.indexOf('$$');
    const mathEnd = doc.lastIndexOf('$$') + 2;
    const overlapping: Array<{ from: number; to: number }> = [];
    deco.between(mathStart, mathEnd, (from, to) => {
      overlapping.push({ from, to });
    });
    assert.deepEqual(
      overlapping,
      [],
      'cm-live-render must not emit overlapping Emphasis/Escape decorations inside $$...$$ blocks',
    );

    // MathWidget isolates KaTeX DOM from contentEditable/IME selection
    const liveBlocks = fs.readFileSync(path.join(root, 'lib/cm-live-blocks.ts'), 'utf8');
    assert.match(liveBlocks, /wrap\.contentEditable = 'false';/);
    assert.match(liveBlocks, /'\.cm-live-block--math':[\s\S]*?userSelect:\s*'none'/);

    // Plain-block editor keeps single-line $$...$$ as its own block so Enter + typing never merges
    const singleMathBlocks = splitPlainMarkdownBlocks('$$E=mc^2$$\nj');
    assert.equal(singleMathBlocks.length, 2);
    assert.equal(singleMathBlocks[0].text, '$$E=mc^2$$');
    assert.equal(singleMathBlocks[1].text, 'j');
  });

  it('v5.4.0 features (#651, #653, #665, #668, #671, #672, #673, #674, #675, #692): snippets, :::alert-*, VS Code preset, custom toolbar cmd:*, and settings sub-tabs', async () => {
    const { expandSnippet, pinSnippetToTop, extractFirstH1Title } = await import('./snippets.ts');
    const { renderMarkdown } = await import('./markdown.ts');
    const { VSCODE_PRESET, vscodePresetActive } = await import('./keybindings.ts');
    const { normalizeToolbarItems, defaultIconForCommand, commandCategoryOf } = await import('./toolbar-items.ts');

    // #653: Snippets variable expansion (%%, @@, ${filebase}, ${title}, ${filebaseprev}, ${filebasenext}, date/time)
    const fixedDate = new Date(2026, 10, 22, 9, 5, 3); // 2026-11-22 09:05:03 Sunday
    const exp = expandSnippet(
      '<div>${title}|${filebase}|${filebaseprev}|${filebasenext}|${date}|${time}|${ts}|${weekday}|${weekdaycn}|%%@@</div>',
      {
        selection: 'SELECTED',
        filebase: 'note-2',
        title: extractFirstH1Title('# First Heading\nbody'),
        filebaseprev: 'note-1',
        filebasenext: 'note-3',
        now: fixedDate,
      },
    );
    assert.equal(
      exp.text,
      '<div>First Heading|note-2|note-1|note-3|2026-11-22|09:05:03|20261122090503|Sunday|星期日|SELECTED</div>',
    );
    assert.equal(exp.cursorOffset, exp.text.indexOf('</div>'));

    const pinned = pinSnippetToTop(
      [
        { id: 'a', name: 'A', content: '1', updatedAt: 1 },
        { id: 'b', name: 'B', content: '2', updatedAt: 1 },
      ],
      'b',
    );
    assert.equal(pinned[0].id, 'b');

    // #653: :::alert-danger / :::alert-info container blocks render as .md-callout
    const alertHtml = renderMarkdown(':::alert-danger 警告\n危险内容\n:::');
    assert.match(alertHtml, /class="[^"]*md-callout md-callout--caution/);
    assert.match(alertHtml, /危险内容/);

    // #692: VS Code shortcut preset maps Ctrl/Cmd+Shift+P -> palette.open & Ctrl/Cmd+B -> fmt.bold
    assert.equal(VSCODE_PRESET['palette.open'], 'Mod+Shift+P');
    assert.equal(VSCODE_PRESET['fmt.bold'], 'Mod+B');
    assert.equal(vscodePresetActive(VSCODE_PRESET), true);
    assert.equal(vscodePresetActive({}), false);

    // #665: Toolbar items accept arbitrary `cmd:*` commands and derive categories + icons
    const items = normalizeToolbarItems(['viewMode', 'cmd:sync.webdavPush', 'cmd:export.html', 'invalid-id']);
    assert.deepEqual(items, ['viewMode', 'cmd:sync.webdavPush', 'cmd:export.html']);
    assert.equal(defaultIconForCommand('sync.webdavPush'), 'upload');
    assert.equal(commandCategoryOf('export.html'), 'export');

    // #668, #671, #673, #674, #651 source checks
    const settingsPanel = fs.readFileSync(path.join(root, 'components/SettingsPanel.vue'), 'utf8');
    assert.match(settingsPanel, /basicsBranches/);
    assert.match(settingsPanel, /data-active-basics/);
    assert.match(settingsPanel, /windowRestoreMode/);
    assert.match(settingsPanel, /settings\.deviceId/);

    const ghSync = fs.readFileSync(path.join(root, 'composables/useGithubSync.ts'), 'utf8');
    assert.match(ghSync, /addEventListener\('online'/);

    const integrationsRs = fs.readFileSync(path.join(root, '../src-tauri/src/integrations.rs'), 'utf8');
    assert.match(integrationsRs, /"codex"/);
    assert.match(integrationsRs, /"dsh"/);

    // TableWidget isolates contentEditable='false' & stops beforeinput/input propagation
    // so typing multiple English characters in a cell never collapses to 1 character.
    const liveBlocks = fs.readFileSync(path.join(root, 'lib/cm-live-blocks.ts'), 'utf8');
    assert.match(liveBlocks, /wrap\.className = 'cm-live-block cm-live-block--table';[\s\S]*?wrap\.contentEditable = 'false';/);
    assert.match(liveBlocks, /'beforeinput'[\s\S]*?'input'[\s\S]*?ev\.stopPropagation\(\)/);

    // #693: Windows CJK punctuation beforeinput interception prevents +1 char caret jump in （） and 登记|开闸
    const { shouldInterceptWindowsCjkPunctuation } = await import('./cm-ime-guard.ts');
    assert.equal(shouldInterceptWindowsCjkPunctuation(true, false, 'insertText', '、'), true);
    assert.equal(shouldInterceptWindowsCjkPunctuation(true, false, 'insertText', '，'), true);
    assert.equal(shouldInterceptWindowsCjkPunctuation(true, false, 'insertText', 'a'), false);
    assert.equal(shouldInterceptWindowsCjkPunctuation(true, true, 'insertText', '、'), false);
    assert.equal(shouldInterceptWindowsCjkPunctuation(false, false, 'insertText', '、'), false);

    // #694: Fine-tuned Basics sub-tabs in SettingsPanel.vue
    assert.match(settingsPanel, /data-basics="typography"[\s\S]{0,120}settings\.lineHeight/);
    assert.match(settingsPanel, /data-basics="typography"[\s\S]{0,120}settings\.paragraphSpacing/);
    assert.match(settingsPanel, /data-basics="typography"[\s\S]{0,160}docxFirstLineIndent/);
    assert.match(settingsPanel, /data-basics="editor"[\s\S]{0,200}highlightCurrentLine/);
    assert.match(settingsPanel, /data-basics="preview"[\s\S]{0,160}图片、图表、公式对齐方式/);
    assert.match(settingsPanel, /data-basics="navigation"[\s\S]{0,160}explorerDoubleClickFiles/);
    assert.match(settingsPanel, /data-basics="layout"[\s\S]{0,160}settings\.toolbarHidden/);
    assert.match(settingsPanel, /data-basics="appearance"[\s\S]{0,120}settings\.customCss/);

    // #695: Cloud Drive API & Local Cloud Folder sync commands registered under sync category
    const commandsSrc = fs.readFileSync(path.join(root, 'composables/useCommands.ts'), 'utf8');
    assert.match(commandsSrc, /id: 'sync\.cloudApiPush'/);
    assert.match(commandsSrc, /id: 'sync\.cloudApiPull'/);
    assert.match(commandsSrc, /id: 'sync\.cloudVaultPush'/);
    assert.match(commandsSrc, /id: 'sync\.cloudVaultPull'/);
    assert.equal(commandCategoryOf('sync.cloudApiPush'), 'sync');
    assert.equal(commandCategoryOf('sync.cloudVaultPull'), 'sync');

    // #696: Enlarged custom toolbar icon picker with colorful emojis & custom glyph helper
    const { TOOLBAR_ICON_OPTIONS, TOOLBAR_EMOJI_ICON_OPTIONS, isCustomGlyphIcon } = await import('./toolbar-items.ts');
    assert.ok(TOOLBAR_ICON_OPTIONS.length >= 35);
    assert.ok(TOOLBAR_EMOJI_ICON_OPTIONS.length >= 20);
    assert.equal(isCustomGlyphIcon('upload'), false);
    assert.equal(isCustomGlyphIcon('☁️'), true);

    // #697: Settings modal header shows muted Device ID label instead of bold raw UUID in title
    assert.match(settingsPanel, /settings-modal__device-id/);
    assert.match(settingsPanel, /设备ID：/);

    // #701: Startup routine pull covers all enabled sync backends & StatsPill tracks live sync progress
    assert.match(ghSync, /function scheduleStartupPull/);
    const statsPill = fs.readFileSync(path.join(root, 'components/StatsPill.vue'), 'utf8');
    assert.match(statsPill, /solomd:sync-progress/);
    assert.match(statsPill, /stats-pill__sync/);

    // #702: autoOpenSiblingFiles select sits in its own navigation <section> with label:first-child + select
    assert.match(
      settingsPanel,
      /<section data-cat="basics" data-basics="navigation">\s*<label>\{\{ settings\.language === 'zh' \? '打开文件时自动打开同目录其他文件'[\s\S]*?<\/label>\s*<select[\s\S]*?settings\.autoOpenSiblingFiles/,
    );
  });
});
