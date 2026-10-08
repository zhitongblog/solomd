import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interceptedBindings, HOTKEY_INTERCEPTIONS, activeKeyActions } from './keybindings.ts';

test('the AMD/IME clashes are only reported on Windows', () => {
  assert.equal(interceptedBindings({}, 'mac').length, 0);
  assert.equal(interceptedBindings({}, 'linux').length, 0);
  assert.ok(interceptedBindings({}, 'windows').length >= 8);
});

test('every listed chord belongs to an action that ships with it', () => {
  const defaults = new Set(activeKeyActions('windows').flatMap((a) => a.defaults));
  for (const h of HOTKEY_INTERCEPTIONS) {
    assert.ok(defaults.has(h.combo), `${h.combo} is not a default of any action`);
  }
});

test('no alternative lands on a chord another action already owns', () => {
  const owners = new Map<string, string>();
  for (const a of activeKeyActions('windows')) for (const c of a.defaults) owners.set(c, a.id);
  for (const b of interceptedBindings({}, 'windows')) {
    const owner = owners.get(b.alternative);
    assert.ok(!owner || owner === b.action.id, `${b.alternative} is taken by ${owner}`);
  }
});

test('a binding the user already moved is left alone', () => {
  const before = interceptedBindings({}, 'windows').map((b) => b.action.id);
  assert.ok(before.includes('file.import'));
  const after = interceptedBindings({ 'file.import': 'Mod+Alt+Shift+L' }, 'windows').map(
    (b) => b.action.id,
  );
  assert.ok(!after.includes('file.import'));
});

test('an unbound action is not reported', () => {
  const after = interceptedBindings({ 'view.toggleReading': null }, 'windows').map(
    (b) => b.action.id,
  );
  assert.ok(!after.includes('view.toggleReading'));
});

test('the preset would leave nothing intercepted', () => {
  const overrides: Record<string, string> = {};
  for (const b of interceptedBindings({}, 'windows')) overrides[b.action.id] = b.alternative;
  assert.deepEqual(interceptedBindings(overrides, 'windows'), []);
});

test('search: a chord query matches the chord, not the letters in it', async () => {
  const { filterKeyActions, KEY_ACTIONS } = await import('./keybindings.ts');
  const ids = (q: string) => filterKeyActions(KEY_ACTIONS, q, (a) => a.label).map((a) => a.id);
  assert.deepEqual(ids('ctrl shift k'), ['palette.open']);
  assert.deepEqual(ids('⌘⇧K'), ['palette.open']);
  assert.deepEqual(ids('cmd+k'), ['fmt.link']);
  assert.deepEqual(ids('ctrl \\'), ['tile.splitRight']);
  assert.ok(ids('bold').includes('fmt.bold'));
  assert.ok(ids('heading').length >= 6);
});

