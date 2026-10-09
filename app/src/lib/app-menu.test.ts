import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { buildAppMenu, itemShortcut, toNativeSpec, type MenuContext, type MenuNode, type NativeNode, type TopMenu } from './app-menu.ts';
import { KEY_ACTIONS, typoraPreset } from './keybindings.ts';
import { en } from '../i18n/en.ts';
import { zh } from '../i18n/zh.ts';
import { ja } from '../i18n/ja.ts';
import { ko } from '../i18n/ko.ts';
import { de } from '../i18n/de.ts';
import { fr } from '../i18n/fr.ts';
import { es } from '../i18n/es.ts';
import { pt } from '../i18n/pt.ts';
import { it as itDict } from '../i18n/it.ts';
import { pl } from '../i18n/pl.ts';
import { nl } from '../i18n/nl.ts';
import { tr } from '../i18n/tr.ts';
import { sv } from '../i18n/sv.ts';
import { uk } from '../i18n/uk.ts';
import { ru } from '../i18n/ru.ts';

const DICTS: Record<string, unknown> = { en, zh, ja, ko, de, fr, es, pt, it: itDict, pl, nl, tr, sv, uk, ru };

/** A `t` that fails loudly on a key the locale does not have. */
function strictT(dict: unknown, lang: string) {
  return (key: string, params?: Record<string, string | number>) => {
    let cur: any = dict;
    for (const p of key.split('.')) cur = cur?.[p];
    if (typeof cur !== 'string') throw new Error(`${lang}: missing ${key}`);
    if (params) for (const [k, v] of Object.entries(params)) cur = cur.replaceAll(`{${k}}`, String(v));
    return cur;
  };
}

function ctx(over: Partial<MenuContext> = {}): MenuContext {
  return {
    t: strictT(en, 'en'),
    overrides: {},
    platform: 'windows',
    macKeys: false,
    recent: ['/notes/a.md', 'C:\\notes\\b.md'],
    themes: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
    state: {
      autoSave: false, viewMode: 'edit', focusMode: true, typewriter: false, spellCheck: true,
      livePreview: true, fitWidth: false, dark: false, theme: 'light',
      wordWrap: true, lineNumbers: false, autoGit: false,
      panes: {
        outline: true, inspector: false, backlinks: true, relationships: false, neighborhood: false,
        tags: false, tasks: true, types: false, history: false, savedViews: false, agent: false,
      },
    },
    aiAvailable: true,
    updateCheckAvailable: true,
    gitAvailable: true,
    ...over,
  };
}

function walk(nodes: MenuNode[], out: MenuNode[] = []): MenuNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.type === 'submenu') walk(n.items, out);
  }
  return out;
}
const ids = (menus: TopMenu[]) =>
  menus.flatMap((m) => walk(m.items)).filter((n) => n.type === 'item').map((n) => (n as { id: string }).id);
const find = (menus: TopMenu[], id: string) =>
  menus.flatMap((m) => walk(m.items)).find((n) => n.type === 'item' && n.id === id) as Extract<MenuNode, { type: 'item' }>;

/** Palette commands (useCommands) the menus added for coverage. */
const PALETTE_MENU_IDS = [
  // File
  'capture.quick', 'daily.openYesterday', 'daily.openTomorrow', 'image.uploadLocalImages',
  'export.epub', 'export.odt', 'export.latex', 'export.rtf', 'export.pandocCustom',
  'export.copyPlain', 'export.copyImage', 'inbox.open', 'inbox.organizeAndAdvance',
  'sync.pullNow', 'sync.pushNow', 'sync.copyShareLink', 'note.copyGitUrl',
  'history.commitNow', 'history.initWorkspace', 'history.toggleAutoGit',
  // Edit
  'editor.caseUpper', 'editor.caseLower', 'editor.caseTitle', 'cn.s2t', 'cn.t2s', 'cn.copyPinyin',
  'clean.stripMarkdown',
  // Navigate
  'tile.closePane', 'bases.open', 'views.create', 'type.create', 'tags.refresh',
  // View
  'view.toggleBacklinks', 'view.relationships', 'view.toggleNeighborhood', 'view.toggleTagsPanel',
  'view.toggleTasksPanel', 'view.toggleTypesPanel', 'view.toggleHistoryPanel', 'views.toggle',
  'view.toggleAgentPanel', 'view.resetSidebarPanes', 'view.toggleWrap', 'view.toggleLineNumbers',
  'theme.customCss', 'theme.clearCustomCss',
  'fold.level1', 'fold.level2', 'fold.level3', 'fold.level4', 'fold.level5', 'fold.level6',
  // Help
  'help.welcomeTour',
];

