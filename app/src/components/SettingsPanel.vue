<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue';
import { shortcutLabel } from '../lib/keybindings';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useWorkspaceStore } from '../stores/workspace';
import { useRagStore } from '../stores/rag';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { themeLabels } from '../lib/themes';
import { useI18n } from '../i18n';
import { quickCaptureError } from '../lib/quick-capture-status';
import {
  activeKeyActions,
  combosFor,
  conflictFor,
  eventToCombo,
  formatCombo,
  normalizeCombo,
  interceptedBindings,
  filterKeyActions,
  WRITER_PRESET,
  writerPresetActive,
  typoraPreset,
  presetActive,
  planPreset,
  type KeyActionDef,
} from '../lib/keybindings';
import { isMacOS } from '../lib/platform';
import { isMasBuild } from '../lib/check-update';
import { useUpdateCheck } from '../composables/useUpdateCheck';
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import { useFiles } from '../composables/useFiles';
import AISettings from './AISettings.vue';
import CitationPickerSettings from './CitationPickerSettings.vue';
import CaptureEndpointSettings from './CaptureEndpointSettings.vue';
import RestApiSettings from './RestApiSettings.vue';
import CostMeterSettings from './CostMeterSettings.vue';
import IntegrationsSettings from './IntegrationsSettings.vue';
// v4.0 Pillar 2 — Agent Recipes panel. Mounted under the existing
// "Integrations" category so users find Recipes alongside CLI / MCP /
// AI rewrite — i.e. the cluster of "things SoloMD talks to" rather
// than a brand-new top-level category.
import RecipesSettings from './RecipesSettings.vue';
import GithubSyncSettings from './GithubSyncSettings.vue';
import CloudFolderBanner from './CloudFolderBanner.vue';
import ProxySettings from './ProxySettings.vue';
import ThemeMarketplace from './ThemeMarketplace.vue';
import { isIOS, isMobile, hasGitBackend, isWindowsEditorRuntime, resolveWindowsEditorEngine } from '../lib/platform';
import type { WindowsEditorEngine } from '../lib/platform';
import { loadCustomTheme } from '../lib/custom-theme';
import { openPath } from '@tauri-apps/plugin-opener';
import { DsModal } from '../ui';
import Icons from './Icons.vue';
import { getDict } from '../i18n';
import { flatten, englishFallbackNeedles, blockMatches, normalize, queryMatcher } from '../lib/settings-search';
import type { Theme } from '../types';

const isMobilePlatform = isIOS();
// Quick capture needs an OS-level hotkey and a second window — neither exists
// on Android or iOS, so the whole section stays off phones (isIOS alone would
// still show it on Android).
const isPhoneOrTablet = isMobile();
const masBuild = isMasBuild();
/**
 * #230 — the whole git-backed surface (version history, GitHub sync, proxy,
 * recipes) is compiled out of the Android binary. Rendering those panels there
 * only produced `Command … not found` errors the moment the user touched them.
 */
const gitBackend = hasGitBackend();
// What "Automatic" resolves to on this machine's WebView2 (shown in its label).
const autoEngineName = computed(() =>
  resolveWindowsEditorEngine('auto') === 'codemirror'
    ? t('settings.windowsEditorEngineNameCodeMirror')
    : t('settings.windowsEditorEngineNameNative'),
);

const { t } = useI18n();
// #180 — the chord in this sentence comes from the user's bindings, not from
// a literal baked into the translation.
const macChord = isMacOS();
const kbSettings = useSettingsStore();
function withChord(key: string, actionId: string): string {
  return t(key, { key: shortcutLabel(actionId, kbSettings.keybindings, macChord) || '—' });
}

// v3.0 — left-side category nav. Settings was a 30+ item single scroll;
// split into 6 groups so the user navigates by category, not by scroll.
type SettingsCategory = 'basics' | 'writing' | 'sync' | 'integrations' | 'export' | 'keys' | 'advanced';
const activeCategory = ref<SettingsCategory>('basics');
// #144 — all six category pages share the single scrolling `.settings__body`
// (pages are toggled via CSS display), so one page's scrollTop leaked into
// every other page. Reset to top on each category switch.
const bodyEl = ref<HTMLElement | null>(null);
watch(activeCategory, () => {
  bodyEl.value?.scrollTo({ top: 0 });
});
// ---------------------------------------------------------------------------
// #180 — shortcut editor.
//
// Recording listens in the CAPTURE phase: the chord being recorded is usually
// one the app itself binds (that is the whole point), and on the bubble phase
// the global handler would have run the action before we saw the key.
// ---------------------------------------------------------------------------
const recordingAction = ref<string | null>(null);
const recordError = ref<string | null>(null);
const macKeys = isMacOS();

/** Sixty rows is past what anyone scans — filter by name, id or chord. */
const keyQuery = ref('');
const keyGroups = computed(() => {
  const hits = filterKeyActions(activeKeyActions(), keyQuery.value, actionLabel, settings.keybindings, macKeys);
  return (['file', 'edit', 'view', 'navigate', 'tools'] as const)
    .map((key) => ({ key, items: hits.filter((a) => a.category === key) }))
    .filter((g) => g.items.length > 0);
});

/**
 * Prefer the command palette's own translation (`cmd.<id>` — most action ids
 * *are* command ids), so the list reads in the user's language instead of
 * showing English names inside a translated panel. The table's English label
 * is the fallback for the handful of UI-only actions the palette has no
 * entry for.
 */
function actionLabel(action: KeyActionDef): string {
  const translated = t(`cmd.${action.id}`);
  return translated && translated !== `cmd.${action.id}` ? translated : action.label;
}

function actionCombos(action: KeyActionDef): string[] {
  return combosFor(action.id, settings.keybindings).map((c) => formatCombo(c, macKeys));
}
function isCustomised(action: KeyActionDef): boolean {
  // `in` is tracked by Vue's reactivity; `hasOwnProperty` is not (for a key
  // that doesn't exist yet), which would leave Reset disabled after a rebind.
  return action.id in settings.keybindings;
}
/**
 * Shortcuts another program takes over before SoloMD sees them — AMD
 * Software's global hotkeys own most of the Ctrl+Shift row, Microsoft Pinyin
 * takes one more. Nothing can be detected at runtime (the chord never
 * arrives), so the panel names them and offers somewhere else to put the
 * commands. Empty on every platform but Windows, and empty once the user has
 * moved them.
 */
const intercepted = computed(() => interceptedBindings(settings.keybindings));
const interceptedIds = computed(() => new Set(intercepted.value.map((b) => b.action.id)));

function interceptionFor(action: KeyActionDef) {
  return intercepted.value.find((b) => b.action.id === action.id) ?? null;
}

function applyHotkeyCompatPreset(): void {
  const moves = intercepted.value;
  for (const b of moves) settings.setKeybinding(b.action.id, b.alternative);
  toasts.success(t('settings.keysCompatApplied', { count: String(moves.length) }));
}

/**
 * #296 — ⌘B for bold is opt-in, not the default: it has toggled the file tree
 * since 1.0. The preset is a swap of two bindings, offered as one button so
 * nobody has to work out that freeing ⌘B means rebinding something else first.
 */
const writerPresetOn = computed(() => writerPresetActive(settings.keybindings));
const writerPresetKeys = computed(() => ({
  bold: formatCombo(WRITER_PRESET['fmt.bold'], macKeys),
  tree: formatCombo(WRITER_PRESET['view.toggleFileTree'], macKeys),
}));
function applyWriterPreset(): void {
  for (const [id, combo] of Object.entries(WRITER_PRESET)) settings.setKeybinding(id, combo);
  toasts.success(t('settings.keysWriterApplied', writerPresetKeys.value));
}
function undoWriterPreset(): void {
  for (const id of Object.keys(WRITER_PRESET)) settings.setKeybinding(id, undefined);
}

/**
 * B4 — the tester's full Typora / Word remap, as one button. Factory defaults
 * stay as they are (most people never hit the AMD clash, and ⌘B / ⌘E / ⌘D
 * have meant what they mean here for years); this is the opt-in.
 */
const typora = typoraPreset();
const typoraOn = computed(() => presetActive(typora, settings.keybindings));
const typoraKeys = computed(() => {
  const k = (id: string) => {
    const v = typora[id];
    const first = Array.isArray(v) ? v[0] : v;
    return first ? formatCombo(normalizeCombo(first), macKeys) : '—';
  };
  return {
    bold: k('fmt.bold'),
    up: k('heading.promote'),
    down: k('heading.demote'),
    para: k('heading.paragraph'),
    word: k('editor.selectWord'),
    live: k('view.toggleLiveEdit'),
    count: String(Object.keys(typora).length),
  };
});
function applyTyporaPreset(): void {
  const { apply, skipped } = planPreset(typora, settings.keybindings);
  for (const [id, value] of Object.entries(apply)) {
    settings.setKeybinding(id, Array.isArray(value) ? [...value] : value);
  }
  let msg = t('settings.keysTyporaApplied', { count: String(Object.keys(apply).length) });
  if (skipped.length) msg += ' ' + t('settings.keysTyporaSkipped', { count: String(skipped.length) });
  toasts.success(msg);
}
function undoTyporaPreset(): void {
  for (const id of Object.keys(typora)) settings.setKeybinding(id, undefined);
}

function startRecording(actionId: string): void {
  recordError.value = null;
  recordingAction.value = actionId;
  window.addEventListener('keydown', onRecordKey, true);
}
function stopRecording(): void {
  recordingAction.value = null;
  window.removeEventListener('keydown', onRecordKey, true);
}
function onRecordKey(e: KeyboardEvent): void {
  const id = recordingAction.value;
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    stopRecording();
    return;
  }
  const combo = eventToCombo(e);
  if (!combo) return; // a bare modifier — keep waiting for the real key
  const clash = conflictFor(combo, id, settings.keybindings);
  if (clash) {
    const other = activeKeyActions().find((a) => a.id === clash);
    recordError.value = t('settings.keysConflict', {
      combo: formatCombo(combo, macKeys),
      action: other ? actionLabel(other) : clash,
    });
    return; // stay armed so the next chord replaces this attempt
  }
  settings.setKeybinding(id, combo);
  stopRecording();
}
onUnmounted(stopRecording);

const categories: { id: SettingsCategory; icon: string; labelKey: string }[] = [
  { id: 'basics', icon: 'settings', labelKey: 'settings.catBasics' },
  { id: 'writing', icon: 'pencil', labelKey: 'settings.catWriting' },
  { id: 'sync', icon: 'cloud', labelKey: 'settings.catSync' },
  { id: 'integrations', icon: 'plug', labelKey: 'settings.catIntegrations' },
  { id: 'export', icon: 'export', labelKey: 'settings.catExport' },
  { id: 'keys', icon: 'keyboard', labelKey: 'settings.catKeys' },
  { id: 'advanced', icon: 'wrench', labelKey: 'settings.catAdvanced' },
];
const activeCategoryLabelKey = computed(
  () => categories.find((c) => c.id === activeCategory.value)?.labelKey ?? 'settings.title',
);

// Shared with Help → Check for Updates (composables/useUpdateCheck.ts).
const { checking: checkingUpdate, manualCheckUpdate } = useUpdateCheck();

const settingDefault = ref(false);

async function setAsDefault() {
  settingDefault.value = true;
  try {
    const msg = await invoke<string>('set_as_default_markdown_editor');
    toasts.success(msg);
  } catch (e) {
    toasts.error(String(e));
  } finally {
    settingDefault.value = false;
  }
}

const props = defineProps<{ open: boolean; initialSection?: string | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

// Deep-link support: callers (toolbar AI button, RAG empty state, etc.)
// pass `initial-section` to land on a specific category instead of the
// default `basics`. We watch open transitions to true rather than the
// section value alone, because the parent leaves the section ref in place
// after close — re-opening would otherwise jump back to the same anchor.
const VALID_CATEGORIES = new Set<SettingsCategory>([
  'basics', 'writing', 'sync', 'integrations', 'export', 'advanced',
]);
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    const target = props.initialSection;
    if (target && VALID_CATEGORIES.has(target as SettingsCategory)) {
      activeCategory.value = target as SettingsCategory;
    }
  },
);

const settings = useSettingsStore();
// #328/#344 — the editor-engine choice only exists where there are two
// editors, i.e. Windows (and the ?forcePlain dev hook).
const windowsEditorRuntime = isWindowsEditorRuntime();

