import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOTKEY_INTERCEPTIONS,
  TYPORA_PRESET,
  WRITER_PRESET,
  activeKeyActions,
  normalizeCombo,
} from './keybindings.ts';
import {
  QUICK_CAPTURE_DEFAULT_SHORTCUT,
  QUICK_CAPTURE_LEGACY_SHORTCUT,
  acceleratorToCombo,
  migrateQuickCaptureShortcut,
} from './quick-capture-shortcut.ts';

const PLATFORMS = ['mac', 'windows', 'linux'] as const;

test('accelerators convert to the in-app combo grammar', () => {
  assert.equal(acceleratorToCombo('CmdOrCtrl+Alt+M'), 'Mod+Alt+M');
  assert.equal(acceleratorToCombo('CmdOrCtrl+Alt+Shift+M'), 'Mod+Alt+Shift+M');
  assert.equal(acceleratorToCombo('Shift+CommandOrControl+k'), 'Mod+Shift+K');
});

test('the old default really did collide with the formula editor', () => {
  const formula = activeKeyActions('linux').find((a) => a.id === 'editor.formulaEditor');
  assert.ok(formula?.defaults.includes(acceleratorToCombo(QUICK_CAPTURE_LEGACY_SHORTCUT)));
});

test('the quick-capture default is no in-app default on any platform', () => {
  const chord = acceleratorToCombo(QUICK_CAPTURE_DEFAULT_SHORTCUT);
  for (const platform of PLATFORMS) {
    for (const action of activeKeyActions(platform)) {
      for (const combo of action.defaults) {
        assert.notEqual(normalizeCombo(combo), chord, `${platform}: ${action.id} owns ${combo}`);
      }
    }
  }
});

test('no preset or interception alternative moves a command onto it either', () => {
  const chord = acceleratorToCombo(QUICK_CAPTURE_DEFAULT_SHORTCUT);
  const presetCombos = [...Object.values(TYPORA_PRESET), ...Object.values(WRITER_PRESET)]
    .flatMap((v) => (v == null ? [] : Array.isArray(v) ? v : [v]))
    .map(normalizeCombo);
  assert.ok(!presetCombos.includes(chord));
  for (const h of HOTKEY_INTERCEPTIONS) assert.notEqual(normalizeCombo(h.alternative), chord);
});

test('only an untouched old default is migrated', () => {
  assert.equal(migrateQuickCaptureShortcut(QUICK_CAPTURE_LEGACY_SHORTCUT), QUICK_CAPTURE_DEFAULT_SHORTCUT);
  assert.equal(migrateQuickCaptureShortcut(undefined), QUICK_CAPTURE_DEFAULT_SHORTCUT);
  assert.equal(migrateQuickCaptureShortcut('Alt+Space'), 'Alt+Space');
  assert.equal(migrateQuickCaptureShortcut('CmdOrCtrl+Shift+Space'), 'CmdOrCtrl+Shift+Space');
  assert.equal(migrateQuickCaptureShortcut(QUICK_CAPTURE_DEFAULT_SHORTCUT), QUICK_CAPTURE_DEFAULT_SHORTCUT);
});