/** The submenu (any depth) with this id. */
function submenu(menus: TopMenu[], id: string) {
  return menus.flatMap((m) => walk(m.items)).find((n) => n.type === 'submenu' && n.id === id) as
    Extract<MenuNode, { type: 'submenu' }> | undefined;
}
const itemIds = (nodes: MenuNode[]) => nodes.filter((n) => n.type === 'item').map((n) => (n as { id: string }).id);

test('C1: seven top-level menus, no Tools menu', () => {
  const m = buildAppMenu(ctx());
  assert.deepEqual(m.map((x) => x.id), ['file', 'edit', 'paragraph', 'format', 'navigate', 'view', 'help']);
  assert.deepEqual(m.map((x) => x.label), ['File', 'Edit', 'Paragraph', 'Format', 'Go', 'View', 'Help']);
});

test('macOS keeps its app menu and Window menu around the seven', () => {
  const m = buildAppMenu(ctx({ platform: 'mac', macKeys: true }));
  assert.deepEqual(m.map((x) => x.id), ['app', 'file', 'edit', 'paragraph', 'format', 'navigate', 'view', 'window', 'help']);
  const file = ids([m[1]]);
  assert.ok(!file.includes('settings.open'), 'Settings lives in the app menu on macOS');
  assert.ok(!file.includes('file.exit'), 'Quit lives in the app menu on macOS');
  assert.ok(ids([m[0]]).includes('settings.open'));
});

test('C1 section 四 / 六 / Part-1 commands all have a menu entry', () => {
  const all = new Set(ids(buildAppMenu(ctx())));
  const required = [
    // File
    'file.new', 'file.newText', 'file.newInFolder', 'window.new', 'file.open', 'file.openFolder',
    'daily.openToday', 'file.save', 'file.saveAs', 'file.autoSave', 'file.import', 'export.html',
    'export.docx', 'export.pdfPrint', 'export.pdf', 'export.image', 'export.copyHtml', 'export.copyMd',
    'inbox.toggle', 'file.openExternal', 'settings.open', 'file.closeTab', 'tab.reopenClosed', 'file.exit',
    // Edit
    'edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll', 'editor.caseCycle',
    'editor.selectWord', 'editor.deleteWord', 'editor.selectLine', 'editor.jumpToSelection',
    'editor.aiRewrite', 'clean.aiArtifacts', 'proofread.cjk', 'format.markdown',
    // Paragraph
    'fmt.h1', 'fmt.h2', 'fmt.h3', 'fmt.h4', 'fmt.h5', 'fmt.h6', 'heading.promote', 'heading.demote',
    'heading.paragraph', 'fmt.ul', 'fmt.ol', 'fmt.task', 'fmt.quote', 'fmt.codeblock',
    'editor.tableEditor', 'editor.formulaEditor', 'insert.mathBlock', 'insert.mermaid', 'insert.table', 'insert.hr',
    // Format
    'fmt.bold', 'fmt.italic', 'fmt.strike', 'fmt.code', 'insert.mathInline', 'fmt.link',
    'editor.insertImage', 'editor.insertImageUrl',
    // Navigate
    'palette.open', 'quickSwitcher.open', 'search.global', 'edit.find', 'tab.prev', 'tab.next',
    'tile.splitRight', 'tile.splitDown', 'tile.focusNext', 'tile.focusPrev',
    // View
    'view.mode:edit', 'view.mode:split', 'view.mode:liveEdit', 'view.mode:preview', 'view.mode:reading',
    'view.toggleLiveEdit', 'view.cycleView', 'view.slideshow', 'view.toggleFileTree',
    'view.toggleRightSidebar', 'view.toggleOutline', 'view.toggleInspector', 'view.toggleToolbar',
    'fold.toggle', 'fold.all', 'fold.none', 'view.toggleFocusMode', 'view.toggleTypewriter',
    'pomodoro.startLast', 'pomodoro.open', 'view.toggleSpellCheck', 'view.toggleLivePreview',
    'view.toggleFitWidth', 'view.darkMode', 'theme.set:light', 'view.zoomUiIn', 'view.zoomEditorIn', 'view.zoomPreviewIn',
    // Help
    'help.markdown', 'help.shortcuts', 'help.cli', 'help.checkUpdate', 'help.about',
  ];
  for (const id of required) assert.ok(all.has(id), `missing ${id}`);
});

