<script setup lang="ts">
/**
 * 5.0 selection bubble (docs/v5-ui-spec.md §5) — the floating format bar over
 * a text selection, as in Apple's own text-formatting popovers.
 *
 * Editor-agnostic on purpose: SoloMD has two editors on Windows (CodeMirror
 * and the native textarea one), and a feature written against one of them is
 * silently dead in the other. Editor.vue hands this component two readers —
 * `read` (the selection, as text) and `rect` (where it is on screen) — for
 * whichever editor it is running, and runs the button through its own
 * `fmt.*` path when we emit `format`. No formatting logic lives here.
 *
 * Shows after the selection has been still for 150 ms with the mouse button
 * up; hides on typing, scroll, collapse, Escape and blur. Never takes focus
 * or the selection (every press is `mousedown.prevent`). Never on touch
 * devices — iOS / Android have their own callout, and the keyboard bar.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icons.vue';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { shortcutLabel } from '../lib/keybindings';
import { isMacOS, isMobile } from '../lib/platform';
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import type { FormatKind } from '../lib/md-format';
import {
  headingLevelAt,
  isBubbleSelection,
  isFormatActive,
  placeBubble,
  type Box,
} from '../lib/selection-bubble';

export interface BubbleSelection {
  /** The line(s) the selection touches (see lineContext)… */
  context: string;
  /** …and the selection, as offsets into `context`. */
  from: number;
  to: number;
  /** Identifies this selection (absolute offsets): Escape dismisses only it. */
  key: string;
}

const props = defineProps<{
  /** The editor's root element: events are read from it, the bar stays inside it. */
  host: HTMLElement | null;
  enabled: boolean;
  read: () => BubbleSelection | null;
  rect: () => Box | null;
}>();
const emit = defineEmits<{ (e: 'format', kind: FormatKind): void }>();

const { t } = useI18n();
const settings = useSettingsStore();
const mac = isMacOS();
const touchPlatform = isMobile();

const STILL_MS = 150;

const visible = ref(false);
const below = ref(false);
const pos = ref<{ left: number; top: number } | null>(null);
const sel = ref<BubbleSelection | null>(null);
const headingOpen = ref(false);
/** The heading menu opens away from the selection, unless that runs off the top. */
const menuBelow = ref(false);
const barEl = ref<HTMLElement | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
let pointerDown = false;
let composing = false;
let lastPointerTouch = false;
let dismissedKey: string | null = null;
let shownKey: string | null = null;
/** Until then, selection changes / scrolls are our own edit landing: follow it. */
let followUntil = 0;

const aiAvailable = computed(() => !IS_APP_STORE_BUILD && settings.aiEnabled);

function chord(actionId: string): string {
  return shortcutLabel(actionId, settings.keybindings, mac) || '';
}
function tip(labelKey: string, actionId?: string): string {
  const label = t(labelKey);
  const c = actionId ? chord(actionId) : '';
  return c ? `${label} (${c})` : label;
}

function active(kind: FormatKind): boolean {
  const s = sel.value;
  return !!s && isFormatActive(s.context, s.from, s.to, kind);
}
const headingLevel = computed(() => (sel.value ? headingLevelAt(sel.value.context, sel.value.from) : 0));

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function hide() {
  clearTimer();
  visible.value = false;
  headingOpen.value = false;
  pos.value = null;
  shownKey = null;
}

function schedule() {
  clearTimer();
  if (!props.enabled || touchPlatform) return;
  timer = setTimeout(() => {
    timer = null;
    void show(false);
  }, STILL_MS);
}

function readUsable(): BubbleSelection | null {
  if (!props.enabled || touchPlatform || lastPointerTouch) return null;
  if (pointerDown || composing) return null;
  const s = props.read();
  if (!s || !isBubbleSelection(s.context.slice(s.from, s.to))) return null;
  return s;
}