// ---------------------------------------------------------------------------
// #352 — search across every category.
//
// Filtering works on what is rendered: each top-level `[data-cat]` block of
// the body is matched against its own text, so nothing has to be listed a
// second time. English keywords also work in a translated UI (see
// lib/settings-search.ts). While a query is active the category pages are
// switched off (no data-active-cat) and the matches are shown grouped under
// their category headings, in category order (CSS `order`).
// ---------------------------------------------------------------------------
const searchQuery = ref('');
const searchInput = ref<HTMLInputElement | null>(null);
const searching = computed(() => normalize(searchQuery.value).length > 0);
const searchHitCount = ref(0);
const catsWithHits = ref<Set<string>>(new Set());
const catOrder = new Map(categories.map((c, i) => [c.id as string, i]));
let flatCache: { lang: string; en: Map<string, string>; cur: Map<string, string> } | null = null;

function dictsFor(lang: string) {
  if (!flatCache || flatCache.lang !== lang) {
    const en = flatten(getDict('en'));
    flatCache = { lang, en, cur: lang === 'en' ? en : flatten(getDict(lang)) };
  }
  return flatCache;
}

const HIGHLIGHT = 'settings-search';
function clearHighlight() {
  (globalThis as any).CSS?.highlights?.delete?.(HIGHLIGHT);
}
/** Mark the matched words with the CSS Custom Highlight API — no DOM edits,
 *  so Vue's text nodes are left alone. Skipped where unsupported.
 *  A block that contains the typed query gets only the query marked; the
 *  English-fallback needles (whole translated sentences) are marked only in
 *  blocks that matched through them alone, or the page turns into a wall of
 *  orange. */
function highlight(blocks: HTMLElement[], query: string, fallback: string[]) {
  const registry = (globalThis as any).CSS?.highlights;
  const HighlightCtor = (globalThis as any).Highlight;
  if (!registry || !HighlightCtor) return;
  const ranges: Range[] = [];
  const hasQuery = queryMatcher(query);
  for (const b of blocks) {
    const needles = hasQuery(b.textContent || '') ? [query] : fallback;
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) && ranges.length < 500) {
      const parent = (node as Text).parentElement;
      if (parent?.closest('select, option, textarea')) continue;
      const text = (node.nodeValue || '').toLowerCase();
      for (const n of needles) {
        // Same rule as the matcher: Latin needles only at the start of a word.
        const latin = /^[a-z0-9 ._+#-]+$/.test(n);
        let i = n ? text.indexOf(n) : -1;
        while (i >= 0 && ranges.length < 500) {
          if (!latin || i === 0 || !/[a-z0-9]/.test(text[i - 1])) {
            const r = document.createRange();
            r.setStart(node, i);
            r.setEnd(node, i + n.length);
            ranges.push(r);
          }
          i = text.indexOf(n, i + n.length);
        }
      }
    }
  }
  registry.set(HIGHLIGHT, new HighlightCtor(...ranges));
}

function applySearch() {
  const body = bodyEl.value;
  if (!body) return;
  const blocks = Array.from(body.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.cat,
  );
  if (!searching.value) {
    for (const b of blocks) {
      delete b.dataset.match;
      b.style.order = '';
    }
    clearCurrentHit();
    hitEls = [];
    searchHitCount.value = 0;
    catsWithHits.value = new Set();
    clearHighlight();
    return;
  }
  const q = searchQuery.value;
  const { en, cur } = dictsFor(settings.language);
  const needles = englishFallbackNeedles(q, en, cur);
  const cats = new Set<string>();
  const hits: HTMLElement[] = [];
  for (const b of blocks) {
    const cat = b.dataset.cat!;
    const match = blockMatches(b.textContent || '', q, needles);
    b.dataset.match = match ? '1' : '0';
    b.style.order = String((catOrder.get(cat) ?? 99) * 2 + 1);
    if (match) {
      cats.add(cat);
      hits.push(b);
    }
  }
  // Display order is category order (CSS `order`), then document order —
  // the stepper walks them in the order the user sees them. sort() is stable.
  hits.sort((a, b) => (catOrder.get(a.dataset.cat!) ?? 99) - (catOrder.get(b.dataset.cat!) ?? 99));
  // A re-filter caused by a setting appearing/disappearing (MutationObserver)
  // keeps the current match if it is still one; a new query starts over.
  const prev = currentHit.value >= 0 ? hitEls[currentHit.value] : null;
  hitEls = hits;
  const keep = prev ? hits.indexOf(prev) : -1;
  if (keep < 0) prev?.removeAttribute('data-hit-current');
  currentHit.value = keep;
  searchHitCount.value = hits.length;
  catsWithHits.value = cats;
  highlight(hits, normalize(q), needles);
}

// #352 follow-up — step through the matches one at a time (buttons, and
// Enter / Shift+Enter in the search box). The current match gets a
// `data-hit-current` ring and a short accent pulse (`data-hit-flash`); data
// attributes rather than classes so Vue's class patching never drops them.
let hitEls: HTMLElement[] = [];
const currentHit = ref(-1);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function clearCurrentHit() {
  for (const el of bodyEl.value?.querySelectorAll('[data-hit-current]') ?? []) {
    el.removeAttribute('data-hit-current');
    el.removeAttribute('data-hit-flash');
  }
  currentHit.value = -1;
}

function stepHit(dir: 1 | -1) {
  const n = hitEls.length;
  const body = bodyEl.value;
  if (!n || !body) return;
  const from = currentHit.value;
  const i = from < 0 ? (dir === 1 ? 0 : n - 1) : (from + dir + n) % n;
  if (from >= 0) {
    hitEls[from].removeAttribute('data-hit-current');
    hitEls[from].removeAttribute('data-hit-flash');
  }
  const el = hitEls[i];
  currentHit.value = i;
  el.setAttribute('data-hit-current', '');
  // Restart the pulse even when stepping onto the same element (n === 1).
  el.removeAttribute('data-hit-flash');
  void el.offsetWidth;
  el.setAttribute('data-hit-flash', '');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.removeAttribute('data-hit-flash'), 1200);
  // Scroll only the one container that actually scrolls (scrollIntoView
  // would also nudge the modal/page). Centre the match; a block taller than
  // the viewport is aligned to its top instead, with room for the group
  // heading above a category's first match.
  const sc = scrollerOf(body);
  const b = sc.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  // In the phone layout the search bar sits inside the scroller, pinned
  // (sticky) to its top — the visible area starts below it.
  const bar = searchInput.value?.parentElement;
  const barH = bar && sc !== body && sc.contains(bar) ? bar.offsetHeight : 0;
  const visH = b.height - barH;
  const offset = r.top - b.top + sc.scrollTop - barH;
  const top = r.height + 48 < visH ? offset - (visH - r.height) / 2 : offset - 28;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  sc.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
}

/** The element that scrolls the settings. On desktop that is the body
 *  itself; in the phone layout the body grows to its content and the
 *  dialog's own body (`.ds-modal__body`) scrolls instead. */
function scrollerOf(body: HTMLElement): HTMLElement {
  for (let el: HTMLElement | null = body; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
    if (el.classList.contains('ds-modal__panel')) break;
  }
  return body;
}

/** Enter / Shift+Enter in the search box. Ignored mid-composition: with a
 *  Chinese/Japanese IME, Enter commits the text and must not also jump. */
function onSearchEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  stepHit(e.shiftKey ? -1 : 1);
}

/** While searching, the category rail lists only categories with a match.
 *  With no match at all the full list stays, so the rail (a chip row on a
 *  phone) is never blank and the user can still jump to a category. */
function navVisible(id: string) {
  return !searching.value || searchHitCount.value === 0 || catsWithHits.value.has(id);
}

// Blocks appear and disappear with settings (v-if), so re-filter on changes.
let bodyObserver: MutationObserver | null = null;
watch(
  [searchQuery, () => props.open, () => settings.language],
  async () => {
    await nextTick();
    clearCurrentHit(); // a new query (or language) starts stepping over
    applySearch();
    bodyObserver?.disconnect();
    bodyObserver = null;
    if (props.open && searching.value && bodyEl.value) {
      bodyObserver = new MutationObserver(() => applySearch());
      bodyObserver.observe(bodyEl.value, { childList: true });
    }
    if (searching.value && bodyEl.value) scrollerOf(bodyEl.value).scrollTo({ top: 0 });
  },
);

// 5.0 — System-Settings cards. Consecutive one-row settings of the page share
// one card, separated by hairlines; a block that carries its own group title
// (<h3>) or is a whole sub-panel (AISettings, GithubSyncSettings, …) gets a
// card of its own. Which blocks are visible depends on the category, the
// search and a dozen v-ifs, so the card edges are worked out from what is
// actually rendered: `data-gs` (group start) / `data-ge` (group end).
// While searching every match is its own card.
function markGroups() {
  const body = bodyEl.value;
  if (!body) return;
  const blocks = Array.from(body.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.cat,
  );
  const visible = blocks.filter((b) => b.getClientRects().length > 0);
  const standalone = (b: HTMLElement) =>
    searching.value || b.tagName !== 'SECTION' || b.firstElementChild?.tagName === 'H3';
  for (const b of blocks) {
    if (!visible.includes(b)) {
      delete b.dataset.gs;
      delete b.dataset.ge;
    }
  }
  visible.forEach((b, i) => {
    const prev = visible[i - 1];
    const next = visible[i + 1];
    const solo = standalone(b);
    if (!prev || solo || standalone(prev)) b.dataset.gs = '';
    else delete b.dataset.gs;
    if (!next || solo || standalone(next)) b.dataset.ge = '';
    else delete b.dataset.ge;
  });
}
let groupObserver: MutationObserver | null = null;
watch(
  [() => props.open, activeCategory, searchQuery, () => settings.language],
  async () => {
    await nextTick();
    markGroups();
    groupObserver?.disconnect();
    groupObserver = null;
    if (props.open && bodyEl.value) {
      groupObserver = new MutationObserver(() => markGroups());
      groupObserver.observe(bodyEl.value, { childList: true });
    }
  },
  { immediate: true },
);
onUnmounted(() => groupObserver?.disconnect());

function pickCategory(id: SettingsCategory) {
  searchQuery.value = '';
  activeCategory.value = id;
}

/** Esc clears a query before it closes the dialog, and ⌘F / Ctrl+F jumps to
 *  the search box. Window capture runs before DsModal's document-capture
 *  Escape handler (and the app's global shortcuts). */