test('every menu id is something App.vue can dispatch', () => {
  const actionIds = new Set(KEY_ACTIONS.map((a) => a.id));
  // Handled by name in dispatchMenuAction, or a palette command (useCommands).
  const menuOnly = new Set([
    'file.openFolder', 'file.autoSave', 'recent.clear', 'recent.none', 'view.darkMode',
    'view.zoomPreviewIn', 'view.zoomPreviewOut', 'view.zoomPreviewReset', 'help.shortcuts', 'help.cli',
    'help.checkUpdate', 'help.about', 'edit.find', 'edit.replace', 'edit.undo', 'edit.redo', 'edit.cut', 'edit.copy',
    'edit.paste', 'edit.selectAll', 'insert.mathBlock', 'insert.mathInline', 'insert.table',
    'insert.mermaid', 'insert.hr',
    // palette commands
    'export.html', 'export.docx', 'export.pdf', 'export.image', 'clean.aiArtifacts',
    'view.toggleSpellCheck', 'view.toggleLivePreview', 'view.toggleFitWidth', 'pomodoro.open',
    'editor.insertImage', 'editor.insertImageUrl',
    // palette commands reached through the dispatchMenuAction fallback
    ...PALETTE_MENU_IDS,
  ]);
  for (const platform of ['windows', 'mac', 'linux'] as const) {
    for (const id of ids(buildAppMenu(ctx({ platform })))) {
      const ok = actionIds.has(id) || menuOnly.has(id) || /^(recent\.open|view\.mode|theme\.set):/.test(id);
      assert.ok(ok, `${platform}: nothing dispatches ${id}`);
    }
  }
});

test('labels exist in all 15 locales', () => {
  for (const [lang, dict] of Object.entries(DICTS)) {
    for (const platform of ['windows', 'mac', 'linux'] as const) {
      assert.doesNotThrow(() => buildAppMenu(ctx({ t: strictT(dict, lang), platform })), `${lang}/${platform}`);
    }
  }
});

test('menus show the binding in effect, not the factory default', () => {
  const c = ctx();
  const m = buildAppMenu(c);
  assert.equal(itemShortcut(find(m, 'fmt.bold'), c), 'Ctrl+Shift+B');
  assert.equal(itemShortcut(find(m, 'view.toggleFileTree'), c), 'Ctrl+B');
  assert.equal(itemShortcut(find(m, 'heading.promote'), c), '');
  const p = { ...c, overrides: typoraPreset('windows') };
  assert.equal(itemShortcut(find(m, 'fmt.bold'), p), 'Ctrl+B');
  assert.equal(itemShortcut(find(m, 'view.toggleFileTree'), p), 'Ctrl+Shift+B');
  assert.equal(itemShortcut(find(m, 'heading.promote'), p), 'Ctrl+=');
  assert.equal(itemShortcut(find(m, 'view.zoomUiIn'), p), '', 'UI zoom keeps its entry, loses its chord');
  assert.equal(itemShortcut(find(m, 'search.global'), p), 'Ctrl+Alt+F');
  // A single rebind is reflected too.
  assert.equal(itemShortcut(find(m, 'file.save'), { ...c, overrides: { 'file.save': 'Mod+Alt+9' } }), 'Ctrl+Alt+9');
  // The Windows edit keys are fixed; the reading item shows its toggle chord.
  assert.equal(itemShortcut(find(m, 'edit.undo'), c), 'Ctrl+Z');
  assert.equal(itemShortcut(find(m, 'view.mode:reading'), c), 'Ctrl+Shift+R');
});

test('check marks follow state', () => {
  const m = buildAppMenu(ctx());
  assert.equal(find(m, 'view.toggleFocusMode').checked, true);
  assert.equal(find(m, 'view.toggleTypewriter').checked, false);
  assert.equal(find(m, 'view.mode:edit').checked, true);
  assert.equal(find(m, 'view.mode:split').checked, false);
  assert.equal(find(m, 'theme.set:light').checked, true);
});

test('recent files: basenames, clear, and a disabled placeholder when empty', () => {
  const m = buildAppMenu(ctx());
  assert.equal(find(m, 'recent.open:1').label, 'b.md');
  assert.ok(find(m, 'recent.clear'));
  const empty = buildAppMenu(ctx({ recent: [] }));
  assert.equal(find(empty, 'recent.none').enabled, false);
});

function nativeWalk(nodes: NativeNode[], out: NativeNode[] = []): NativeNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.kind === 'submenu') nativeWalk(n.items, out);
  }
  return out;
}
const nativeAccel = (spec: ReturnType<typeof toNativeSpec>, id: string) => {
  const n = spec.flatMap((m) => nativeWalk(m.items)).find((x) => (x.kind === 'item' || x.kind === 'check') && x.id === id);
  return n && (n.kind === 'item' || n.kind === 'check') ? n.accelerator : 'MISSING';
};