/** Show (or, with `inPlace`, re-measure an open bar without re-animating). */
async function show(inPlace: boolean) {
  const s = readUsable();
  if (!s) {
    hide();
    return;
  }
  if (!inPlace && s.key === dismissedKey) return;
  dismissedKey = null;
  const r = props.rect();
  const host = props.host;
  if (!r || !host) {
    hide();
    return;
  }
  const bounds = host.getBoundingClientRect();
  // The selection scrolled out of the pane: nothing to point at.
  if (r.bottom < bounds.top || r.top > bounds.bottom) {
    hide();
    return;
  }
  sel.value = s;
  if (!visible.value) {
    pos.value = null;
    visible.value = true;
  }
  shownKey = s.key;
  await nextTick();
  const el = barEl.value;
  if (!el) return;
  const p = placeBubble(r, { width: el.offsetWidth, height: el.offsetHeight }, {
    left: Math.max(bounds.left, 0),
    right: Math.min(bounds.right, window.innerWidth),
    top: Math.max(bounds.top, 0),
    bottom: Math.min(bounds.bottom, window.innerHeight),
  });
  below.value = p.below;
  pos.value = { left: p.left, top: p.top };
}

// ── events from the editor ────────────────────────────────────────────────
function onSelectionChange() {
  if (!props.enabled) return;
  if (Date.now() < followUntil) {
    if (visible.value) void show(true);
    return;
  }
  // The editor re-asserting the same selection (CodeMirror does on redraws)
  // is not a change.
  if (visible.value) {
    const s = props.read();
    if (s && s.key === shownKey) return;
    hide();
  }
  schedule();
}

function onDocSelectionChange() {
  const host = props.host;
  if (!host) return;
  const a = document.activeElement;
  if (!a || !host.contains(a)) return;
  onSelectionChange();
}

function onPointerDown(e: PointerEvent) {
  lastPointerTouch = e.pointerType === 'touch';
  if (e.button === 0) pointerDown = true;
  hide();
}
function onWindowPointerUp(e: PointerEvent) {
  if (!pointerDown) return;
  pointerDown = false;
  if (barEl.value && e.target instanceof Node && barEl.value.contains(e.target)) return;
  schedule();
}

const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock', 'Fn', 'OS']);
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (headingOpen.value) {
      headingOpen.value = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (visible.value || timer) {
      dismissedKey = props.read()?.key ?? shownKey;
      const wasVisible = visible.value;
      hide();
      if (wasVisible) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    return;
  }
  if (MODIFIERS.has(e.key)) return;
  // Typing, deleting, arrows, ⌘B… — the bar goes; if a selection is still
  // there afterwards (Shift+arrow, a format chord) the selection change that
  // follows brings it back after the pause.
  hide();
}
function onCompositionStart() {
  composing = true;
  hide();
}
function onCompositionEnd() {
  composing = false;
}
function onScroll() {
  if (Date.now() < followUntil) {
    if (visible.value) void show(true);
    return;
  }
  if (visible.value || timer) hide();
}
function onFocusOut() {
  // Focus moving between the plain editor's block textareas stays inside.
  setTimeout(() => {
    const a = document.activeElement;
    if (!props.host || !a || !props.host.contains(a)) hide();
  }, 0);
}
function onWindowBlur() {
  hide();
}
/** Back to the window with the selection still there: offer the bar again. */
function onWindowFocus() {
  const a = document.activeElement;
  if (props.host && a && props.host.contains(a)) schedule();
}

let bound: HTMLElement | null = null;
function bind(host: HTMLElement | null) {
  if (bound === host) return;
  unbind();
  if (!host || touchPlatform) return;
  bound = host;
  host.addEventListener('pointerdown', onPointerDown, true);
  host.addEventListener('keydown', onKeyDown, true);
  host.addEventListener('keyup', onSelectionChange, true);
  host.addEventListener('select', onSelectionChange, true);
  host.addEventListener('compositionstart', onCompositionStart, true);
  host.addEventListener('compositionend', onCompositionEnd, true);
  host.addEventListener('scroll', onScroll, true);
  host.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('selectionchange', onDocSelectionChange);
  window.addEventListener('pointerup', onWindowPointerUp, true);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('resize', hide);
}
function unbind() {
  const host = bound;
  if (!host) return;
  bound = null;
  host.removeEventListener('pointerdown', onPointerDown, true);
  host.removeEventListener('keydown', onKeyDown, true);
  host.removeEventListener('keyup', onSelectionChange, true);
  host.removeEventListener('select', onSelectionChange, true);
  host.removeEventListener('compositionstart', onCompositionStart, true);
  host.removeEventListener('compositionend', onCompositionEnd, true);
  host.removeEventListener('scroll', onScroll, true);
  host.removeEventListener('focusout', onFocusOut, true);
  document.removeEventListener('selectionchange', onDocSelectionChange);
  window.removeEventListener('pointerup', onWindowPointerUp, true);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('focus', onWindowFocus);
  window.removeEventListener('resize', hide);
}