function onSearchKeys(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === 'Escape' && searchQuery.value) {
    e.preventDefault();
    e.stopImmediatePropagation();
    searchQuery.value = '';
    searchInput.value?.focus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    e.stopImmediatePropagation();
    searchInput.value?.focus();
    searchInput.value?.select();
  }
}
watch(
  () => props.open,
  async (open) => {
    if (open) {
      window.addEventListener('keydown', onSearchKeys, true);
      // DsModal focuses the first control, which is now the search box. On a
      // phone that would raise the keyboard over a dialog the user opened to
      // browse, so give the focus back there.
      await nextTick();
      setTimeout(() => {
        if (document.documentElement.classList.contains('narrow-viewport')) searchInput.value?.blur();
      }, 0);
    } else {
      window.removeEventListener('keydown', onSearchKeys, true);
      searchQuery.value = '';
      clearHighlight();
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  window.removeEventListener('keydown', onSearchKeys, true);
  bodyObserver?.disconnect();
  if (flashTimer) clearTimeout(flashTimer);
  clearHighlight();
});


// #246 — dictionaries actually present, so the picker can't offer a language
// that would fail to load. `spellcheck_list_dicts` scans
// `<config>/dictionaries/` and always includes the bundled en_US.
const spellDicts = ref<string[]>(['en_US']);
async function refreshSpellDicts() {
  try {
    spellDicts.value = await invoke<string[]>('spellcheck_list_dicts');
  } catch {
    spellDicts.value = ['en_US'];
  }
}
/** Create + reveal the folder — nobody should have to guess where the OS puts
 *  app_config_dir(). Re-scans on return so a just-added pair shows up. */
async function openDictsFolder() {
  try {
    const dir = await invoke<string>('spellcheck_dicts_dir');
    await openPath(dir);
    setTimeout(refreshSpellDicts, 1500);
  } catch (e) {
    toasts.error(`${e}`);
  }
}
void refreshSpellDicts();
const tabs = useTabsStore();
const toasts = useToastsStore();
const workspace = useWorkspaceStore();
const files = useFiles();
const rag = useRagStore();

// #282 — a custom CSS theme takes the palette over completely (see the note
// beside the theme dropdown). Name it from the file rather than the
// marketplace manifest: the manifest is a network fetch that only happens
// once the marketplace modal is opened, and a hand-picked .css file has no
// manifest entry at all.
const customThemeName = computed(() => {
  const path = settings.customCssPath;
  if (!path) return '';
  const base = path.split(/[\\/]/).pop() || path;
  return base.replace(/\.css$/i, '');
});

async function onToggleRagEnabled() {
  settings.toggleRagEnabled();
  if (settings.ragEnabled && workspace.currentFolder) {
    // Kick off the indexer the moment the user opts in. spawn_blocking
    // on the Rust side keeps the UI thread free.
    await rag.setEnabled(workspace.currentFolder, true);
  } else {
    await rag.setEnabled(workspace.currentFolder, false);
  }
  if (rag.lastError) {
    toasts.error(`RAG: ${rag.lastError}`);
  }
}

async function onReindexNow() {
  if (!workspace.currentFolder) return;
  await rag.reindex(workspace.currentFolder);
  if (rag.lastError) {
    toasts.error(`RAG reindex failed: ${rag.lastError}`);
  } else {
    toasts.success(`Reindexed ${rag.status?.indexed_files ?? 0} files`);
  }
}

function onToggleOutlineGlobal() {
  settings.toggleOutline();
  // Apply the new default to all currently-open markdown tabs so the toggle
  // feels immediate, not just prospective for future tabs.
  tabs.setShowOutlineAll(settings.showOutline);
}

async function pickCustomCss() {
  const path = await openFileDialog({
    multiple: false,
    defaultPath: await files.filePickerStartDir(),
    filters: [{ name: 'CSS', extensions: ['css'] }],
  });
  if (path && typeof path === 'string') {
    settings.setCustomCssPath(path);
    toasts.success(t('settings.customCssLoaded'));
  }
}

// Re-read the current custom CSS file from disk and re-apply it. Useful when
// the user edits the .css file outside the app.
const isCssRefreshing = ref(false);
// One full revolution of the 0.7s spin animation. Reading a local .css file is
// near-instant, so without a floor the spinner would show for a single frame
// and the click would read as "nothing happened".
const CSS_REFRESH_MIN_MS = 700;
async function refreshCustomCss() {
  if (!settings.customCssPath || isCssRefreshing.value) return;
  const startedAt = Date.now();
  isCssRefreshing.value = true;
  try {
    // loadCustomTheme *removes* the theme when the file can't be read, so a
    // blanket success toast would claim a reload while wiping the user's CSS.
    const applied = await loadCustomTheme(settings.customCssPath);
    if (applied) toasts.success(t('settings.customCssReloaded'));
    else toasts.error(t('settings.customCssReloadFailed'));
  } finally {
    // Stop on a whole revolution so the icon never freezes mid-rev. At least
    // one full turn — Math.ceil alone yields 0 for a sub-millisecond read,
    // which would skip the spin entirely.
    const elapsed = Date.now() - startedAt;
    const revs = Math.max(1, Math.ceil(elapsed / CSS_REFRESH_MIN_MS));
    const remaining = revs * CSS_REFRESH_MIN_MS - elapsed;
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    isCssRefreshing.value = false;
  }
}

// v2.5: theme marketplace modal — opened from the Custom CSS section.
const themeMarketplaceOpen = ref(false);
function openThemeMarketplace() {
  themeMarketplaceOpen.value = true;
}

const fontFamilies = [
  // Monospace — for code-heavy editing
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
  { label: 'SF Mono', value: 'SF Mono' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Consolas', value: 'Consolas' },
  { label: 'Fira Code', value: 'Fira Code' },
  // Proportional — for prose / long-form writing
  { label: 'System Sans', value: '-apple-system, "Segoe UI", system-ui, sans-serif' },
  { label: 'Georgia (Serif)', value: 'Georgia' },
  { label: 'Times New Roman (Serif)', value: 'Times New Roman' },
  // Common CJK faces that already ship on the OS
  { label: 'PingFang SC', value: 'PingFang SC' },
  { label: 'Microsoft YaHei', value: 'Microsoft YaHei' },
  { label: 'Source Han Sans', value: 'Source Han Sans SC' },
  { label: 'Source Han Serif', value: 'Source Han Serif SC' },
  // Writing-friendly CJK faces (open source, install separately if missing)
  { label: 'LXGW WenKai 霞鹜文楷', value: 'LXGW WenKai' },
  { label: 'LXGW Bright 霞鹜新晨宋', value: 'LXGW Bright' },
  { label: 'TsangerJinKai 仓耳今楷', value: 'TsangerJinKai03 W04' },
];
const fontFamilyPresetValues = new Set(fontFamilies.map((f) => f.value));
// Track custom-mode independently of settings.fontFamily so selecting
// "自定义…" reveals the input even before user types anything.
const inCustomMode = ref(!fontFamilyPresetValues.has(settings.fontFamily));
const customFontFamily = ref(
  inCustomMode.value ? settings.fontFamily : ''
);
function onSelectFontFamily(v: string) {
  if (v === '__custom__') {
    inCustomMode.value = true;
    return;
  }
  inCustomMode.value = false;
  customFontFamily.value = '';
  settings.setFontFamily(v);
}
function onCustomFontInput(v: string) {
  customFontFamily.value = v;
  if (v.trim()) settings.setFontFamily(v.trim());
}
const fontFamilySelectValue = computed(() =>
  inCustomMode.value ? '__custom__' : settings.fontFamily
);

// ---- v2.5 F3: PDF / print export defaults ---------------------------------

const pdfMmRangeError = ref(false);
function onCustomMmChange(
  field:
    | 'customWidthMm'
    | 'customHeightMm'
    | 'customMarginTopMm'
    | 'customMarginRightMm'
    | 'customMarginBottomMm'
    | 'customMarginLeftMm',
  raw: string,
) {
  const n = Number(raw);
  // Width/height accept 50–500 mm; margins 5–100 mm. Out-of-range silently
  // clamps (the store also clamps) but flag the error inline so the user
  // sees feedback if they mistype "500" into a 5–100 field.
  const isMargin = field.startsWith('customMargin');
  const min = isMargin ? 5 : 50;
  const max = isMargin ? 100 : 500;
  if (!Number.isFinite(n) || n < min || n > max) {
    pdfMmRangeError.value = true;
  } else {
    pdfMmRangeError.value = false;
  }
  // Forward what we have — the store clamps to the safe range, so a typo
  // won't produce a half-page-wide margin.
  settings.setPdfDefaults({ [field]: n } as any);
}

// PDF font select: the dropdown uses the same `fontFamilies` list as the
// editor; the empty value means "inherit / use stylesheet default."
const pdfFontSelectValue = computed(() =>
  fontFamilyPresetValues.has(settings.pdfDefaults.fontFamily)
    ? settings.pdfDefaults.fontFamily
    : settings.pdfDefaults.fontFamily
      ? '__custom_pdf__'
      : ''
);
function onSelectPdfFont(v: string) {
  if (v === '__custom_pdf__') return;
  settings.setPdfDefaults({ fontFamily: v });
}
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('settings.title')"
    width="820px"
    class="settings-modal"
    @update:model-value="emit('close')"
  >
      <div class="settings__search">
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="search"
          class="settings__search-input"
          :placeholder="t('settings.searchPlaceholder')"
          :aria-label="t('settings.searchPlaceholder')"
          spellcheck="false"
          autocomplete="off"
          @keydown.enter="onSearchEnter"
        />
        <template v-if="searching">
          <span class="settings__search-steps">
            <button
              type="button"
              class="settings__search-step"
              :disabled="searchHitCount === 0"
              :title="t('settings.searchPrev')"
              :aria-label="t('settings.searchPrev')"
              @click="stepHit(-1)"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button
              type="button"
              class="settings__search-step"
              :disabled="searchHitCount === 0"
              :title="t('settings.searchNext')"
              :aria-label="t('settings.searchNext')"
              @click="stepHit(1)"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </span>
          <span
            class="settings__search-count"
            aria-live="polite"
            :title="currentHit >= 0 ? t('settings.searchPosition', { i: currentHit + 1, n: searchHitCount }) : undefined"
          >
            <template v-if="currentHit >= 0">
              <span aria-hidden="true">{{ currentHit + 1 }}/{{ searchHitCount }}</span>
              <span class="settings__sr-only">{{ t('settings.searchPosition', { i: currentHit + 1, n: searchHitCount }) }}</span>
            </template>
            <template v-else>{{ t('settings.searchCount', { n: searchHitCount }) }}</template>
          </span>
        </template>
      </div>
      <div class="settings__layout">
        <!-- v3.0 — left-side category nav. Click switches the right-side
             content panel; only one category visible at a time. -->
        <nav class="settings__nav">
          <button
            v-for="c in categories"
            v-show="navVisible(c.id)"
            :key="c.id"
            class="settings__nav-item"
            :class="{ 'settings__nav-item--active': !searching && activeCategory === c.id }"
            @click="pickCategory(c.id)"
          >
            <Icons class="settings__nav-icon" :name="c.icon" :size="16" />
            <span class="settings__nav-label">{{ t(c.labelKey) }}</span>
          </button>
        </nav>
      <div
        ref="bodyEl"
        class="settings__body"
        :data-active-cat="searching ? undefined : activeCategory"
        :data-searching="searching ? '' : undefined"
      >
        <h2 v-if="!searching" class="settings__page-title">{{ t(activeCategoryLabelKey) }}</h2>
        <template v-if="searching">
          <h2
            v-for="(c, i) in categories"
            v-show="catsWithHits.has(c.id)"
            :key="'sg-' + c.id"
            class="settings__search-group"
            :style="{ order: i * 2 }"
          ><Icons class="settings__search-group-icon" :name="c.icon" :size="14" />{{ t(c.labelKey) }}</h2>
          <p v-if="searchHitCount === 0" class="settings__search-empty">
            {{ t('settings.searchEmpty', { q: searchQuery.trim() }) }}
          </p>
        </template>
        <section data-cat="basics">
          <label>{{ t('settings.language') }}</label>
          <select
            :value="settings.language"
            @change="settings.setLanguage(($event.target as HTMLSelectElement).value as 'en' | 'zh' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'pt' | 'it' | 'pl' | 'nl' | 'tr' | 'sv' | 'uk' | 'ru')"
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="de">Deutsch</option>
            <option value="fr">Français</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
            <option value="it">Italiano</option>
            <option value="pl">Polski</option>
            <option value="nl">Nederlands</option>
            <option value="tr">Türkçe</option>
            <option value="sv">Svenska</option>
            <option value="uk">Українська</option>
            <option value="ru">Русский</option>
          </select>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.theme') }}</label>
          <select
            :value="settings.theme"
            @change="settings.setTheme(($event.target as HTMLSelectElement).value as Theme)"
          >
            <option v-for="th in themeLabels" :key="th.value" :value="th.value">{{ th.label }}</option>
          </select>
          <!-- #282 — the reporter picked "Dark (One Dark)" and the app stayed
               light (his screenshots read #e6e5e0, which is Soft UI's --bg to
               the byte). It was doing exactly what it was told: 14 of the 15
               marketplace themes declare their palette for `:root,
               :root[data-theme="light"], :root[data-theme="dark"]` in one
               rule, and custom-theme.ts injects them after the app bundle —
               so they win in BOTH slots and this dropdown stops changing a
               single colour. Nothing said so: the custom-CSS control lives
               under Advanced, three categories from here. Say it where the
               choice is made, and make undoing it one click. -->
          <p v-if="customThemeName" class="setting-hint setting-hint--warn">
            {{ t('settings.customThemeOverrides', { name: customThemeName }) }}
            <button type="button" class="hint-btn" @click="settings.setCustomCssPath('')">
              {{ t('settings.customThemeDisable') }}
            </button>
          </p>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.fontFamily') }}</label>
          <select :value="fontFamilySelectValue" @change="onSelectFontFamily(($event.target as HTMLSelectElement).value)">
            <option v-for="f in fontFamilies" :key="f.label" :value="f.value">{{ f.label }}</option>
            <option value="__custom__">{{ t('settings.customFont') }}</option>
          </select>
          <input
            v-if="fontFamilySelectValue === '__custom__'"
            type="text"
            :placeholder="t('settings.customFontPlaceholder')"
            :value="customFontFamily"
            @input="onCustomFontInput(($event.target as HTMLInputElement).value)"
            class="settings__field settings__field--sub"
          />
          <p class="setting-hint">{{ t('settings.fontFamilyHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.codeFontFamily') }}</label>
          <input
            type="text"
            :placeholder="t('settings.codeFontFamilyPlaceholder')"
            :value="settings.codeFontFamily"
            @input="settings.setCodeFontFamily(($event.target as HTMLInputElement).value)"
            class="settings__field"
          />
          <p class="setting-hint">{{ t('settings.codeFontFamilyHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.fontSize') }}: {{ settings.fontSize }}px</label>
          <input
            type="range"
            min="10"
            max="28"
            :value="settings.fontSize"
            @input="settings.setFontSize(+($event.target as HTMLInputElement).value)"
          />
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.uiFontSize') }}: {{ settings.uiFontSize }}px</label>
          <input
            type="range"
            min="10"
            max="20"
            :value="settings.uiFontSize"
            @input="settings.setUiFontSize(+($event.target as HTMLInputElement).value)"
          />
        </section>

        <section data-cat="basics">
          <label>
            {{ t('settings.globalZoom') }}:
            {{ Math.round((settings.globalZoom || 1) * 100) }}%
          </label>
          <input
            type="range"
            min="0.75"
            max="2.5"
            step="0.05"
            :value="settings.globalZoom"
            @input="settings.setGlobalZoom(+($event.target as HTMLInputElement).value)"
          />
          <p class="setting-hint">
            {{ t('settings.globalZoomHint') }}
            <button
              type="button"
              class="link-button"
              style="margin-left: 8px;"
              @click="settings.resetZoom()"
            >
              {{ t('settings.globalZoomReset') }}
            </button>
          </p>
          <label>
            <input
              type="checkbox"
              :checked="settings.wheelZoomEnabled"
              @change="settings.toggleWheelZoom()"
            />
            {{ t('settings.wheelZoom') }}
          </label>
          <p class="setting-hint">{{ t('settings.wheelZoomHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.wordWrap" @change="settings.toggleWordWrap()" />
            {{ t('settings.wordWrap') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showLineNumbers" @change="settings.toggleLineNumbers()" />
            {{ t('settings.lineNumbers') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.solidCursor" @change="settings.toggleSolidCursor()" />
            {{ t('settings.solidCursor') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.livePreview" @change="settings.toggleLivePreview()" />
            {{ t('settings.livePreview') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.alwaysShowMarkers" @change="settings.toggleAlwaysShowMarkers()" />
            {{ t('settings.alwaysShowMarkers') }}
          </label>
          <div class="hint">{{ t('settings.alwaysShowMarkersHint') }}</div>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.highlightCurrentLine" @change="settings.toggleHighlightCurrentLine()" />
            {{ t('settings.highlightCurrentLine') }}
          </label>
          <div class="hint">{{ t('settings.highlightCurrentLineHint') }}</div>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showOutline" @change="onToggleOutlineGlobal()" />
            {{ t('settings.showOutline') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.outlineSide') }}</label>
          <select
            :value="settings.outlineSide"
            @change="settings.setOutlineSide(($event.target as HTMLSelectElement).value as 'left' | 'right')"
          >
            <option value="left">{{ t('settings.outlineSideLeft') }}</option>
            <option value="right">{{ t('settings.outlineSideRight') }}</option>
          </select>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.outlineMarker') }}</label>
          <select
            :value="settings.outlineMarker"
            @change="settings.setOutlineMarker(($event.target as HTMLSelectElement).value as 'jump' | 'number' | 'none')"
          >
            <option value="jump">{{ t('settings.outlineMarkerJump') }}</option>
            <option value="number">{{ t('settings.outlineMarkerNumber') }}</option>
            <option value="none">{{ t('settings.outlineMarkerNone') }}</option>
          </select>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.previewFitWidth" @change="settings.togglePreviewFitWidth()" />
            {{ t('settings.previewFitWidth') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>{{ t('settings.previewMaxWidth') }}: {{ settings.previewMaxWidth }}px</label>
          <input
            type="range"
            min="480"
            max="1600"
            step="20"
            :value="settings.previewMaxWidth"
            :disabled="settings.previewFitWidth"
            @input="settings.setPreviewMaxWidth(+($event.target as HTMLInputElement).value)"
          />
          <p class="setting-hint">{{ t('settings.previewMaxWidthHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.limitEditorWidth" @change="settings.toggleLimitEditorWidth()" />
            {{ t('settings.limitEditorWidth') || 'Limit editor width (readable column)' }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.codeBlockLineNumbers"
              @change="settings.toggleCodeBlockLineNumbers()"
            />
            {{ t('settings.codeBlockLineNumbers') }}
          </label>
          <p class="setting-hint">{{ t('settings.codeBlockLineNumbersHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.foldingEnabled"
              @change="settings.toggleFolding()"
            />
            {{ t('settings.folding') }}
          </label>
          <p class="setting-hint">{{ t('settings.foldingHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.codeBlockWrap"
              @change="settings.toggleCodeBlockWrap()"
            />
            {{ t('settings.codeBlockWrap') }}
          </label>
          <p class="setting-hint">{{ t('settings.codeBlockWrapHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.explorerFullNames"
              @change="settings.toggleExplorerFullNames()"
            />
            {{ t('settings.explorerFullNames') }}
          </label>
          <p class="setting-hint">{{ t('settings.explorerFullNamesHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.explorerDoubleClickFolders"
              @change="settings.toggleExplorerDoubleClickFolders()"
            />
            {{ t('settings.explorerDoubleClickFolders') }}
          </label>
          <p class="setting-hint">{{ t('settings.explorerDoubleClickFoldersHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.explorerFollowActive"
              @change="settings.toggleExplorerFollowActive()"
            />
            {{ t('settings.explorerFollowActive') }}
          </label>
          <p class="setting-hint">{{ t('settings.explorerFollowActiveHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.explorerShowHidden"
              @change="settings.toggleExplorerShowHidden()"
            />
            {{ t('settings.explorerShowHidden') }}
          </label>
          <p class="setting-hint">{{ t('settings.explorerShowHiddenHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.splitLiveSync"
              @change="settings.toggleSplitLiveSync()"
            />
            {{ t('settings.splitLiveSync') }}
          </label>
          <p class="setting-hint">{{ t('settings.splitLiveSyncHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.distinctSplitPanes"
              @change="settings.toggleDistinctSplitPanes()"
            />
            {{ t('settings.distinctSplitPanes') }}
          </label>
          <p class="setting-hint">{{ t('settings.distinctSplitPanesHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.markdownHardBreaks"
              @change="settings.toggleMarkdownHardBreaks()"
            />
            {{ t('settings.markdownHardBreaks') }}
          </label>
          <p class="setting-hint">{{ t('settings.markdownHardBreaksHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.smartQuotes"
              @change="settings.toggleSmartQuotes()"
            />
            {{ t('settings.smartQuotes') }}
          </label>
          <p class="setting-hint">{{ t('settings.smartQuotesHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.markdownAutoNumberHeadings"
              @change="settings.toggleMarkdownAutoNumberHeadings()"
            />
            {{ t('settings.markdownAutoNumberHeadings') }}
          </label>
          <p class="setting-hint">{{ t('settings.markdownAutoNumberHeadingsHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.plantumlEnabled"
              @change="settings.togglePlantuml()"
            />
            {{ t('settings.plantuml') }}
          </label>
          <p class="setting-hint">{{ t('settings.plantumlHint') }}</p>
          <input
            v-if="settings.plantumlEnabled"
            type="text"
            :value="settings.plantumlServer"
            :placeholder="'https://www.plantuml.com/plantuml'"
            spellcheck="false"
            style="margin-top: 6px; width: 100%"
            @change="settings.setPlantumlServer(($event.target as HTMLInputElement).value)"
          />
        </section>

        <section data-cat="basics">
          <label>
            <input
              type="checkbox"
              :checked="settings.readingByDefaultOnMobile"
              @change="settings.toggleReadingByDefaultOnMobile()"
            />
            {{ t('reading.readingByDefaultOnMobile') }}
          </label>
          <p class="setting-hint">{{ t('reading.readingByDefaultOnMobileHint') }}</p>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showFileTree" @change="settings.toggleFileTree()" />
            {{ t('settings.showFileTree') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showBacklinks" @change="settings.toggleBacklinks()" />
            {{ t('settings.showBacklinks') }}
          </label>
        </section>

        <section data-cat="basics">
          <label>
            <input type="checkbox" :checked="settings.showTagsPanel" @change="settings.toggleTagsPanel()" />
            {{ t('settings.showTagsPanel') }}
          </label>
        </section>

        <section data-cat="writing">
          <h3 class="settings__group-title">
            {{ t('writingStats.settingsHeading') }}
          </h3>
          <label>
            <input
              type="checkbox"
              :checked="settings.showWritingStats"
              @change="settings.toggleWritingStats()"
            />
            {{ t('writingStats.showInStatusBar') }}
          </label>
          <label style="margin-top: 6px;">
            <input
              type="checkbox"
              :checked="settings.showWorkspaceDailyTotal"
              @change="settings.toggleWorkspaceDailyTotal()"
              :disabled="!settings.showWritingStats"
            />
            {{ t('writingStats.showWorkspaceDailyTotal') }}
          </label>
          <p class="setting-hint">
            {{ t('writingStats.frontMatterHint') }}
          </p>
        </section>

        <!-- #230 — Android has no libgit2, so the whole Sync tab would be a
             row of buttons that answer "Command … not found". Say so plainly
             instead of shipping dead controls. -->
        <section v-if="!gitBackend" data-cat="sync">
          <h3 class="settings__group-title">
            {{ t('settings.catSync') }}
          </h3>
          <p class="setting-hint">
            {{ t('settings.syncUnsupportedAndroid') }}
          </p>
        </section>

        <section v-if="gitBackend" data-cat="sync">
          <h3 class="settings__group-title">
            {{ t('settings.versionHistoryHeading') }}
          </h3>
          <label>
            <input type="checkbox" :checked="settings.autoGitEnabled" @change="settings.toggleAutoGit()" />
            {{ t('settings.autoGitEnabled') }}
          </label>
          <p class="setting-hint">
            {{ withChord('settings.autoGitHelp', 'file.save') }}
          </p>
        </section>

        <!-- v2.6.1 cloud-folder banner. Self-hides if the workspace isn't
             inside a known cloud-sync folder. -->
        <div v-if="gitBackend" data-cat="sync"><CloudFolderBanner /></div>

        <!-- v2.6 GitHub sync — sits right under AutoGit since it pushes the
             same commits AutoGit produces; reads top-down as one story. -->
        <div v-if="gitBackend" data-cat="sync"><GithubSyncSettings /></div>

        <!-- v3.0 — proxy URL (network-level, applies to libgit2 push/pull
             across GitHub / GitLab / Gitea). Pulled out of GithubSyncSettings
             so users hitting timeouts find it at the top of the Sync tab. -->
        <div v-if="gitBackend" data-cat="sync"><ProxySettings /></div>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.spellcheckEnabled" @change="settings.toggleSpellcheckEnabled()" />
            {{ t('settings.spellcheckEnabled') }}
          </label>
          <!-- #246 — only en_US ships with the app; anything the user drops in
               `<config>/dictionaries/` shows up here. Without this the checker
               flagged every word for non-English writers. It belongs to the
               Hunspell checkbox: it used to hang off the browser spell-check
               toggle below, so ticking this box revealed nothing. -->
          <div v-if="settings.spellcheckEnabled" class="ghs-row" style="align-items:center; gap:8px; margin-top:6px;">
            <span>{{ t('settings.spellcheckLang') }}</span>
            <select
              class="ghs-select"
              :value="settings.spellcheckLang"
              @focus="refreshSpellDicts"
              @change="settings.setSpellcheckLang(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="code in spellDicts" :key="code" :value="code">{{ code }}</option>
            </select>
            <button type="button" class="link-button" @click="openDictsFolder">
              {{ t('settings.spellcheckAddDict') }}
            </button>
          </div>
          <p v-if="settings.spellcheckEnabled" class="setting-hint">{{ t('settings.spellcheckLangHint') }}</p>
        </section>

        <section data-cat="integrations">
          <h3 class="settings__group-title">
            {{ t('rag.settingsHeading') }}
          </h3>
          <label>
            <input
              type="checkbox"
              :checked="settings.ragEnabled"
              @change="onToggleRagEnabled()"
            />
            {{ t('rag.enable') }}
          </label>
          <p class="setting-hint">
            {{ t('rag.enableHint') }}
          </p>
          <div
            v-if="settings.ragEnabled && workspace.currentFolder"
            style="margin-top: 8px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;"
          >
            <span class="settings__unit">
              <template v-if="rag.status?.ready">
                {{ t('rag.statusReady', {
                  indexed: String(rag.status.indexed_files),
                  total: String(rag.status.total_files),
                  chunks: String(rag.status.total_chunks),
                  backend: rag.status.backend,
                }) }}
              </template>
              <template v-else>
                {{ t('rag.statusEmpty') }}
              </template>
            </span>
            <button
              :disabled="rag.indexing"
              @click="onReindexNow"
              style="font-size: 11px; padding: 4px 10px;"
            >
              {{ rag.indexing ? t('rag.indexing') : t('rag.reindexNow') }}
            </button>
          </div>
        </section>

        <section v-if="!isPhoneOrTablet" data-cat="integrations">
          <label>
            <input
              type="checkbox"
              :checked="settings.quickCaptureEnabled"
              @change="settings.toggleQuickCapture()"
            />
            {{ t('settings.quickCapture') }}
          </label>
          <p class="setting-hint">{{ t('settings.quickCaptureHint') }}</p>
          <input
            type="text"
            :value="settings.quickCaptureShortcut"
            :disabled="!settings.quickCaptureEnabled"
            spellcheck="false"
            placeholder="CmdOrCtrl+Alt+M"
            @change="settings.setQuickCaptureShortcut(($event.target as HTMLInputElement).value)"
            class="settings__field settings__field--sub"
          />
          <p v-if="quickCaptureError" class="setting-hint" style="color: var(--danger);">
            {{ t('settings.quickCaptureFailed', { error: quickCaptureError }) }}
          </p>
        </section>

        <section data-cat="export">
          <label>{{ t('settings.docxPreset') }}</label>
          <select
            :value="settings.docxPreset"
            @change="settings.setDocxPreset(($event.target as HTMLSelectElement).value as 'plain' | 'report' | 'academic')"
          >
            <option value="plain">{{ t('settings.docxPresetPlain') }}</option>
            <option value="report">{{ t('settings.docxPresetReport') }}</option>
            <option value="academic">{{ t('settings.docxPresetAcademic') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings.docxPresetHint') }}</p>
        </section>

        <section data-cat="export">
          <label>{{ t('settings.printTheme') }}</label>
          <select
            :value="settings.printTheme"
            @change="settings.setPrintTheme(($event.target as HTMLSelectElement).value as 'light' | 'dark' | 'follow')"
          >
            <option value="light">{{ t('settings.printThemeLight') }}</option>
            <option value="dark">{{ t('settings.printThemeDark') }}</option>
            <option value="follow">{{ t('settings.printThemeFollow') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings.printThemeHint') }}</p>
        </section>

        <!-- v2.5 F3: PDF / print export defaults. #347 — the heading sits right
             above its controls; it used to be separated from them by the
             Word template and print theme, and read as an empty section. -->
        <section data-cat="export">
          <h3 class="settings__group-title">
            {{ t('settings.pdfDefaults.heading') }}
          </h3>
          <p class="setting-hint">{{ t('settings.pdfDefaults.headingHint') }}</p>
        </section>

        <section data-cat="export">
          <label>{{ t('settings.pdfDefaults.pageSize') }}</label>
          <select
            :value="settings.pdfDefaults.pageSize"
            @change="settings.setPdfDefaults({ pageSize: ($event.target as HTMLSelectElement).value as any })"
          >
            <option value="Auto">{{ t('settings.pdfDefaults.pageSizeAuto') }}</option>
            <option value="A4">A4 (210 × 297 mm)</option>
            <option value="A5">A5 (148 × 210 mm)</option>
            <option value="Letter">{{ t('settings.pdfDefaults.letter') }} (8.5 × 11 in)</option>
            <option value="Legal">{{ t('settings.pdfDefaults.legal') }} (8.5 × 14 in)</option>
            <option value="Custom">{{ t('settings.pdfDefaults.custom') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings.pdfDefaults.pageSizeHint') }}</p>
          <div
            v-if="settings.pdfDefaults.pageSize === 'Custom'"
            class="row"
            style="gap: 6px; align-items: center; margin-top: 6px;"
          >
            <input
              type="number"
              min="50"
              max="500"
              step="1"
              :value="settings.pdfDefaults.customWidthMm"
              @input="onCustomMmChange('customWidthMm', ($event.target as HTMLInputElement).value)"
              class="settings__field settings__field--num"
              :aria-label="t('settings.pdfDefaults.widthMm')"
            />
            <span class="settings__unit">×</span>
            <input
              type="number"
              min="50"
              max="500"
              step="1"
              :value="settings.pdfDefaults.customHeightMm"
              @input="onCustomMmChange('customHeightMm', ($event.target as HTMLInputElement).value)"
              class="settings__field settings__field--num"
              :aria-label="t('settings.pdfDefaults.heightMm')"
            />
            <span class="settings__unit">mm</span>
          </div>
        </section>

        <section data-cat="export">
          <label>{{ t('settings.pdfDefaults.margin') }}</label>
          <select
            :value="settings.pdfDefaults.margin"
            @change="settings.setPdfDefaults({ margin: ($event.target as HTMLSelectElement).value as any })"
          >
            <option value="Narrow">{{ t('settings.pdfDefaults.marginNarrow') }} (10 mm)</option>
            <option value="Normal">{{ t('settings.pdfDefaults.marginNormal') }} (15 mm)</option>
            <option value="Wide">{{ t('settings.pdfDefaults.marginWide') }} (25 mm)</option>
            <option value="Custom">{{ t('settings.pdfDefaults.custom') }}</option>
          </select>
          <div
            v-if="settings.pdfDefaults.margin === 'Custom'"
            style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; margin-top: 6px;"
          >
            <label class="settings__mm">
              <span class="settings__mm-label">{{ t('settings.pdfDefaults.marginTop') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginTopMm"
                @input="onCustomMmChange('customMarginTopMm', ($event.target as HTMLInputElement).value)"
                class="settings__field settings__field--num"
              />
              <span class="settings__unit">mm</span>
            </label>
            <label class="settings__mm">
              <span class="settings__mm-label">{{ t('settings.pdfDefaults.marginRight') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginRightMm"
                @input="onCustomMmChange('customMarginRightMm', ($event.target as HTMLInputElement).value)"
                class="settings__field settings__field--num"
              />
              <span class="settings__unit">mm</span>
            </label>
            <label class="settings__mm">
              <span class="settings__mm-label">{{ t('settings.pdfDefaults.marginBottom') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginBottomMm"
                @input="onCustomMmChange('customMarginBottomMm', ($event.target as HTMLInputElement).value)"
                class="settings__field settings__field--num"
              />
              <span class="settings__unit">mm</span>
            </label>
            <label class="settings__mm">
              <span class="settings__mm-label">{{ t('settings.pdfDefaults.marginLeft') }}</span>
              <input
                type="number" min="5" max="100" step="1"
                :value="settings.pdfDefaults.customMarginLeftMm"
                @input="onCustomMmChange('customMarginLeftMm', ($event.target as HTMLInputElement).value)"
                class="settings__field settings__field--num"
              />
              <span class="settings__unit">mm</span>
            </label>
          </div>
          <p v-if="pdfMmRangeError" class="setting-hint" style="color: var(--danger, #d12);">
            {{ t('settings.pdfDefaults.mmRangeError') }}
          </p>
        </section>

        <section data-cat="export">
          <label>{{ t('settings.pdfDefaults.fontFamily') }}</label>
          <select
            :value="pdfFontSelectValue"
            @change="onSelectPdfFont(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('settings.pdfDefaults.fontInherit') }}</option>
            <option v-for="f in fontFamilies" :key="f.label" :value="f.value">{{ f.label }}</option>
          </select>
        </section>

        <section data-cat="export">
          <label>{{ t('settings.pdfDefaults.fontSize') }}: {{ settings.pdfDefaults.fontSize }}pt</label>
          <input
            type="range"
            min="9"
            max="16"
            step="1"
            :value="settings.pdfDefaults.fontSize"
            @input="settings.setPdfDefaults({ fontSize: +($event.target as HTMLInputElement).value })"
          />
        </section>

        <section data-cat="export">
          <label>
            <input
              type="checkbox"
              :checked="settings.pdfDefaults.footer"
              @change="settings.setPdfDefaults({ footer: ($event.target as HTMLInputElement).checked })"
            />
            {{ t('settings.pdfDefaults.footer') }}
          </label>
        </section>

        <section data-cat="export">
          <label>
            <input
              type="checkbox"
              :checked="settings.pdfDefaults.toc"
              @change="settings.setPdfDefaults({ toc: ($event.target as HTMLInputElement).checked })"
            />
            {{ t('settings.pdfDefaults.toc') }}
          </label>
        </section>

        <section data-cat="export">
          <label>{{ t('settings.pdfDefaults.codeTheme') }}</label>
          <select
            :value="settings.pdfDefaults.codeTheme"
            @change="settings.setPdfDefaults({ codeTheme: ($event.target as HTMLSelectElement).value as any })"
          >
            <option value="preview">{{ t('settings.pdfDefaults.codeThemePreview') }}</option>
            <option value="light">{{ t('settings.pdfDefaults.codeThemeLight') }}</option>
            <option value="dark">{{ t('settings.pdfDefaults.codeThemeDark') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings.pdfDefaults.frontmatterHint') }}</p>
        </section>

        <section data-cat="export">
          <label>
            <input
              type="checkbox"
              :checked="settings.imageExportBranding"
              @change="settings.toggleImageExportBranding()"
            />
            {{ t('settings.imageExportBranding') }}
          </label>
          <p class="setting-hint">{{ t('settings.imageExportBrandingHint') }}</p>
        </section>

        <section data-cat="writing">
          <label>{{ t('settings.attachmentMode') }}</label>
          <select
            :value="settings.attachmentMode"
            @change="settings.setAttachmentMode(($event.target as HTMLSelectElement).value as 'shared' | 'per-file' | 'custom')"
          >
            <option value="shared">{{ t('settings.attachmentModeShared') }}</option>
            <option value="per-file">{{ t('settings.attachmentModePerFile') }}</option>
            <option value="custom">{{ t('settings.attachmentModeCustom') }}</option>
          </select>
          <p class="setting-hint">{{ t('settings.attachmentModeHint') }}</p>
        </section>

        <section data-cat="writing" v-if="settings.attachmentMode === 'shared'">
          <label>{{ t('settings.assetsDirName') }}</label>
          <input
            type="text"
            :value="settings.assetsDirName"
            @change="settings.setAssetsDirName(($event.target as HTMLInputElement).value)"
            placeholder="_assets"
            class="settings__field"
          />
          <p class="setting-hint">{{ t('settings.assetsDirNameHint') }}</p>
        </section>

        <section data-cat="writing" v-if="settings.attachmentMode === 'custom'">
          <label>{{ t('settings.attachmentCustomPath') }}</label>
          <input
            type="text"
            :value="settings.attachmentCustomPath"
            @change="settings.setAttachmentCustomPath(($event.target as HTMLInputElement).value)"
            placeholder="./images/${filename}/"
            class="settings__field"
          />
          <p class="setting-hint">{{ t('settings.attachmentCustomPathHint') }}</p>
        </section>

        <!-- 图床 / image upload (external image hosting) — like Typora / MarkText.
             Instead of (or alongside) copying a pasted image locally, upload it
             to an image host and insert the returned URL. -->
        <section data-cat="writing">
          <label>{{ t('settings.imageUploaderSection') }}</label>
          <select
            :value="settings.imageUploader"
            @change="settings.setImageUpload({ imageUploader: ($event.target as HTMLSelectElement).value as 'none' | 'picgo' | 'command' | 'smms' | 's3' | 'github' })"
          >
            <option value="none">{{ t('settings.imageUploaderNone') }}</option>
            <option value="picgo">{{ t('settings.imageUploaderPicgo') }}</option>
            <option value="command">{{ t('settings.imageUploaderCommand') }}</option>
            <option value="smms">{{ t('settings.imageUploaderSmms') }}</option>
            <option value="s3">{{ t('settings.imageUploaderS3') }}</option>
            <option value="github">{{ t('settings.imageUploaderGithub') }}</option>
          </select>
        </section>

        <template v-if="settings.imageUploader !== 'none'">
          <section data-cat="writing">
            <label>
              <input
                type="checkbox"
                :checked="settings.imageUploadOnPaste"
                @change="settings.setImageUpload({ imageUploadOnPaste: ($event.target as HTMLInputElement).checked })"
              />
              {{ t('settings.imageUploadOnPaste') }}
            </label>
            <p class="setting-hint">{{ t('settings.imageUploadOnPasteHint') }}</p>
          </section>
          <section data-cat="writing">
            <label>
              <input
                type="checkbox"
                :checked="settings.imageUploadKeepLocal"
                @change="settings.setImageUpload({ imageUploadKeepLocal: ($event.target as HTMLInputElement).checked })"
              />
              {{ t('settings.imageUploadKeepLocal') }}
            </label>
            <p class="setting-hint">{{ t('settings.imageUploadKeepLocalHint') }}</p>
          </section>

          <!-- PicGo -->
          <section data-cat="writing" v-if="settings.imageUploader === 'picgo'">
            <label>{{ t('settings.picgoEndpoint') }}</label>
            <input
              class="img-field"
              type="text"
              :value="settings.picgoEndpoint"
              @change="settings.setImageUpload({ picgoEndpoint: ($event.target as HTMLInputElement).value })"
              placeholder="http://127.0.0.1:36677/upload"
            />
            <p class="setting-hint">{{ t('settings.picgoEndpointHint') }}</p>
          </section>

          <!-- Custom command -->
          <section data-cat="writing" v-if="settings.imageUploader === 'command'">
            <label>{{ t('settings.imageUploadCommand') }}</label>
            <input
              class="img-field"
              type="text"
              :value="settings.imageUploadCommand"
              @change="settings.setImageUpload({ imageUploadCommand: ($event.target as HTMLInputElement).value })"
              placeholder="picgo upload {path}"
            />
            <p class="setting-hint">{{ t('settings.imageUploadCommandHint') }}</p>
          </section>

          <!-- SM.MS -->
          <section data-cat="writing" v-if="settings.imageUploader === 'smms'">
            <label>{{ t('settings.smmsToken') }}</label>
            <input
              class="img-field"
              type="password"
              :value="settings.smmsToken"
              @change="settings.setImageUpload({ smmsToken: ($event.target as HTMLInputElement).value })"
            />
            <p class="setting-hint">{{ t('settings.smmsTokenHint') }}</p>
          </section>

          <!-- S3-compatible -->
          <template v-if="settings.imageUploader === 's3'">
            <section data-cat="writing">
              <label>{{ t('settings.s3Endpoint') }}</label>
              <input class="img-field" type="text" :value="settings.s3Endpoint" @change="settings.setImageUpload({ s3Endpoint: ($event.target as HTMLInputElement).value })" placeholder="https://s3.amazonaws.com" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3Region') }}</label>
              <input class="img-field" type="text" :value="settings.s3Region" @change="settings.setImageUpload({ s3Region: ($event.target as HTMLInputElement).value })" placeholder="us-east-1" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3Bucket') }}</label>
              <input class="img-field" type="text" :value="settings.s3Bucket" @change="settings.setImageUpload({ s3Bucket: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3AccessKeyId') }}</label>
              <input class="img-field" type="text" :value="settings.s3AccessKeyId" @change="settings.setImageUpload({ s3AccessKeyId: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3SecretAccessKey') }}</label>
              <input class="img-field" type="password" :value="settings.s3SecretAccessKey" @change="settings.setImageUpload({ s3SecretAccessKey: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3PathPrefix') }}</label>
              <input class="img-field" type="text" :value="settings.s3PathPrefix" @change="settings.setImageUpload({ s3PathPrefix: ($event.target as HTMLInputElement).value })" placeholder="images/" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.s3CustomDomain') }}</label>
              <input class="img-field" type="text" :value="settings.s3CustomDomain" @change="settings.setImageUpload({ s3CustomDomain: ($event.target as HTMLInputElement).value })" placeholder="https://cdn.example.com" />
            </section>
            <section data-cat="writing">
              <label>
                <input type="checkbox" :checked="settings.s3UsePathStyle" @change="settings.setImageUpload({ s3UsePathStyle: ($event.target as HTMLInputElement).checked })" />
                {{ t('settings.s3UsePathStyle') }}
              </label>
            </section>
          </template>

          <!-- GitHub repo + CDN -->
          <template v-if="settings.imageUploader === 'github'">
            <section data-cat="writing">
              <label>{{ t('settings.ghImageRepo') }}</label>
              <input class="img-field" type="text" :value="settings.ghImageRepo" @change="settings.setImageUpload({ ghImageRepo: ($event.target as HTMLInputElement).value })" placeholder="owner/repo" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImageBranch') }}</label>
              <input class="img-field" type="text" :value="settings.ghImageBranch" @change="settings.setImageUpload({ ghImageBranch: ($event.target as HTMLInputElement).value })" placeholder="main" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImageToken') }}</label>
              <input class="img-field" type="password" :value="settings.ghImageToken" @change="settings.setImageUpload({ ghImageToken: ($event.target as HTMLInputElement).value })" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImagePathPrefix') }}</label>
              <input class="img-field" type="text" :value="settings.ghImagePathPrefix" @change="settings.setImageUpload({ ghImagePathPrefix: ($event.target as HTMLInputElement).value })" placeholder="images/" />
            </section>
            <section data-cat="writing">
              <label>{{ t('settings.ghImageCdn') }}</label>
              <select
                :value="settings.ghImageCdn"
                @change="settings.setImageUpload({ ghImageCdn: ($event.target as HTMLSelectElement).value as 'raw' | 'jsdelivr' })"
              >
                <option value="jsdelivr">{{ t('settings.ghImageCdnJsdelivr') }}</option>
                <option value="raw">{{ t('settings.ghImageCdnRaw') }}</option>
              </select>
            </section>
          </template>
        </template>

        <section data-cat="keys">
          <p class="setting-hint" style="margin-top:0;">{{ t('settings.keysHint') }}</p>
          <div v-if="intercepted.length" class="kb-clash">
            <p class="kb-clash__title">⚠ {{ t('settings.keysInterceptedTitle') }}</p>
            <p class="kb-clash__body">{{ t('settings.keysInterceptedBody') }}</p>
            <ul class="kb-clash__list">
              <li v-for="b in intercepted" :key="b.action.id">
                <kbd class="kb-chip">{{ formatCombo(b.combo, macKeys) }}</kbd>
                {{ actionLabel(b.action) }}
                <span class="kb-clash__source">— {{ b.source }}</span>
                <span class="kb-clash__arrow">→</span>
                <kbd class="kb-chip">{{ formatCombo(b.alternative, macKeys) }}</kbd>
              </li>
            </ul>
            <button class="kb-btn kb-btn--wide" @click="applyHotkeyCompatPreset()">
              {{ t('settings.keysApplyCompat') }}
            </button>
          </div>
          <div class="kb-clash kb-clash--neutral">
            <p class="kb-clash__title">{{ t('settings.keysWriterTitle') }}</p>
            <p class="kb-clash__body">{{ t('settings.keysWriterBody', writerPresetKeys) }}</p>
            <button v-if="!writerPresetOn" class="kb-btn kb-btn--wide" @click="applyWriterPreset()">
              {{ t('settings.keysWriterApply', writerPresetKeys) }}
            </button>
            <button v-else class="kb-btn kb-btn--wide" @click="undoWriterPreset()">
              ✓ {{ t('settings.keysWriterUndo') }}
            </button>
          </div>
          <div class="kb-clash kb-clash--neutral" data-preset="typora">
            <p class="kb-clash__title">{{ t('settings.keysTyporaTitle') }}</p>
            <p class="kb-clash__body">{{ t('settings.keysTyporaBody', typoraKeys) }}</p>
            <button v-if="!typoraOn" class="kb-btn kb-btn--wide" @click="applyTyporaPreset()">
              {{ t('settings.keysTyporaApply') }}
            </button>
            <button v-else class="kb-btn kb-btn--wide" @click="undoTyporaPreset()">
              ✓ {{ t('settings.keysTyporaUndo') }}
            </button>
          </div>
          <label class="kb-hints-toggle">
            <input type="checkbox" :checked="settings.formatHints" @change="settings.toggleFormatHints()" />
            {{ t('settings.formatHints') }}
          </label>
          <input
            v-model="keyQuery"
            class="kb-search"
            type="search"
            :placeholder="t('settings.keysSearch')"
          />
          <p v-if="!keyGroups.length" class="setting-hint">{{ t('settings.keysNoMatch') }}</p>
          <div v-for="group in keyGroups" :key="group.key" class="kb-group">
            <h4 class="kb-group__title">{{ t('settings.keysCat' + group.key.charAt(0).toUpperCase() + group.key.slice(1)) }}</h4>
            <div v-for="action in group.items" :key="action.id" class="kb-row">
              <span class="kb-row__label">{{ actionLabel(action) }}</span>
              <span class="kb-row__combos">
                <template v-if="recordingAction === action.id">
                  <kbd class="kb-chip kb-chip--recording">{{ t('settings.keysRecording') }}</kbd>
                </template>
                <template v-else-if="actionCombos(action).length">
                  <kbd
                    v-for="c in actionCombos(action)"
                    :key="c"
                    class="kb-chip"
                    :class="{ 'kb-chip--intercepted': interceptedIds.has(action.id) }"
                    :title="
                      interceptedIds.has(action.id)
                        ? t('settings.keysInterceptedBy', { source: interceptionFor(action)?.source || '' })
                        : undefined
                    "
                  >{{ c }}<span v-if="interceptedIds.has(action.id)" class="kb-chip__warn">⚠</span></kbd>
                </template>
                <span v-else class="kb-row__unbound">{{ t('settings.keysUnbound') }}</span>
              </span>
              <span class="kb-row__actions">
                <button
                  class="kb-btn"
                  :disabled="recordingAction !== null && recordingAction !== action.id"
                  @click="recordingAction === action.id ? stopRecording() : startRecording(action.id)"
                >{{ recordingAction === action.id ? t('settings.keysCancel') : t('settings.keysChange') }}</button>
                <button class="kb-btn" @click="settings.setKeybinding(action.id, null)">{{ t('settings.keysUnbind') }}</button>
                <button
                  class="kb-btn"
                  :disabled="!isCustomised(action)"
                  @click="settings.setKeybinding(action.id, undefined)"
                >{{ t('settings.keysReset') }}</button>
              </span>
            </div>
          </div>
          <p v-if="recordError" class="kb-error">{{ recordError }}</p>
          <button class="kb-btn kb-btn--wide" @click="settings.resetKeybindings()">{{ t('settings.keysResetAll') }}</button>
        </section>

        <section data-cat="advanced">
          <label>{{ t('settings.dailyNotesFolder') }}</label>
          <input
            type="text"
            :value="settings.dailyNotesFolder"
            @input="settings.setDailyNotesFolder(($event.target as HTMLInputElement).value)"
            placeholder="Daily"
            class="settings__field"
          />
        </section>

        <section data-cat="advanced">
          <label>{{ t('settings.dailyNotesFormat') }}</label>
          <input
            type="text"
            :value="settings.dailyNotesFormat"
            @input="settings.setDailyNotesFormat(($event.target as HTMLInputElement).value)"
            placeholder="YYYY-MM-DD.md"
            class="settings__field"
          />
        </section>

        <div data-cat="export"><CitationPickerSettings /></div>

        <!-- App Store builds strip the AI / Agent / Recipes / CostMeter
             surface under Guideline 3.1.1 (BYOK API keys unlocking paid
             functionality). The GitHub Developer ID build keeps them. -->
        <div v-if="!IS_APP_STORE_BUILD" data-cat="integrations"><AISettings
          :enabled="settings.aiEnabled"
          :provider="(settings.aiProvider as any)"
          :model="settings.aiModel"
          :base-url="settings.aiBaseUrl"
          @update:enabled="settings.toggleAiEnabled()"
          @update:provider="(v: string) => settings.setAiProvider(v)"
          @update:model="(v: string) => settings.setAiModel(v)"
          @update:baseUrl="(v: string) => settings.setAiBaseUrl(v)"
        /></div>

        <!-- v4.0: BYOK cost meter — sits under AI so users see "your spend"
             right below "your provider key". -->
        <div v-if="!IS_APP_STORE_BUILD" data-cat="integrations"><CostMeterSettings /></div>

        <!-- v2.4: Integrations (CLI + MCP). -->
        <div data-cat="integrations"><IntegrationsSettings /></div>

        <!-- v4.0 Pillar 2: Agent Recipes. -->
        <!-- #230 — recipe_runner is desktop/iOS only (git-backed receipts). -->
        <div v-if="!IS_APP_STORE_BUILD && gitBackend" data-cat="integrations"><RecipesSettings /></div>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.spellCheck" @change="settings.toggleSpellCheck()" />
            {{ t('settings.spellCheck') }}
          </label>
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.focusMode" @change="settings.toggleFocusMode()" />
            {{ t('settings.focusMode') }}
          </label>
          <label>
            <input type="checkbox" :checked="settings.toolbarHidden" @change="settings.toggleToolbarHidden()" />
            {{ t('settings.toolbarHidden') }}
          </label>
          <p class="setting-hint">{{ withChord('settings.toolbarHiddenHint', 'view.toggleToolbar') }}</p>
        </section>

        <section data-cat="writing">
          <h3 class="settings__group-title">
            {{ t('pomodoro.settingsHeading') }}
          </h3>
          <!-- bug/C2 — the "show controls in toolbar" switch went with the
               toolbar chevron it controlled; sessions now start from the
               command palette ("Writing Session (Pomodoro)…") or the chord. -->
          <label>
            <input
              type="checkbox"
              :checked="settings.pomodoroAutoEngageFocus"
              @change="settings.togglePomodoroAutoEngageFocus()"
            />
            {{ t('pomodoro.autoEngageFocus') }}
          </label>
          <p class="setting-hint">
            {{ t('pomodoro.autoEngageFocusHint') }}
          </p>
          <label style="display: block; margin-top: 4px;">{{ t('pomodoro.defaultDuration') }}</label>
          <select
            :value="String(settings.pomodoroDefaultMinutes)"
            @change="(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === 'custom') return;
              settings.setPomodoroDefaultMinutes(parseInt(v, 10));
            }"
            style="margin-top: 4px;"
          >
            <option value="25">25 {{ t('pomodoro.minShort') }}</option>
            <option value="50">50 {{ t('pomodoro.minShort') }}</option>
            <option value="90">90 {{ t('pomodoro.minShort') }}</option>
          </select>
          <input
            type="number"
            min="1"
            max="600"
            :value="settings.pomodoroDefaultMinutes"
            @input="settings.setPomodoroDefaultMinutes(parseInt(($event.target as HTMLInputElement).value, 10) || 25)"
            :aria-label="t('pomodoro.customDurationLabel')"
            class="settings__field settings__field--num" style="margin-left: 8px;"
          />
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.typewriterMode" @change="settings.toggleTypewriterMode()" />
            {{ t('settings.typewriterMode') }}
          </label>
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.vimMode" @change="settings.toggleVimMode()" />
            {{ t('settings.vimMode') }}
          </label>
        </section>

        <section v-if="windowsEditorRuntime" data-cat="writing">
          <label>{{ t('settings.windowsEditorEngine') }}</label>
          <select
            :value="settings.vimMode ? 'codemirror' : settings.windowsEditorEngine"
            :disabled="settings.vimMode"
            @change="settings.setWindowsEditorEngine(($event.target as HTMLSelectElement).value as WindowsEditorEngine)"
          >
            <option value="native">{{ t('settings.windowsEditorEngineNative') }}</option>
            <option value="codemirror">{{ t('settings.windowsEditorEngineCodeMirror') }}</option>
            <option value="auto">{{ t('settings.windowsEditorEngineAuto', { current: autoEngineName }) }}</option>
          </select>
          <p class="setting-hint">
            {{ settings.vimMode ? t('settings.windowsEditorEngineVimHint') : t('settings.windowsEditorEngineHint') }}
          </p>
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.slashCommandsEnabled" @change="settings.toggleSlashCommandsEnabled()" />
            {{ t('settings.slashCommandsEnabled') }}
          </label>
        </section>

        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.fenceLanguageSuggestions" @change="settings.toggleFenceLanguageSuggestions()" />
            {{ t('settings.fenceLanguageSuggestions') }}
          </label>
        </section>

        <!-- v4.6 F6 — Inbox workflow -->
        <section data-cat="writing">
          <label>
            <input type="checkbox" :checked="settings.inboxWorkflowEnabled" @change="settings.toggleInboxWorkflow()" />
            {{ t('inbox.workflowSetting') }}
          </label>
          <div class="setting-hint">
            {{ t('inbox.workflowSettingHint') }}
          </div>
          <label v-if="settings.inboxWorkflowEnabled" style="margin-top: 8px;">
            <input type="checkbox" :checked="settings.autoAdvanceInboxAfterOrganize" @change="settings.toggleAutoAdvanceInbox()" />
            {{ t('inbox.autoAdvanceSetting') }}
          </label>
          <div v-if="settings.inboxWorkflowEnabled" class="setting-hint">
            {{ t('inbox.autoAdvanceSettingHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.restoreSession" @change="settings.toggleRestoreSession()" />
            {{ t('settings.restoreSession') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.restoreSessionHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>{{ t('settings.startupViewMode') }}</label>
          <select
            :value="settings.startupViewMode ?? ''"
            @change="settings.setStartupViewMode((($event.target as HTMLSelectElement).value || null) as any)"
          >
            <option value="">{{ t('settings.startupViewModeLastUsed') }}</option>
            <option value="edit">Edit</option>
            <option value="liveEdit">Live edit</option>
            <option value="split">Split</option>
            <option value="preview">Preview</option>
            <option value="reading">Reading</option>
          </select>
          <p class="setting-hint">{{ t('settings.startupViewModeHint') }}</p>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.perWorkspaceTabs" @change="settings.togglePerWorkspaceTabs()" />
            {{ t('settings.perWorkspaceTabs') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.perWorkspaceTabsHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.autoReloadExternalChanges" @change="settings.toggleAutoReloadExternalChanges()" />
            {{ t('settings.autoReloadExternalChanges') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.autoReloadExternalChangesHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.autoSaveOnBlur" @change="settings.toggleAutoSaveOnBlur()" />
            {{ t('settings.autoSaveOnBlur') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.autoSaveOnBlurHint') }}
          </div>
        </section>

        <section v-if="!isMobilePlatform" data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.openFileInNewWindow" @change="settings.toggleOpenFileInNewWindow()" />
            {{ t('settings.openFileInNewWindow') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.openFileInNewWindowHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.revealInFileTreeOnOpen" @change="settings.toggleRevealInFileTreeOnOpen()" />
            {{ t('settings.revealInFileTreeOnOpen') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.revealInFileTreeOnOpenHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.openLinkedFilesExternally" @change="settings.toggleOpenLinkedFilesExternally()" />
            {{ t('settings.openLinkedFilesExternally') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.openLinkedFilesExternallyHint') }}
          </div>
        </section>

        <section v-if="!isMobilePlatform && !masBuild" data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.autoCheckUpdate" @change="settings.toggleAutoCheckUpdate()" />
            {{ t('settings.autoCheckUpdate') }}
          </label>
          <div class="row" style="gap: 8px; align-items: center; margin-top: 8px;">
            <button :disabled="checkingUpdate" @click="manualCheckUpdate">
              {{ checkingUpdate ? t('settings.checkingUpdate') : t('settings.checkUpdate') }}
            </button>
          </div>
        </section>

        <!-- App Store builds send no usage data at all (lib/telemetry.ts), so
             there is no switch to show. -->
        <section v-if="!IS_APP_STORE_BUILD" data-cat="advanced">
          <label>
            <input type="checkbox" :checked="settings.telemetryEnabled" @change="settings.toggleTelemetry()" />
            {{ t('settings.telemetry') }}
          </label>
          <div class="setting-hint">
            {{ t('settings.telemetryHint') }}
          </div>
        </section>

        <section data-cat="advanced">
          <label>{{ t('settings.customCss') }}</label>
          <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
            <button @click="pickCustomCss">{{ t('settings.pickCss') }}</button>
            <button @click="openThemeMarketplace">{{ t('themes.browseBtn') }}</button>
            <button v-if="settings.customCssPath" @click="settings.setCustomCssPath('')">{{ t('settings.clear') }}</button>
          </div>
          <div v-if="settings.customCssPath" class="css-path-row" style="font-size: 11px; color: var(--text-faint); word-break: break-all; margin-top: 4px;">
            <span>{{ settings.customCssPath }}</span>
            <button type="button" class="refresh-css-btn" :title="t('settings.refreshCss')" :aria-label="t('settings.refreshCss')" :disabled="isCssRefreshing" @click="refreshCustomCss">
              <svg :class="{ 'is-spinning': isCssRefreshing }" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>
          </div>
          <p class="setting-hint">{{ t('themes.browseHint') }}</p>
        </section>

        <section data-cat="advanced">
          <label>{{ t('settings.fileAssoc') }}</label>
          <div class="row" style="gap: 8px; align-items: center;">
            <button
              class="primary-btn"
              :disabled="settingDefault"
              @click="setAsDefault"
            >
              {{ settingDefault ? t('settings.settingDefault') : t('settings.setDefault') }}
            </button>
          </div>
          <div class="setting-hint">
            {{ t('settings.setDefaultHint') }}
          </div>
        </section>

        <!-- v2.4 Integrations: HTTP capture endpoint. -->
        <div data-cat="integrations"><CaptureEndpointSettings /></div>

        <!-- v4.0: Public REST API for non-MCP clients. -->
        <div data-cat="integrations"><RestApiSettings /></div>
      </div>
      </div>
    <!-- v2.5: theme marketplace modal. Lives outside settings__body so it
         overlays the entire viewport; it self-teleports to body so closing
         settings (which unmounts DsModal) closes it too. -->
    <ThemeMarketplace
      :open="themeMarketplaceOpen"
      @close="themeMarketplaceOpen = false"
    />
  </DsModal>
</template>

<style scoped>
/* ── 5.0 Settings (spec §6): macOS System Settings feel ───────────────────
 * 220px navigation with 16px line icons (rows 30px / radius 7, selected
 * --accent-soft + --accent-text); content: a 20/620 page title, then group
 * cards (--bg-elev, radius 10) whose rows are split by hairlines — label on
 * the left, control on the right, help text 12px --text-3 underneath.
 * Card edges come from markGroups() (data-gs / data-ge). */

/* #180 shortcut editor */
.kb-clash {
  border: var(--bd-hair);
  border-color: color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 8%, transparent);
  border-radius: var(--r-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
/* Same box, no alarm: an offer rather than a warning (#296). */
.kb-hints-toggle {
  margin: 2px 0 4px;
}
.kb-search {
  margin-bottom: 4px;
}
.kb-clash--neutral {
  border-color: var(--hairline);
  background: var(--bg);
}
.kb-clash__title {
  margin: 0;
  font-weight: 600;
  font-size: 13px;
}
.kb-clash__body {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
}
.kb-clash__list {
  margin: 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.kb-clash__source {
  color: var(--text-3);
}
.kb-clash__arrow {
  color: var(--text-3);
  padding: 0 2px;
}
.kb-chip--intercepted {
  color: var(--warning);
}
.kb-chip__warn {
  margin-left: 3px;
  font-size: 10px;
}
.kb-group {
  margin-bottom: 6px;
}
.kb-group__title {
  margin: 14px 0 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-3);
}
.kb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  border-bottom: var(--bd-hair);
}
.kb-group .kb-row:last-child {
  border-bottom: 0;
}
.kb-row__label { flex: 1; min-width: 0; font-size: 13px; }
.kb-row__combos { display: flex; gap: 6px; flex-shrink: 0; }
.kb-row__unbound { font-size: 12px; color: var(--text-3); }
/* Chords read as text, not keycaps (same rule as the menus). */
.kb-chip {
  font: 12px/1.6 var(--font-ui, inherit);
  letter-spacing: 0.02em;
  padding: 0 6px;
  border: 0;
  border-radius: var(--r-xs);
  background: var(--fill-1);
  color: var(--text-2);
  white-space: nowrap;
}
.kb-chip--recording {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.kb-row__actions { display: flex; gap: 2px; flex-shrink: 0; }
.kb-btn {
  height: 24px;
  font-size: 12px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  cursor: default;
}
.kb-btn:hover:not(:disabled) { color: var(--text); background: var(--fill-1); }
.kb-btn:disabled { opacity: 0.35; }
.kb-btn--wide {
  height: 28px;
  margin-top: 4px;
  padding: 0 12px;
  font-weight: 560;
  color: var(--text);
  background: var(--fill-1);
  border-radius: var(--r-md);
}
.kb-btn--wide:hover:not(:disabled) { background: var(--fill-2); }
.kb-error { color: var(--danger); font-size: 12px; margin: 8px 0 0; }

/* ── shell ───────────────────────────────────────────────────────────── */
/* DsModal supplies the backdrop / frame / header (title + close). Zero its
   body padding so the two-column nav+body layout fills the panel edge-to-edge,
   and give the panel a fixed working height. */
.settings-modal :deep(.ds-modal__panel) {
  background: var(--bg);
}
.settings-modal :deep(.ds-modal__head) {
  padding-bottom: 12px;
  border-bottom: var(--bd-hair);
}
.settings-modal :deep(.ds-modal__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
}
.settings__layout {
  flex: 1;
  display: flex;
  min-height: 0;
  height: min(600px, 78vh);
}
.settings__nav {
  width: 220px;
  flex-shrink: 0;
  box-sizing: border-box;
  border-right: var(--bd-hair);
  background: var(--bg-sidebar);
  display: flex;
  flex-direction: column;
  padding: 12px 10px;
  gap: 2px;
  overflow-y: auto;
}
.settings__nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  min-height: 30px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 450;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: default;
  text-align: left;
}
.settings__nav-item:hover {
  background: var(--fill-1);
}
.settings__nav-item--active,
.settings__nav-item--active:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 500;
}
.settings__nav-icon {
  flex: none;
  color: var(--text-2);
}
.settings__nav-item--active .settings__nav-icon {
  color: var(--accent-text);
}
.settings__nav-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* v3.0 — single-source-of-truth visibility: each section/component
   gets data-cat="basics|writing|sync|integrations|export|keys|advanced",
   the body's data-active-cat determines which subset renders. Saves
   wrapping every section in v-if.

   Every id in the `categories` array above needs a line in the show-list
   below, or its page renders blank — the hide rule catches it and nothing
   brings it back. That is how #180's `keys` page shipped empty. */
.settings__body[data-active-cat] > [data-cat] {
  display: none;
}
.settings__body[data-active-cat="basics"] > [data-cat="basics"],
.settings__body[data-active-cat="writing"] > [data-cat="writing"],
.settings__body[data-active-cat="sync"] > [data-cat="sync"],
.settings__body[data-active-cat="integrations"] > [data-cat="integrations"],
.settings__body[data-active-cat="export"] > [data-cat="export"],
.settings__body[data-active-cat="keys"] > [data-cat="keys"],
.settings__body[data-active-cat="advanced"] > [data-cat="advanced"] {
  display: block;
}
.settings__body[data-active-cat="basics"] > section[data-cat="basics"],
.settings__body[data-active-cat="writing"] > section[data-cat="writing"],
.settings__body[data-active-cat="sync"] > section[data-cat="sync"],
.settings__body[data-active-cat="integrations"] > section[data-cat="integrations"],
.settings__body[data-active-cat="export"] > section[data-cat="export"],
.settings__body[data-active-cat="keys"] > section[data-cat="keys"],
.settings__body[data-active-cat="advanced"] > section[data-cat="advanced"],
.settings__body[data-searching] > section[data-cat] {
  display: grid;
}

/* ── search ──────────────────────────────────────────────────────────── */
.settings__search {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 24px 12px;
  border-bottom: var(--bd-hair);
}
.settings__search-input {
  flex: 0 1 340px;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  padding: 0 10px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--fill-1);
  border: 0;
  border-radius: var(--r-md);
  outline: none;
}
.settings__search-input::placeholder {
  color: var(--text-3);
}
.settings__search-input:focus {
  background: var(--bg);
  box-shadow: var(--ring);
}
.settings__search-count {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
.settings__search-steps {
  display: inline-flex;
  gap: 2px;
  flex-shrink: 0;
}
.settings__search-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-2);
  background: transparent;
  border: 0;
  border-radius: var(--r-sm);
  cursor: default;
}
.settings__search-step:hover:not(:disabled) {
  color: var(--text);
  background: var(--fill-1);
}
.settings__search-step:disabled {
  opacity: 0.4;
}
:root.narrow-viewport .settings__search-step {
  width: 36px;
  height: 36px;
}
/* Phone: the whole dialog body scrolls, so without this the search box and
   its previous/next buttons scroll away the moment you step to a match.
   Sticky offsets are measured inside the scroller's padding; the negative
   top (DsModal's body padding) pins it to the visible edge instead of
   leaving a strip of settings showing above it. */
:root.narrow-viewport .settings__search {
  position: sticky;
  top: calc(-1 * var(--sp-5, 24px));
  z-index: 2;
  padding-top: 8px;
  background: var(--bg);
}
.settings__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
/* Stepping through matches: a quiet accent ring on the current match, and a
   one-off pulse when it is reached. Reduced motion keeps the ring only. */
.settings__body[data-searching] > [data-hit-current] {
  box-shadow: 0 0 0 2px var(--accent-ring);
}
.settings__body[data-searching] > [data-hit-flash] {
  animation: settings-hit-pulse 1.1s ease-out;
}
@keyframes settings-hit-pulse {
  0% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 30%, transparent);
  }
  100% {
    box-shadow: 0 0 0 2px var(--accent-ring);
  }
}
@media (prefers-reduced-motion: reduce) {
  .settings__body[data-searching] > [data-hit-flash] {
    animation: none;
  }
}
/* Search mode: every category's blocks are candidates; only matches show. */
.settings__body[data-searching] > [data-cat]:not([data-match="1"]) {
  display: none;
}
.settings__search-group {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin: 16px 0 6px;
}
.settings__search-group:first-child {
  margin-top: 0;
}
.settings__search-group-icon {
  color: var(--text-3);
}
.settings__search-empty {
  order: -1;
  color: var(--text-3);
  font-size: 13px;
  margin: 24px 0;
  text-align: center;
}

/* ── content ─────────────────────────────────────────────────────────── */
.settings__body {
  flex: 1;
  min-width: 0;
  padding: 20px 28px 32px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  background: var(--bg);
}
.settings__page-title {
  margin: 0 0 16px;
  font-size: 20px;
  font-weight: 620;
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--text);
}

/* Every visible block is a card row. */
.settings__body > [data-cat] {
  box-sizing: border-box;
  background: var(--bg-elev);
  padding: 10px 14px;
  border-top: var(--bd-hair);
}
.settings__body > [data-cat][data-gs] {
  border-top: 0;
  border-top-left-radius: var(--r-lg);
  border-top-right-radius: var(--r-lg);
  margin-top: 16px;
}
.settings__body > .settings__page-title + [data-cat][data-gs],
.settings__body > .settings__search-group + [data-cat][data-gs] {
  margin-top: 0;
}
.settings__body > [data-cat][data-ge] {
  border-bottom-left-radius: var(--r-lg);
  border-bottom-right-radius: var(--r-lg);
}
/* Whole sub-panels (AI, GitHub sync, proxy, …) get room inside their card. */
.settings__body > div[data-cat] {
  padding: 14px 16px;
}
.settings__body > div[data-cat]:empty {
  display: none !important;
}

/* A row: label left, control right; anything else spans the row. */
section {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 16px;
  row-gap: 4px;
  min-height: 24px;
}
section > * {
  grid-column: 1 / -1;
  min-width: 0;
}
section > label {
  font-size: 13px;
  line-height: 1.4;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
/* A plain caption label ("Theme", "Font size: 16px") is the row's label. */
section > label:first-child:not(:has(input, select, textarea)),
section > label:first-child:not(:has(input, select, textarea)) {
  grid-column: 1;
}
/* …and the control right after it sits on the right of the same line. */
section > label:first-child:not(:has(input, select, textarea)) + select,
section > label:first-child:not(:has(input, select, textarea)) + input:not([type='checkbox']):not([type='radio']),
section > label:first-child:not(:has(input, select, textarea)) + .settings__field {
  grid-column: 2;
  grid-row: 1;
  width: 240px;
  max-width: 100%;
}
section > label:first-child:not(:has(input, select, textarea)) + input[type='range'] {
  width: 200px;
}

/* Checkbox rows: the text on the left, a switch on the right. */
section > label:has(> input[type='checkbox']),
.kb-hints-toggle {
  justify-content: space-between;
  flex-direction: row-reverse;
  gap: 16px;
  cursor: default;
  min-height: 24px;
}
section > label:has(> input[type='checkbox']) + label:has(> input[type='checkbox']) {
  padding-top: 6px;
  margin-top: 4px;
  border-top: var(--bd-hair);
}

/* Group title inside a card (e.g. "Writing statistics", "Version history"). */
.settings__group-title {
  margin: 2px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

/* Help text */
.setting-hint,
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-3);
}
section > label + .setting-hint,
section > label + .hint {
  margin-top: -2px;
}
.setting-hint a {
  color: var(--accent-text);
  text-decoration: none;
}
.setting-hint a:hover {
  text-decoration: underline;
}
/* #282 — "your theme choice is not reaching the screen" is not a footnote;
   it explains why the control right above it looks broken. */
.setting-hint--warn {
  margin-top: 6px;
  color: var(--text-2);
}
.hint-btn,
.link-button {
  padding: 0;
  margin-left: 4px;
  font: inherit;
  font-size: 12px;
  color: var(--accent-text);
  background: none;
  border: none;
  cursor: default;
}
.hint-btn:hover,
.link-button:hover {
  background: none;
  text-decoration: underline;
}
.css-path-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  word-break: break-all;
  margin-top: 4px;
}
.css-path-row > span {
  min-width: 0;
}
.refresh-css-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-2);
  cursor: default;
}
.refresh-css-btn:hover {
  background: var(--fill-1);
  color: var(--text);
}
.refresh-css-btn svg.is-spinning {
  animation: refresh-css-spin 0.7s linear infinite;
}
@keyframes refresh-css-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── controls (tokens; same look as ui/DsInput / DsButton) ────────────── */
.settings__field,
.img-field,
.kb-search,
select {
  box-sizing: border-box;
  height: 28px;
  padding: 0 8px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--fill-1);
  border: 0;
  border-radius: var(--r-sm);
  outline: none;
}
.settings__field,
.img-field,
.kb-search {
  width: 100%;
}
.settings__field::placeholder,
.img-field::placeholder,
.kb-search::placeholder {
  color: var(--text-3);
}
.settings__field:focus,
.img-field:focus,
.kb-search:focus,
select:focus {
  background: var(--bg);
  box-shadow: var(--ring);
}
.settings__field--sub {
  margin-top: 4px;
}
.settings__field--num {
  width: 76px;
  font-variant-numeric: tabular-nums;
}
select {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  padding-right: 26px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='gray' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='8 10 12 6 16 10'/%3E%3Cpolyline points='8 14 12 18 16 14'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  cursor: default;
}
select:hover:not(:focus) {
  background-color: var(--fill-2);
}
.settings__unit {
  font-size: 12px;
  color: var(--text-3);
}
.settings__mm {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.settings__mm-label {
  min-width: 56px;
  color: var(--text-2);
}
input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

/* Switch: a checkbox drawn as an AppKit-style toggle. Still a real checkbox
   (keyboard, label click, :checked), only painted differently. */
section input[type='checkbox'],
.kb-hints-toggle input[type='checkbox'] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex: none;
  width: 30px;
  height: 18px;
  margin: 0;
  border-radius: var(--r-full);
  background: var(--fill-2);
  box-shadow: inset 0 0 0 var(--hair-w) var(--hairline);
  transition: background-color var(--dur-fast) var(--ease);
  cursor: default;
}
section input[type='checkbox']::before,
.kb-hints-toggle input[type='checkbox']::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--r-full);
  background: #fff;
  box-shadow: var(--sh-thumb);
  transition: transform var(--dur) var(--ease-out);
}
section input[type='checkbox']:checked,
.kb-hints-toggle input[type='checkbox']:checked {
  background: var(--accent);
  box-shadow: none;
}
section input[type='checkbox']:checked::before,
.kb-hints-toggle input[type='checkbox']:checked::before {
  transform: translateX(12px);
}
section input[type='checkbox']:focus-visible,
.kb-hints-toggle input[type='checkbox']:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
section input[type='checkbox']:disabled {
  opacity: 0.4;
}
section label:has(> input[type='checkbox']:disabled) {
  color: var(--text-3);
}
@media (prefers-reduced-motion: reduce) {
  section input[type='checkbox'],
  section input[type='checkbox']::before {
    transition: none;
  }
}

/* Buttons inside the settings rows: secondary by default, primary when
   marked as such. */
.row {
  display: flex;
  gap: 8px;
}
section button:not([class]),
.row button {
  height: 28px;
  padding: 0 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 560;
  color: var(--text);
  background: var(--fill-1);
  border: 0;
  border-radius: var(--r-md);
  cursor: default;
}
section button:not([class]):hover:not(:disabled),
.row button:hover:not(:disabled) {
  background: var(--fill-2);
}
.row button.active {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.row .primary-btn {
  background: var(--accent-strong);
  color: var(--accent-strong-fg);
}
.row .primary-btn:hover:not(:disabled) {
  background: var(--accent-strong);
  filter: brightness(1.06);
}
section button:focus-visible,
.row button:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

@media (pointer: coarse) {
  select,
  .settings__field,
  .img-field,
  .kb-search {
    height: 40px;
    font-size: 15px;
  }
}

/* Phone: one column — label above control. */
:root.narrow-viewport section {
  grid-template-columns: minmax(0, 1fr);
}
:root.narrow-viewport section > * {
  grid-column: 1 / -1 !important;
  grid-row: auto !important;
}
:root.narrow-viewport section > label:first-child:not(:has(input, select, textarea)) + select,
:root.narrow-viewport section > label:first-child:not(:has(input, select, textarea)) + input,
:root.narrow-viewport section > label:first-child:not(:has(input, select, textarea)) + .settings__field {
  width: 100%;
}
</style>
