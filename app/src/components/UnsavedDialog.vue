<script setup lang="ts">
import { computed, watch, onBeforeUnmount } from 'vue';
import { DsModal, DsButton } from '../ui';
import Icons from './Icons.vue';
import { useI18n } from '../i18n';
import { usesMacDialogKeys } from '../lib/platform';
const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  fileName: string;
  /** 'tab' = closing a single tab, 'window' = closing the entire window */
  mode: 'tab' | 'window';
  count?: number;
}>();
const emit = defineEmits<{
  (e: 'save'): void;
  (e: 'discard'): void;
  (e: 'cancel'): void;
}>();

type Action = 'save' | 'discard' | 'cancel';

// #357 — keyboard access. Two conventions:
//  • macOS: Return / ⌘S = Save, ⌘D = Don’t Save, Esc / ⌘. = Cancel. Labels
//    stay plain, as in native macOS sheets.
//  • Windows / Linux: access keys, underlined in the label (“Save” with the
//    S underlined), or appended as “保存(S)” when the label has no such letter
//    (CJK). Alt+letter or the bare letter triggers the button; Enter activates
//    the focused button (Save is focused on open); Esc = Cancel.
const mac = usesMacDialogKeys();

interface Mnemonic {
  before: string;
  key: string;
  after: string;
  /** true = the key is not in the label and is appended as “(K)”. */
  suffix: boolean;
}

function mnemonic(label: string, key: string): Mnemonic {
  const i = key ? label.toLowerCase().indexOf(key.toLowerCase()) : -1;
  if (i < 0) return { before: label, key, after: '', suffix: true };
  return { before: label.slice(0, i), key: label.charAt(i), after: label.slice(i + 1), suffix: false };
}

const saveKey = computed(() => t('unsaved.saveKey'));
const dontSaveKey = computed(() => t('unsaved.dontSaveKey'));
const saveLabel = computed(() => mnemonic(t('unsaved.save'), saveKey.value));
const dontSaveLabel = computed(() => mnemonic(t('unsaved.dontSave'), dontSaveKey.value));

const saveShortcuts = computed(() =>
  mac ? 'Enter Meta+S' : `Alt+${saveKey.value} ${saveKey.value} Enter`,
);
const dontSaveShortcuts = computed(() => (mac ? 'Meta+D' : `Alt+${dontSaveKey.value} ${dontSaveKey.value}`));

/**
 * Does this keydown carry the given access-key letter? Latin letters are
 * matched on the physical key (`code`) as well as `key`, because macOS turns
 * Option+S into “ß” and an active CJK IME can report `Process` — the letter
 * the user pressed is still KeyS. Non-Latin keys (Cyrillic) match on `key`.
 */
function hasLetter(e: KeyboardEvent, letter: string): boolean {
  if (!letter) return false;
  const l = letter.toLowerCase();
  if ((e.key || '').toLowerCase() === l) return true;
  return /^[a-z]$/.test(l) && e.code === `Key${l.toUpperCase()}`;
}

function actionButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-unsaved-action]'));
}

function fire(e: KeyboardEvent, action: Action) {
  e.preventDefault();
  e.stopImmediatePropagation();
  if (action === 'save') emit('save');
  else if (action === 'discard') emit('discard');
  else emit('cancel');
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  // Leave IME composition alone (defensive — focus sits on a button, so an
  // IME should not be composing here, but never eat a composing keystroke).
  if (e.isComposing || e.keyCode === 229) return;
  // Tab / Shift+Tab: DsModal's focus trap handles it.
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return;

  if (e.key === 'Escape') return fire(e, 'cancel');

  if (mac) {
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) return fire(e, 'save');
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === '.') return fire(e, 'cancel');
      if (hasLetter(e, 's')) return fire(e, 'save');
      if (hasLetter(e, 'd')) return fire(e, 'discard');
    }
  } else {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Enter activates the focused button (Save by default); anything else
      // focused in the dialog (the panel itself) falls back to Save.
      const active = document.activeElement as HTMLElement | null;
      const act = active?.closest('[data-unsaved-action]')?.getAttribute('data-unsaved-action');
      return fire(e, (act as Action | null) ?? (active?.closest('.ds-modal__close') ? 'cancel' : 'save'));
    }
    if (!e.ctrlKey && !e.metaKey) {
      if (hasLetter(e, saveKey.value)) return fire(e, 'save');
      if (hasLetter(e, dontSaveKey.value)) return fire(e, 'discard');
    }
    // ←/→ move between the buttons, like a native Windows message box.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const btns = actionButtons();
      const i = btns.indexOf(document.activeElement as HTMLElement);
      const next = i < 0 ? 0 : (i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length;
      btns[next]?.focus();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
  }

  // Everything else stays inside the dialog: no global shortcut (⌘W, ⌘Tab
  // between tabs, the editor’s own keymaps…) may act while it is open. Space
  // still activates the focused button natively (default not prevented), and
  // modified keys have their default suppressed so e.g. Ctrl+S / Ctrl+P don’t
  // open browser UI.
  e.stopImmediatePropagation();
  if (e.ctrlKey || e.metaKey || e.altKey) e.preventDefault();
}

// Only listen while the dialog is open, so typing (and IME) elsewhere is
// untouched. Window capture runs before every other keydown listener in the
// app (they are window/document bubble or document capture).
watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKeydown, true);
    else window.removeEventListener('keydown', onKeydown, true);
  },
  { immediate: true },
);
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('unsaved.title')"
    width="400px"
    @update:model-value="emit('cancel')"
  >
    <div class="ud-body">
      <div class="ud-body__icon" aria-hidden="true"><Icons name="alert" :size="22" /></div>
      <p class="ud-body__msg">
        <strong>{{ fileName }}</strong>: {{ t('unsaved.message', { file: fileName }).replace(fileName + ' ', '').replace(fileName, '') }}
      </p>
    </div>
    <template #footer>
      <DsButton variant="secondary" data-unsaved-action="cancel" aria-keyshortcuts="Escape" @click="emit('cancel')">{{ t('unsaved.cancel') }}</DsButton>
      <DsButton
        variant="danger"
        data-unsaved-action="discard"
        :aria-keyshortcuts="dontSaveShortcuts"
        @click="emit('discard')"
      >
        <template v-if="mac">{{ t('unsaved.dontSave') }}</template>
        <span v-else-if="dontSaveLabel.suffix">{{ dontSaveLabel.before }}(<u class="ud-ak">{{ dontSaveLabel.key }}</u>)</span>
        <span v-else>{{ dontSaveLabel.before }}<u class="ud-ak">{{ dontSaveLabel.key }}</u>{{ dontSaveLabel.after }}</span>
      </DsButton>
      <DsButton
        variant="primary"
        data-unsaved-action="save"
        data-autofocus
        :aria-keyshortcuts="saveShortcuts"
        @click="emit('save')"
      >
        <template v-if="mac">{{ t('unsaved.save') }}</template>
        <span v-else-if="saveLabel.suffix">{{ saveLabel.before }}(<u class="ud-ak">{{ saveLabel.key }}</u>)</span>
        <span v-else>{{ saveLabel.before }}<u class="ud-ak">{{ saveLabel.key }}</u>{{ saveLabel.after }}</span>
      </DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.ud-body {
  text-align: center;
}
.ud-body__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-bottom: var(--sp-3);
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent-text);
}
.ud-body__msg {
  font-size: 13px;
  color: var(--text-2);
  margin: 0;
  line-height: 1.5;
}
.ud-body__msg strong {
  color: var(--text);
}
.ud-ak {
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