watch(() => props.host, (h) => bind(h), { immediate: true });
watch(() => props.enabled, (on) => { if (!on) hide(); });
onBeforeUnmount(() => {
  hide();
  unbind();
});

// ── actions ───────────────────────────────────────────────────────────────
function run(kind: FormatKind) {
  headingOpen.value = false;
  followUntil = Date.now() + 400;
  emit('format', kind);
  // The edit (and its new selection) lands on the next tick on the plain
  // path; re-measure once it has, so the bar follows the text it wraps.
  requestAnimationFrame(() => requestAnimationFrame(() => void show(true)));
}
const MENU_ROOM = 3 * 28 + 2 * 4 + 16;
function toggleHeadingMenu() {
  menuBelow.value = below.value || (pos.value?.top ?? 0) < MENU_ROOM;
  headingOpen.value = !headingOpen.value;
}
function aiRewrite() {
  hide();
  // Toolbar.vue owns AI rewrite (reads the selection from either editor and
  // opens the overlay); this is the same event the menu bar uses.
  window.dispatchEvent(new CustomEvent('solomd:toolbar-ai-rewrite'));
}

const style = computed(() =>
  pos.value
    ? { left: `${pos.value.left}px`, top: `${pos.value.top}px` }
    : { left: '-9999px', top: '-9999px', visibility: 'hidden' as const },
);

const headings: Array<{ kind: FormatKind; level: number }> = [
  { kind: 'h1', level: 1 },
  { kind: 'h2', level: 2 },
  { kind: 'h3', level: 3 },
];