test('native spec: accelerators are the live bindings, each claimed once', () => {
  const c = ctx({ platform: 'mac', macKeys: true });
  const spec = toNativeSpec(buildAppMenu(c), c);
  assert.equal(nativeAccel(spec, 'fmt.bold'), 'CmdOrCtrl+Shift+B');
  assert.equal(nativeAccel(spec, 'view.zoomUiIn'), 'CmdOrCtrl+Equal');
  assert.equal(nativeAccel(spec, 'heading.promote'), undefined);
  assert.equal(nativeAccel(spec, 'edit.find'), undefined, '⌘F must reach the focused find');
  assert.equal(nativeAccel(spec, 'view.zoomPreviewIn'), 'CmdOrCtrl+Control+=');
  const preset = { ...c, overrides: typoraPreset('mac') };
  const spec2 = toNativeSpec(buildAppMenu(preset), preset);
  assert.equal(nativeAccel(spec2, 'fmt.bold'), 'CmdOrCtrl+B');
  assert.equal(nativeAccel(spec2, 'view.toggleFileTree'), 'CmdOrCtrl+Shift+B');
  assert.equal(nativeAccel(spec2, 'heading.promote'), 'CmdOrCtrl+Equal');
  assert.equal(nativeAccel(spec2, 'view.zoomUiIn'), undefined, 'unbound → no accelerator left behind');
  for (const s of [spec, spec2]) {
    const accels = s.flatMap((m) => nativeWalk(m.items))
      .map((n) => (n.kind === 'item' || n.kind === 'check' ? n.accelerator : undefined))
      .filter(Boolean);
    assert.equal(new Set(accels).size, accels.length, 'no accelerator on two items');
  }
});

test('native spec never steals the OS edit chords', () => {
  const c = ctx({ platform: 'mac', macKeys: true });
  // ⌘⇧Z is redo on macOS; pomodoro.startLast ships on it.
  const spec = toNativeSpec(buildAppMenu(c), c);
  assert.equal(nativeAccel(spec, 'pomodoro.startLast'), undefined);
  const edit = spec.find((m) => m.text === 'Edit')!;
  assert.ok(edit.items.some((n) => n.kind === 'predefined' && n.role === 'redo'));
});

test('menu coverage: every palette feature has a menu home, on every platform', () => {
  for (const platform of ['windows', 'mac', 'linux'] as const) {
    const menus = buildAppMenu(ctx({ platform, macKeys: platform === 'mac' }));
    const all = new Set(ids(menus));
    for (const id of PALETTE_MENU_IDS) assert.ok(all.has(id), `${platform}: missing ${id}`);
    // Still the seven (plus app / Window on macOS).
    assert.equal(menus.filter((m) => !['app', 'window'].includes(m.id)).length, 7);
    // No id appears twice in one menu bar.
    const list = ids(menus);
    assert.equal(new Set(list).size, list.length, `${platform}: duplicate menu ids`);
  }
});

test('menu coverage: the new submenus hold what they should', () => {
  const m = buildAppMenu(ctx());
  assert.deepEqual(itemIds(submenu(m, 'daily')!.items), ['daily.openToday', 'daily.openYesterday', 'daily.openTomorrow']);
  assert.deepEqual(itemIds(submenu(m, 'inbox')!.items), ['inbox.open', 'inbox.toggle', 'inbox.organizeAndAdvance']);
  assert.deepEqual(itemIds(submenu(m, 'case')!.items), ['editor.caseCycle', 'editor.caseUpper', 'editor.caseLower', 'editor.caseTitle']);
  assert.deepEqual(itemIds(submenu(m, 'chinese')!.items), ['proofread.cjk', 'cn.s2t', 'cn.t2s', 'cn.copyPinyin']);
  const panes = itemIds(submenu(m, 'panes')!.items);
  assert.ok(panes.includes('view.toggleOutline') && panes.includes('view.toggleInspector'));
  assert.equal(panes.at(-1), 'view.resetSidebarPanes');
  assert.ok(itemIds(submenu(m, 'theme')!.items).includes('theme.customCss'));
  // Shortcuts survive the move into submenus.
  assert.equal(itemShortcut(find(m, 'daily.openToday'), ctx()), 'Ctrl+D');
  assert.equal(itemShortcut(find(m, 'inbox.toggle'), ctx()), 'Ctrl+E');
  assert.equal(itemShortcut(find(m, 'view.toggleInspector'), ctx()), 'Ctrl+Shift+I');
  assert.equal(find(m, 'fold.level2').label, 'Show Down to Level 2');
});