test('an IME-processed chord (key "Process") is read from the physical key', async () => {
  const { eventToCombo } = await import('./keybindings.ts');
  const ev = (init: Partial<KeyboardEvent>) =>
    ({ key: 'Process', code: '', keyCode: 229, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;
  assert.equal(eventToCombo(ev({ code: 'Comma', ctrlKey: true })), 'Mod+Comma');
  assert.equal(eventToCombo(ev({ code: 'KeyB', ctrlKey: true, shiftKey: true })), 'Mod+Shift+B');
  assert.equal(eventToCombo(ev({ code: 'Digit4', ctrlKey: true })), 'Mod+4');
  // Without Ctrl/⌘ it is text being composed, not a chord.
  assert.equal(eventToCombo(ev({ code: 'KeyB' })), 'Process');
});

test('factory defaults have no chord bound twice, on any platform', async () => {
  const { activeKeyActions, normalizeCombo } = await import('./keybindings.ts');
  for (const platform of ['mac', 'windows', 'linux'] as const) {
    const seen = new Map<string, string>();
    for (const a of activeKeyActions(platform)) {
      for (const c of a.defaults.map(normalizeCombo)) {
        assert.ok(!seen.has(c), `${platform}: ${c} is both ${seen.get(c)} and ${a.id}`);
        seen.set(c, a.id);
      }
    }
  }
});

test('B4 new commands ship bound only where the chord was free', async () => {
  const { KEY_ACTIONS } = await import('./keybindings.ts');
  const d = (id: string) => KEY_ACTIONS.find((a) => a.id === id)?.defaults;
  assert.deepEqual(d('editor.selectWord'), []); // Mod+D is the daily note
  assert.deepEqual(d('heading.promote'), []); // Mod+= zooms the UI
  assert.deepEqual(d('heading.demote'), []);
  assert.deepEqual(d('heading.paragraph'), []);
  assert.deepEqual(d('editor.deleteWord'), ['Mod+Shift+D']);
  assert.deepEqual(d('editor.selectLine'), ['Mod+L']);
  assert.deepEqual(d('editor.jumpToSelection'), ['Mod+Alt+J']);
  assert.deepEqual(d('tab.reopenClosed'), ['Mod+Shift+T']);
  assert.deepEqual(d('view.toggleFocusMode'), ['F8']);
  assert.deepEqual(d('view.toggleTypewriter'), ['F9']);
  // The pre-B4 factory chords are untouched.
  assert.deepEqual(d('fmt.bold'), ['Mod+Shift+B']);
  assert.deepEqual(d('view.toggleFileTree'), ['Mod+B']);
  assert.deepEqual(d('daily.openToday'), ['Mod+D']);
  assert.deepEqual(d('view.zoomUiIn'), ['Mod+Equal']);
});

test('Typora / Word preset: all 28 B4 changes on Windows, conflict-free', async () => {
  const { typoraPreset, resolveBindings, normalizeCombo, presetActive, combosFor } = await import('./keybindings.ts');
  const preset = typoraPreset('windows');
  assert.equal(Object.keys(preset).length, 28);
  assert.equal(presetActive(preset, {}, 'windows'), false);
  const map = resolveBindings(preset, 'windows');
  for (const [id, value] of Object.entries(preset)) {
    const want = value === null ? [] : (Array.isArray(value) ? value : [value as string]).map(normalizeCombo);
    for (const c of want) assert.equal(map.get(c), id, `${c} should run ${id}, runs ${map.get(c)}`);
    assert.deepEqual(combosFor(id, preset, 'windows'), want);
  }
  assert.equal(presetActive(preset, preset, 'windows'), true);
  // Spot checks against B4 section 八.
  assert.equal(map.get('Mod+B'), 'fmt.bold');
  assert.equal(map.get('Mod+Shift+B'), 'view.toggleFileTree');
  assert.equal(map.get('Mod+Slash'), 'view.toggleLiveEdit');
  assert.equal(map.get('Mod+Alt+Slash'), 'view.toggleLiveEdit');
  assert.equal(map.get('F1'), 'help.markdown');
  assert.equal(map.get('Mod+0'), 'heading.paragraph');
  assert.equal(map.get('F7'), 'proofread.cjk');
  assert.equal(map.get('Mod+P'), 'quickSwitcher.open'); // B4: unchanged
});

test('Typora / Word preset clears every AMD / IME interception', async () => {
  const { typoraPreset, interceptedBindings } = await import('./keybindings.ts');
  assert.deepEqual(interceptedBindings(typoraPreset('windows'), 'windows'), []);
});

test('Typora / Word preset on macOS steps around the chords macOS owns', async () => {
  const { typoraPreset, TYPORA_PRESET } = await import('./keybindings.ts');
  const mac = typoraPreset('mac');
  assert.ok(!('export.copyHtml' in mac), '⌘⌥H is Hide Others');
  // ⌘⌥D is Dock hiding, but the preset gives ⌘D to "select word", so the
  // daily note must still move — to ⌘⌥Y.
  assert.equal(mac['daily.openToday'], 'Mod+Alt+Y');
  assert.equal(typoraPreset('windows')['daily.openToday'], 'Mod+Alt+D');
  assert.equal(mac['file.import'], 'Mod+Alt+Shift+L');
  // ⌥⌘F is Replace on a Mac: search-in-folder keeps ⌘⇧F there.
  assert.ok(!('search.global' in mac));
  assert.equal(typoraPreset('windows')['search.global'], 'Mod+Alt+F');
  assert.equal(Object.keys(mac).length, Object.keys(TYPORA_PRESET).length - 2);
});

test('the Typora / Word preset never creates a conflict on any platform', async () => {
  const { typoraPreset, activeKeyActions, combosFor } = await import('./keybindings.ts');
  for (const platform of ['windows', 'mac', 'linux'] as const) {
    const preset = typoraPreset(platform);
    const owners = new Map<string, string>();
    for (const a of activeKeyActions(platform)) {
      for (const c of combosFor(a.id, preset, platform)) {
        assert.ok(!owners.has(c), `${platform}: ${c} on both ${owners.get(c)} and ${a.id}`);
        owners.set(c, a.id);
      }
    }
  }
});

test('Replace is ⌃H off the Mac and ⌥⌘F on it; menus and Settings share one table', async () => {
  const { combosFor, activeKeyActions, KEY_CATEGORIES } = await import('./keybindings.ts');
  assert.deepEqual(combosFor('editor.replace', {}, 'windows'), ['Mod+H']);
  assert.deepEqual(combosFor('editor.replace', {}, 'mac'), ['Mod+Alt+F']);
  assert.deepEqual(combosFor('file.openFolder', {}, 'windows'), ['Mod+Alt+Shift+O']);
  for (const platform of ['windows', 'mac', 'linux'] as const) {
    const actions = activeKeyActions(platform);
    assert.equal(new Set(actions.map((a) => a.id)).size, actions.length, `${platform}: one entry per id`);
    for (const a of actions) assert.ok((KEY_CATEGORIES as readonly string[]).includes(a.category), a.id);
  }
});

test('the preset never takes a key the user gave to another command', async () => {
  const { typoraPreset, planPreset } = await import('./keybindings.ts');
  const preset = typoraPreset('windows');
  const mine = { 'view.zoomEditorIn': 'Mod+Equal' };
  const { apply, skipped } = planPreset(preset, mine, 'windows');
  assert.deepEqual(skipped, ['heading.promote']);
  assert.ok(!('heading.promote' in apply));
  assert.equal(Object.keys(apply).length, 27);
  assert.deepEqual(planPreset(preset, {}, 'windows').skipped, []);
});

test('an app-bound chord is taken out of the CodeMirror keymap', async () => {
  const { cmKeyOwnedByApp, typoraPreset } = await import('./keybindings.ts');
  // ⌘⇧K opens the palette — CodeMirror must not also delete the line.
  assert.equal(cmKeyOwnedByApp({ key: 'Shift-Mod-k' }, {}, 'windows'), true);
  assert.equal(cmKeyOwnedByApp({ key: 'Mod-d' }, typoraPreset('windows'), 'windows'), true);
  assert.equal(cmKeyOwnedByApp({ key: 'Mod-z' }, {}, 'windows'), false);
  // Emacs-style Ctrl keys exist only on macOS, where Mod is ⌘, not Ctrl.
  assert.equal(cmKeyOwnedByApp({ mac: 'Ctrl-d' }, {}, 'mac'), false);
  // Unbinding gives the chord back to CodeMirror.
  assert.equal(cmKeyOwnedByApp({ key: 'Mod-d' }, { 'daily.openToday': null }, 'windows'), false);
});

test('Ctrl+Shift+0 reads as the digit, keypad +/- as =/-', async () => {
  const { eventToCombo } = await import('./keybindings.ts');
  const ev = (init: Partial<KeyboardEvent>) =>
    ({ key: '', code: '', keyCode: 0, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;
  assert.equal(eventToCombo(ev({ key: ')', code: 'Digit0', ctrlKey: true, shiftKey: true })), 'Mod+Shift+0');
  assert.equal(eventToCombo(ev({ key: '+', code: 'NumpadAdd', ctrlKey: true })), 'Mod+Equal');
  assert.equal(eventToCombo(ev({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true })), 'Mod+Shift+Equal');
  assert.equal(eventToCombo(ev({ key: '0', code: 'Digit0', ctrlKey: true })), 'Mod+0');
});

test('a list override keeps every chord', async () => {
  const { combosFor } = await import('./keybindings.ts');
  assert.deepEqual(combosFor('view.toggleLiveEdit', { 'view.toggleLiveEdit': ['Mod+/', 'Mod+Alt+/'] }, 'windows'), [
    'Mod+Slash',
    'Mod+Alt+Slash',
  ]);
});

test('⌘F stays in CodeMirror: the app find handler defers to it in the editor', async () => {
  const { cmKeyOwnedByApp } = await import('./keybindings.ts');
  for (const platform of ['windows', 'mac', 'linux'] as const) {
    assert.equal(cmKeyOwnedByApp({ key: 'Mod-f' }, {}, platform), false, platform);
  }
});

test('a key event without a code still matches punctuation chords (Ctrl+,)', async () => {
  const { eventToCombo, normalizeCombo, resolveBindings } = await import('./keybindings.ts');
  const e = { isComposing: false, key: ',', code: '', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, keyCode: 188 } as unknown as KeyboardEvent;
  assert.equal(resolveBindings({}, 'windows').get(normalizeCombo(eventToCombo(e)!)), 'settings.open');
});

test('no default app binding sits on a standard editing chord', async () => {
  const { activeKeyActions, STANDARD_EDITING_CHORDS, normalizeCombo } = await import('./keybindings.ts');
  const editing = new Set(['Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+A', 'Mod+C', 'Mod+V', 'Mod+X'].map(normalizeCombo));
  assert.deepEqual(new Set(STANDARD_EDITING_CHORDS.map(normalizeCombo)), editing);
  for (const platform of ['windows', 'mac', 'linux'] as const) {
    for (const a of activeKeyActions(platform)) {
      for (const c of a.defaults) {
        assert.ok(!editing.has(normalizeCombo(c)), `${a.id} ships on ${c} (${platform})`);
      }
    }
  }
});

test('a chord the editor already handled runs only app-level commands', async () => {
  const { appRunsAfterEditor } = await import('./keybindings.ts');
  // F-1: redo in CodeMirror must not also start a writing session.
  assert.equal(appRunsAfterEditor('pomodoro.startLast', 'Mod+Shift+Z', 'mac'), false);
  assert.equal(appRunsAfterEditor('editor.aiRewrite', 'Mod+J', 'mac'), false);
  assert.equal(appRunsAfterEditor('fmt.bold', 'Mod+Shift+B', 'mac'), false);
  // File / navigation commands still win (e.g. Vim's Ctrl-o on Windows).
  assert.equal(appRunsAfterEditor('file.open', 'Mod+O', 'windows'), true);
  assert.equal(appRunsAfterEditor('palette.open', 'Mod+Shift+K', 'windows'), true);
  // …but never on an editing chord, even when the user rebound one there.
  assert.equal(appRunsAfterEditor('file.save', 'Mod+Z', 'windows'), false);
});