defineExpose({ hide });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="barEl"
      class="sel-bubble"
      :class="{ 'sel-bubble--below': below, 'sel-bubble--placed': !!pos }"
      :style="style"
      role="toolbar"
      :aria-label="t('formatBar.label')"
      data-selection-bubble
      @mousedown.prevent
    >
      <button
        class="sel-bubble__btn"
        :class="{ 'is-on': active('bold') }"
        :title="tip('cmd.fmt.bold', 'fmt.bold')"
        :aria-label="t('cmd.fmt.bold')"
        :aria-pressed="active('bold')"
        data-kind="bold"
        @click="run('bold')"
      ><Icon name="bold" :size="16" /></button>
      <button
        class="sel-bubble__btn"
        :class="{ 'is-on': active('italic') }"
        :title="tip('cmd.fmt.italic', 'fmt.italic')"
        :aria-label="t('cmd.fmt.italic')"
        :aria-pressed="active('italic')"
        data-kind="italic"
        @click="run('italic')"
      ><Icon name="italic" :size="16" /></button>
      <button
        class="sel-bubble__btn"
        :class="{ 'is-on': active('code') }"
        :title="tip('cmd.fmt.code', 'fmt.code')"
        :aria-label="t('cmd.fmt.code')"
        :aria-pressed="active('code')"
        data-kind="code"
        @click="run('code')"
      ><Icon name="code" :size="16" /></button>
      <button
        class="sel-bubble__btn"
        :title="tip('cmd.fmt.link', 'fmt.link')"
        :aria-label="t('cmd.fmt.link')"
        data-kind="link"
        @click="run('link')"
      ><Icon name="link" :size="16" /></button>

      <span class="sel-bubble__sep" aria-hidden="true"></span>

      <div class="sel-bubble__menu-anchor">
        <button
          class="sel-bubble__btn"
          :class="{ 'is-on': headingLevel > 0 || headingOpen }"
          :title="t('formatBar.heading')"
          :aria-label="t('formatBar.heading')"
          aria-haspopup="menu"
          :aria-expanded="headingOpen"
          data-kind="heading"
          @click="toggleHeadingMenu"
        ><Icon name="heading" :size="16" /></button>
        <div v-if="headingOpen" class="sel-bubble__menu" :class="{ 'sel-bubble__menu--below': menuBelow }" role="menu">
          <button
            v-for="h in headings"
            :key="h.kind"
            class="sel-bubble__item"
            :class="`sel-bubble__item--h${h.level}`"
            role="menuitemradio"
            :aria-checked="headingLevel === h.level"
            :data-kind="h.kind"
            @click="run(h.kind)"
          >
            <span class="sel-bubble__check" aria-hidden="true">
              <Icon v-if="headingLevel === h.level" name="check" :size="12" />
            </span>
            <span class="sel-bubble__name">{{ t(`cmd.fmt.${h.kind}`) }}</span>
            <span v-if="chord(`fmt.${h.kind}`)" class="sel-bubble__chord">{{ chord(`fmt.${h.kind}`) }}</span>
          </button>
        </div>
      </div>
      <button
        class="sel-bubble__btn"
        :class="{ 'is-on': active('ul') }"
        :title="tip('cmd.fmt.ul', 'fmt.ul')"
        :aria-label="t('cmd.fmt.ul')"
        :aria-pressed="active('ul')"
        data-kind="ul"
        @click="run('ul')"
      ><Icon name="list" :size="16" /></button>
      <button
        class="sel-bubble__btn"
        :class="{ 'is-on': active('quote') }"
        :title="tip('cmd.fmt.quote', 'fmt.quote')"
        :aria-label="t('cmd.fmt.quote')"
        :aria-pressed="active('quote')"
        data-kind="quote"
        @click="run('quote')"
      ><Icon name="quote" :size="16" /></button>

      <template v-if="aiAvailable">
        <span class="sel-bubble__sep" aria-hidden="true"></span>
        <button
          class="sel-bubble__btn"
          :title="tip('cmd.editor.aiRewrite', 'editor.aiRewrite')"
          :aria-label="t('cmd.editor.aiRewrite')"
          data-kind="ai"
          @click="aiRewrite"
        ><Icon name="sparkle" :size="16" /></button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.sel-bubble {
  position: fixed;
  z-index: var(--z-pop);
  display: flex;
  align-items: center;
  gap: 1px;
  padding: var(--sp-1);
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  user-select: none;
  -webkit-user-select: none;
  font-family: var(--font-ui, system-ui);
}
.sel-bubble--placed {
  animation: sel-bubble-in var(--dur-fast) var(--ease-out) both;
}
.sel-bubble--placed.sel-bubble--below {
  animation-name: sel-bubble-in-below;
}
@keyframes sel-bubble-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@keyframes sel-bubble-in-below {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}

.sel-bubble__btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  cursor: default;
  transition: background-color var(--dur-fast) var(--ease-out);
}
.sel-bubble__btn:hover {
  background: var(--fill-1);
}
.sel-bubble__btn:active,
.sel-bubble__btn.is-on {
  background: var(--fill-2);
}
.sel-bubble__btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

.sel-bubble__sep {
  width: var(--hair-w);
  align-self: stretch;
  margin: 6px var(--sp-1);
  background: var(--hairline);
}

.sel-bubble__menu-anchor {
  position: relative;
  display: inline-flex;
}
/* Opens away from the selection: above the bar when the bar is above it. */
.sel-bubble__menu {
  position: absolute;
  left: -4px;
  bottom: calc(100% + 8px);
  min-width: 180px;
  padding: var(--sp-1);
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  animation: sel-bubble-menu-in var(--dur-fast) var(--ease-out) both;
  transform-origin: bottom left;
}
.sel-bubble__menu--below {
  bottom: auto;
  top: calc(100% + 8px);
  transform-origin: top left;
}
@keyframes sel-bubble-menu-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: none; }
}
.sel-bubble__item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: 28px;
  padding: 0 var(--sp-2) 0 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: default;
}
.sel-bubble__item:hover {
  background: var(--fill-1);
}
.sel-bubble__item--h1 .sel-bubble__name { font-weight: 650; }
.sel-bubble__item--h2 .sel-bubble__name { font-weight: 620; }
.sel-bubble__item--h3 .sel-bubble__name { font-weight: 600; }
.sel-bubble__check {
  width: 12px;
  display: inline-flex;
  color: var(--accent);
}
.sel-bubble__name {
  flex: 1;
}
.sel-bubble__chord {
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
</style>