test('menu coverage: pane / wrap / line-number / auto-commit check marks follow state', () => {
  const m = buildAppMenu(ctx());
  assert.equal(find(m, 'view.toggleOutline').checked, true);
  assert.equal(find(m, 'view.toggleInspector').checked, false);
  assert.equal(find(m, 'view.toggleBacklinks').checked, true);
  assert.equal(find(m, 'view.toggleTasksPanel').checked, true);
  assert.equal(find(m, 'view.toggleWrap').checked, true);
  assert.equal(find(m, 'view.toggleLineNumbers').checked, false);
  assert.equal(find(m, 'history.toggleAutoGit').checked, false);
  // Actions (not toggles) carry no check mark.
  assert.equal(find(m, 'view.resetSidebarPanes').checked, undefined);
});

test('menu coverage: AI and git entries follow their availability flags', () => {
  const store = ids(buildAppMenu(ctx({ aiAvailable: false })));
  assert.ok(!store.includes('view.toggleAgentPanel'), 'App Store builds have no AI panel');
  assert.ok(!store.includes('editor.aiRewrite'));
  const android = buildAppMenu(ctx({ gitAvailable: false }));
  assert.equal(submenu(android, 'syncHistory'), undefined, 'no git backend → no 同步与历史');
  assert.ok(!ids(android).some((id) => id.startsWith('sync.') || id.startsWith('history.')));
  assert.ok(submenu(buildAppMenu(ctx()), 'syncHistory'));
});

test('menu coverage: every fallback id really is a palette command (useCommands.ts)', () => {
  // useCommands needs Pinia + Tauri, so read its source: each id must be
  // declared there, or dispatchMenuAction's palette fallback finds nothing.
  const src = readFileSync(new URL('../composables/useCommands.ts', import.meta.url), 'utf8');
  for (const id of PALETTE_MENU_IDS) {
    const declared = src.includes(`id: '${id}'`) || (/^fold\.level[1-6]$/.test(id) && src.includes('id: `fold.level${level}`'));
    assert.ok(declared, `${id} is not a command in useCommands.ts`);
  }
});

test('Linux: Undo/Redo are ordinary items (muda has no predefined undo/redo on GTK)', () => {
  const c = ctx({ platform: 'linux' });
  const spec = toNativeSpec(buildAppMenu(c), c);
  const edit = spec.find((m) => m.text === 'Edit')!;
  const kinds = edit.items.slice(0, 2).map((n) => (n.kind === 'item' ? n.id : n.kind));
  assert.deepEqual(kinds, ['edit.undo', 'edit.redo']);
  // No GTK accelerator: it would swallow Ctrl+Z before the webview's editor.
  assert.equal(nativeAccel(spec, 'edit.undo'), undefined);
  assert.equal(nativeAccel(spec, 'edit.redo'), undefined);
  // Cut/Copy/Paste/Select All stay the OS items, which GTK does support.
  assert.ok(edit.items.some((n) => n.kind === 'predefined' && n.role === 'copy'));
  // macOS keeps the predefined undo/redo.
  const mac = toNativeSpec(buildAppMenu(ctx({ platform: 'mac', macKeys: true })), c);
  const macEdit = mac.find((m) => m.text === 'Edit')!;
  assert.ok(macEdit.items.some((n) => n.kind === 'predefined' && n.role === 'undo'));
});

test('native spec escapes & so muda does not eat it as a mnemonic', () => {
  for (const [lang, dict] of Object.entries(DICTS)) {
    const c = ctx({ t: strictT(dict, lang), platform: 'linux' });
    const menus = buildAppMenu(c);
    const spec = toNativeSpec(menus, c);
    const sync = spec.flatMap((m) => nativeWalk(m.items)).find(
      (n) => n.kind === 'submenu' && n.items.some((x) => x.kind === 'item' && x.id === 'sync.pullNow'),
    );
    assert.ok(sync && sync.kind === 'submenu', lang);
    const label = submenu(menus, 'syncHistory')!.label;
    assert.equal(sync.text, label.replace(/&/g, '&&'), lang);
    // muda turns `&&` back into one literal `&`.
    assert.equal(sync.text.replace(/&&/g, '&'), label, lang);
  }
  const en = buildAppMenu(ctx({ platform: 'linux' }));
  assert.equal(submenu(en, 'syncHistory')!.label, 'Sync & History', 'the in-app label stays unescaped');
});
