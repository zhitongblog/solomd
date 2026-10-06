<script setup lang="ts">
/**
 * 5.0 touch formatting bar (docs/v5-ui-spec.md §7–8): a 44 px row of format
 * buttons sitting directly on top of the software keyboard while an editor
 * has focus on iOS / Android.
 *
 * Positioned from `visualViewport`: the keyboard is "open" when the visual
 * viewport is shorter than the layout viewport (iOS) or than the tallest
 * layout height seen in this orientation (Android resizes the layout
 * viewport too). A hardware keyboard shrinks neither, so the bar stays away
 * — exactly when it isn't needed.
 *
 * Every button goes through an existing path: `fmt.*` via
 * `solomd:format-markdown` (the same handler as the shortcut), the insert-image
 * command via `solomd:menu-action`, undo via `solomd:editor-history`. The
 * buttons never take focus (`mousedown.prevent`), so the keyboard stays up.
 *
 * `?forceKeyboardBar` (dev only) previews it in a desktop browser, pinned to
 * the bottom of the window whenever an editor has focus.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icons.vue';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { forceKeyboardBarPreview } from '../lib/platform';

const { t } = useI18n();
const settings = useSettingsStore();
const preview = forceKeyboardBarPreview();

const BAR_H = 44;
/** Less than this much missing viewport is a toolbar / URL bar, not a keyboard. */
const KEYBOARD_MIN = 80;

const editorFocused = ref(false);
const keyboardOpen = ref(false);
const top = ref(0);
let baseline = 0;

function isEditorTarget(el: EventTarget | null): boolean {
  return el instanceof Element && !!el.closest('.cm-editor, .plain-host');
}

function onFocusIn(e: FocusEvent) {
  editorFocused.value = isEditorTarget(e.target);
  measure();
}
function onFocusOut(e: FocusEvent) {
  // Focus moving to another editor element (the plain editor's next block)
  // is not a blur.
  if (isEditorTarget(e.relatedTarget)) return;
  editorFocused.value = false;
}

function measure() {
  const vv = window.visualViewport;
  const layoutH = window.innerHeight;
  const vvH = vv ? vv.height : layoutH;
  const vvTop = vv ? vv.offsetTop : 0;
  // Android: the layout viewport shrinks with the keyboard, so compare with
  // the tallest height seen in this orientation. iOS: it doesn't, the visual
  // viewport does.
  // The keyboard only opens for a focused editor, so an unfocused layout
  // height is the full one.
  baseline = editorFocused.value ? Math.max(baseline, layoutH) : layoutH;
  const covered = Math.max(layoutH - (vvTop + vvH), baseline - layoutH);
  keyboardOpen.value = preview || covered > KEYBOARD_MIN;
  top.value = Math.round(vvTop + vvH - BAR_H);
}
function onOrientation() {
  baseline = 0;
  measure();
}

onMounted(() => {
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  window.visualViewport?.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('scroll', measure);
  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', onOrientation);
  editorFocused.value = isEditorTarget(document.activeElement);
  baseline = window.innerHeight;
  measure();
});
onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn);
  document.removeEventListener('focusout', onFocusOut);
  window.visualViewport?.removeEventListener('resize', measure);
  window.visualViewport?.removeEventListener('scroll', measure);
  window.removeEventListener('resize', measure);
  window.removeEventListener('orientationchange', onOrientation);
});

const visible = computed(
  () =>
    editorFocused.value &&
    keyboardOpen.value &&
    settings.viewMode !== 'preview' &&
    settings.viewMode !== 'reading',
);

function format(kind: string) {
  window.dispatchEvent(new CustomEvent('solomd:format-markdown', { detail: { kind } }));
}
function insertImage() {
  window.dispatchEvent(new CustomEvent('solomd:menu-action', { detail: 'editor.insertImage' }));
}
function undo() {
  window.dispatchEvent(new CustomEvent('solomd:editor-history', { detail: { op: 'undo' } }));
}
function hideKeyboard() {
  const a = document.activeElement;
  if (a instanceof HTMLElement) a.blur();
  editorFocused.value = false;
}

const buttons = computed(() => [
  { id: 'heading', icon: 'heading', label: t('formatBar.heading'), run: () => format('headingCycle') },
  { id: 'bold', icon: 'bold', label: t('cmd.fmt.bold'), run: () => format('bold') },
  { id: 'ul', icon: 'list', label: t('cmd.fmt.ul'), run: () => format('ul') },
  { id: 'task', icon: 'task', label: t('cmd.fmt.task'), run: () => format('task') },
  { id: 'link', icon: 'link', label: t('cmd.fmt.link'), run: () => format('link') },
  { id: 'image', icon: 'image', label: t('formatBar.image'), run: insertImage },
  { id: 'undo', icon: 'undo', label: t('formatBar.undo'), run: undo },
  { id: 'hide', icon: 'keyboard-hide', label: t('formatBar.hideKeyboard'), run: hideKeyboard },
]);
</script>

<template>
  <div
    v-if="visible"
    class="kb-bar"
    :style="{ transform: `translateY(${top}px)` }"
    role="toolbar"
    :aria-label="t('formatBar.label')"
    data-keyboard-bar
    @mousedown.prevent
  >
    <button
      v-for="b in buttons"
      :key="b.id"
      class="kb-bar__btn"
      :class="{ 'kb-bar__btn--end': b.id === 'hide' }"
      :title="b.label"
      :aria-label="b.label"
      :data-kind="b.id"
      @click="b.run()"
    >
      <Icon :name="b.icon" :size="20" />
    </button>
  </div>
</template>

<style scoped>
.kb-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--z-sticky);
  height: 44px;
  display: flex;
  align-items: stretch;
  padding: 0 max(var(--sp-1), env(safe-area-inset-right)) 0 max(var(--sp-1), env(safe-area-inset-left));
  background: var(--bg-sidebar);
  border-top: var(--bd-hair);
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.kb-bar__btn {
  flex: 1;
  min-width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text);
  cursor: default;
  touch-action: manipulation;
}
.kb-bar__btn:active {
  background: var(--fill-2);
}
.kb-bar__btn--end {
  color: var(--text-2);
}
@media (hover: hover) {
  .kb-bar__btn:hover {
    background: var(--fill-1);
  }
}
</style>
