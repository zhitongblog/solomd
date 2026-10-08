<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icons.vue';
import BrandMark from './BrandMark.vue';
import PomodoroPopover from './PomodoroPopover.vue';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useTilesStore } from '../stores/tiles';
import { track } from '../lib/telemetry';
import { getPlainSelection } from '../lib/plain-selection';
import { useFiles } from '../composables/useFiles';
import { useViewport } from '../composables/useViewport';
import { shortcutLabel } from '../lib/keybindings';
import { itemShortcut, type MenuNode, type TopMenu } from '../lib/app-menu';
import { useAppMenu } from '../composables/useAppMenu';
import { useExport } from '../composables/useExport';
import { useToastsStore } from '../stores/toasts';
import { cleanAIArtifacts } from '../lib/clean-ai';
import { useI18n } from '../i18n';
import { usePhoneStore } from '../stores/phone';
import { openPath } from '@tauri-apps/plugin-opener';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isIOS, isWindowsDesktop, usesCommandKey } from '../lib/platform';
import { macTitleBar, winTitleBar, customTitleBar } from '../lib/chrome';

const hasTauriShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import { EditorView } from '@codemirror/view';

const { t } = useI18n();

/**
 * 5.0 (docs/v5-ui-spec.md §3). One component, two placements:
 *  - `header` (default): the 52px row over the editor — sidebar button when
 *    the sidebar is hidden, the tabs (PaneHost teleports a single pane's tab
 *    strip into `#header-tabs`), the 实时/源码/预览 switch and four buttons.
 *  - `titlebar`: Windows only — the 44px frameless title bar above
 *    everything: app icon, the in-app menus, the title, caption buttons.
 */
const props = withDefaults(defineProps<{ variant?: 'header' | 'titlebar' }>(), { variant: 'header' });
const isTitlebar = computed(() => props.variant === 'titlebar');

defineEmits<{
  (e: 'open-palette'): void;
  (e: 'open-settings'): void;
  (e: 'open-help'): void;
  (e: 'open-search'): void;
}>();

const tabs = useTabsStore();
const settings = useSettingsStore();

const { isNarrow } = useViewport();
// 5.0 §8 — on a phone the header is the editor screen's nav bar: back to 笔记,
// the note's title, preview, share, more.
const phone = usePhoneStore();
const phoneTitle = computed(() => (tabs.activeTab?.fileName ?? '').replace(/\.(md|markdown|txt)$/i, ''));
function togglePhonePreview() {
  pickViewMode(settings.viewMode === 'preview' ? 'liveEdit' : 'preview');
}

// #180 — tooltips show the chord that works right now. The chord used to be
// baked into the translated string ("Open file (Ctrl+O)"), which turned every
// tooltip into a lie the moment a user rebound anything.
const macChord = usesCommandKey();
function tip(labelKey: string, actionId: string): string {
  const label = t(labelKey);
  const chord = shortcutLabel(actionId, settings.keybindings, macChord);
  return chord ? `${label} (${chord})` : label;
}
const workspace = useWorkspaceStore();
const tiles = useTilesStore();
const files = useFiles();
const exporter = useExport();
const toasts = useToastsStore();

const isMarkdown = computed(() => tabs.activeTab?.language === 'markdown');

// #127 — drag the window by the title bar. The declarative
// `data-tauri-drag-region` attribute proved unreliable on macOS once the
// unified title bar shipped (the empty spacer carried the attr yet the window
// would not move). Drive the OS drag explicitly via `startDragging()` on
// mousedown over any non-interactive region of the bar, and replicate the
// native double-click-to-zoom. Listener is in the capture phase so it fires
// before any child stops propagation, and only runs inside the Tauri shell.
// The same path serves the frameless Windows build (startDragging sends
// WM_NCLBUTTONDOWN/HTCAPTION under the hood, so Aero-snap drag works).
function isInteractiveTitleBarTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node?.closest?.(
    // `[role="tab"]`: 5.0 moved the tab strip into this bar, and a tab is a
    // div — so pressing one started a window drag, the OS kept the mouseup,
    // and the click that switches tabs never fired (Windows VM, 2026-10-08).
    // The strip's empty space still drags the window.
    'button, input, select, textarea, a, [role="tab"], [contenteditable="true"], .dropdown__menu, [data-no-drag]',
  );
}
function onTitleBarMouseDown(e: MouseEvent) {
  if (!customTitleBar || e.button !== 0 || e.detail > 1) return;
  if (isInteractiveTitleBarTarget(e.target)) return;
  if (!('__TAURI_INTERNALS__' in window)) return;
  void getCurrentWindow().startDragging();
}
function onTitleBarDblClick(e: MouseEvent) {
  if (!customTitleBar) return;
  if (isInteractiveTitleBarTarget(e.target)) return;
  if (!('__TAURI_INTERNALS__' in window)) return;
  void getCurrentWindow().toggleMaximize();
}

/**
 * v2.5 F6 — open the CJK proofread panel. App.vue listens for this
 * event (same pattern as `solomd:open-help` / `solomd:open-settings`).
 */
function onOpenCjkProofread() {
  window.dispatchEvent(new CustomEvent('solomd:open-cjk-proofread'));
}

function onCleanAI() {
  const t = tabs.activeTab;
  if (!t) {
    toasts.warning('No active document');
    return;
  }
  const cleaned = cleanAIArtifacts(t.content);
  if (cleaned === t.content) {
    toasts.info('No AI artifacts found');
    return;
  }
  tabs.setContent(t.id, cleaned);
  toasts.success('AI artifacts cleaned');
}

/**
 * Toolbar entry for v2.0 F4. Mirrors the Cmd+J keyboard binding —
 * builders the same `solomd:ai-rewrite-open` event off the active editor's
 * selection so both routes funnel into AIRewriteOverlay.
 */
function onAIRewrite() {
  const t = tabs.activeTab;
  if (!t) {
    toasts.warning('No active document');
    return;
  }
  if (!settings.aiEnabled) {
    toasts.info(t === undefined ? '' : 'Enable AI rewrite in Settings first (⌘,)');
    // AI settings live under the `integrations` category in
    // SettingsPanel; pass section via event detail so the panel jumps
    // there directly instead of opening at the default `basics` tab.
    window.dispatchEvent(
      new CustomEvent('solomd:open-settings', { detail: { section: 'integrations' } }),
    );
    return;
  }
  // Read selection from the focused CodeMirror view. We REFUSE to fall back
  // to the whole document — silently translating the entire file is almost
  // never what the user wants, and the overlay's accept path replaces using
  // the editor's current selection anyway, so a "whole doc" toolbar fire
  // would either replace the whole doc on accept (data loss surprise) or
  // splice the translation at the cursor (also surprising). Force explicit
  // selection.
  //
  // #95 fix: don't require .cm-focused. The user's complaint was that
  // after closing the rewrite overlay and clicking the toolbar button
  // again, "Select some text first" fired even though the selection
  // box was clearly still visible. The overlay's close path returns
  // focus to the editor on the next tick, so by the time the button
  // click event reaches this handler the .cm-focused class is briefly
  // absent — but the DOM Selection is unchanged. Accept any .cm-editor
  // on the page; the selection check below is what matters.
  // Read the selection from CodeMirror's state — NOT window.getSelection().
  // On Windows WebView2 the DOM Selection comes back empty for the CM editor
  // (its drawSelection-managed selection isn't exposed via getSelection), so
  // the old read made AI rewrite wrongly report "Select some text first" even
  // with text selected. CM state is the source of truth and matches the ⌘J
  // path (cm-ai-rewrite.ts dispatchOpen). Also lets us pass the real from/to
  // instead of 0/0.
  const editors = [
    document.querySelector<HTMLElement>('.cm-editor.cm-focused'),
    ...Array.from(document.querySelectorAll<HTMLElement>('.cm-editor')),
  ].filter((e): e is HTMLElement => e != null);
  let picked: { selection: string; from: number; to: number } | null = null;
  for (const el of editors) {
    const view = EditorView.findFromDOM(el);
    if (!view) continue;
    const main = view.state.selection.main;
    if (main.empty) continue;
    const text = view.state.sliceDoc(main.from, main.to);
    if (text.trim()) {
      picked = { selection: text, from: main.from, to: main.to };
      break;
    }
  }
  // #126 — Windows has NO CodeMirror view since the 4.6.4 plain-editor swap,
  // so the scan above finds nothing there; ask the plain editor's selection
  // registry before giving up (textareas keep selectionStart/End on blur).
  if (!picked) {
    picked = getPlainSelection();
  }
  if (!picked) {
    const jChord = shortcutLabel('editor.aiRewrite', settings.keybindings, usesCommandKey()) || '—';
    toasts.info(`Select some text first, then click AI rewrite (or press ${jChord}).`);
    return;
  }
  window.dispatchEvent(
    new CustomEvent('solomd:ai-rewrite-open', { detail: picked }),
  );
}

async function onOpenExternal() {
  const path = tabs.activeTab?.filePath;
  if (!path) {
    toasts.warning(t('toast.openExternalNoFile'));
    return;
  }
  // iOS: tauri-plugin-opener calls UIApplication.shared.open(URL:) which
  // doesn't handle `file://` URLs, so a deep-linked Files-app source never
  // opens. Route through the Web Share API
  // instead — iOS 15+ WKWebView surfaces the standard iOS share sheet
  // (AirDrop / Messages / Mail / Files / iCloud) for File payloads.
  if (isIOS()) {
    const tab = tabs.activeTab;
    const fileName = path.split(/[\\/]/).pop() ?? 'note.md';
    const content = tab?.content ?? '';
    try {
      if (navigator.share && typeof File === 'function') {
        const mime = fileName.endsWith('.md') || fileName.endsWith('.markdown')
          ? 'text/markdown'
          : 'text/plain';
        const file = new File([content], fileName, { type: mime });
        const data: ShareData = { title: fileName, files: [file] };
        // Must call `canShare` as a method on `navigator` — destructuring
        // the reference drops `this`, and WebKit throws:
        //   "Can only call Navigator.canShare on instances of Navigator".
        const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
        if (!nav.canShare || nav.canShare(data)) {
          await navigator.share(data);
          return;
        }
      }
      if (navigator.share) {
        await navigator.share({ title: fileName, text: content });
        return;
      }
    } catch (e) {
      // AbortError = user cancelled the share sheet; not an error.
      const name = (e as { name?: string }).name;
      if (name === 'AbortError') return;
      toasts.warning(`Share failed: ${e}`);
      return;
    }
    toasts.info('Sharing not supported on this iOS version');
    return;
  }
  try {
    await openPath(path);
  } catch (e) {
    toasts.warning(`Failed: ${e}`);
  }
}

const exportOpen = ref(false);
const moreOpen = ref(false);
const pomoOpen = ref(false);

const exportBtnRef = ref<HTMLElement | null>(null);
const moreBtnRef = ref<HTMLElement | null>(null);

/**
 * The More menu holds everything the 4.x strip carried that the header no
 * longer shows. Three groups open as pages inside the same menu (a back row
 * at the top) rather than as flyouts: a flyout off a menu anchored at the
 * window's right edge would have to open leftwards over the menu itself.
 */
type MorePage = 'root' | 'insert' | 'recent' | 'ai';
const morePage = ref<MorePage>('root');
function goMorePage(p: MorePage) {
  morePage.value = p;
  void focusMenuItem('first');
}

/** AI rewrite exists in this build and is switched on — otherwise the AI
 *  control is just "clean AI artifacts" (see the template). */
const aiRewriteAvailable = computed(() => !IS_APP_STORE_BUILD && settings.aiEnabled);

type ViewModeId = 'edit' | 'split' | 'liveEdit' | 'preview' | 'reading';
/** The header's segmented switch: the four modes people move between while
 *  writing (split = source left, preview right). Reading stays in the View
 *  menu and the palette. */
const segModes: Array<{ mode: ViewModeId; label: string }> = [
  { mode: 'liveEdit', label: 'header.segLive' },
  { mode: 'edit', label: 'header.segSource' },
  { mode: 'split', label: 'header.segSplit' },
  { mode: 'preview', label: 'header.segPreview' },
];
const segIndex = computed(() => segModes.findIndex((m) => m.mode === settings.viewMode));
function pickViewMode(mode: ViewModeId) {
  closeAllDropdowns();
  settings.setViewMode(mode);
  track('view_mode', { mode });
}

const formatItems: Array<{ kind: string; label: string; action: string }> = [
  'bold', 'italic', 'strike', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'task',
].map((kind) => ({ kind, label: `cmd.fmt.${kind}`, action: `fmt.${kind}` }));
const menuPos = ref<{ top: number; left?: number; right?: number } | null>(null);
const floatStyle = computed<Record<string, string | number> | undefined>(() => {
  if (!menuPos.value) return undefined;
  const s: Record<string, string | number> = {
    position: 'fixed',
    top: `${menuPos.value.top}px`,
    zIndex: 1000,
    // #320 — as tall as the window allows, not a fixed 360px: the View menu
    // is ~19 rows and scrolled even on a 1080p screen, turning "click, move,
    // click" into "click, scroll, move, click". It still scrolls when the
    // window really is too short.
    maxHeight: `calc(100vh - ${menuPos.value.top}px - 8px)`,
    // Never wider than the window (see keepMenuOnScreen).
    maxWidth: 'calc(100vw - 16px)',
  };
  if (menuPos.value.left !== undefined) s.left = `${menuPos.value.left}px`;
  // `.dropdown__menu` carries `left: 0` from its stylesheet; a right-anchored
  // menu must clear it or it stretches across the whole window.
  if (menuPos.value.right !== undefined) { s.right = `${menuPos.value.right}px`; s.left = 'auto'; }
  return s;
});
function positionMenuFromButton(btn: HTMLElement | null, align: 'left' | 'right' = 'left') {
  if (!btn) { menuPos.value = null; return; }
  const rect = btn.getBoundingClientRect();
  if (align === 'right') {
    menuPos.value = { top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) };
  } else {
    menuPos.value = { top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 16) };
  }
}
/**
 * The menu is anchored to its button, so a wide menu under a button near the
 * edge of a narrow window ran off the screen: on a phone with a large display
 * size the View menu's ✓ marks and icons were cut off on the left. Once it has
 * rendered, measure it and pin it to whichever edge it crossed (watcher
 * below, after the open-flag and anchor changes have reached the DOM).
 */
function keepMenuOnScreen() {
  const pos = menuPos.value;
  const el = document.querySelector<HTMLElement>('.dropdown__menu[data-tb-menu], .menubar__menu');
  if (!pos || !el) return;
  const r = el.getBoundingClientRect();
  const margin = 8;
  if (r.left < margin) menuPos.value = { top: pos.top, left: margin };
  else if (r.right > window.innerWidth - margin) menuPos.value = { top: pos.top, right: margin };
}

// Pomodoro popover, opened from the palette. Anchored under the right end of
// the bar (the popover itself is `position:absolute; left:0` in its anchor).
const pomoAnchorStyle = ref<Record<string, string | number>>({});
function openPomodoro() {
  closeAllDropdowns();
  const r = toolbarRef.value?.getBoundingClientRect();
  const top = r && r.height > 0 ? r.bottom + 4 : 44;
  pomoAnchorStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    right: '12px',
    width: '260px',
    height: '0',
    zIndex: 1000,
  };
  pomoOpen.value = true;
}

/** #296 — formatting from the Insert menu runs the same toggle the shortcut
 *  does, so it wraps the selection instead of dropping a template beside it. */
function dispatchFormat(kind: string) {
  window.dispatchEvent(new CustomEvent('solomd:format-markdown', { detail: { kind } }));
  closeAllDropdowns();
}
// A phone has no keyboard to press them with — the hints are just clutter.
function chord(actionId: string): string {
  if (isNarrow.value) return '';
  return shortcutLabel(actionId, settings.keybindings, macChord) || '';
}

function dispatchInsert(snippet: string) {
  window.dispatchEvent(
    new CustomEvent('solomd:insert-markdown', {
      detail: { snippet, paneId: tiles.focusedPaneId },
    })
  );
  closeAllDropdowns();
}

async function pickAndInsertImage() {
  closeAllDropdowns();
  const sel = await openFileDialog({
    multiple: false,
    defaultPath: await files.filePickerStartDir(),
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff'] },
    ],
  });
  if (typeof sel !== 'string') return;
  window.dispatchEvent(
    new CustomEvent('solomd:insert-image-path', {
      detail: { path: sel, paneId: tiles.focusedPaneId },
    }),
  );
}

// Insert an image by external URL (网络图片) — opens the dialog mounted in App.vue.
function openImageUrlDialog() {
  closeAllDropdowns();
  window.dispatchEvent(new CustomEvent('solomd:open-image-url-dialog'));
}

function shortPath(p: string) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Close any open dropdown when user clicks outside.
// More reliable than @blur which doesn't fire consistently across browsers.
function closeAllDropdowns() {
  exportOpen.value = false;
  moreOpen.value = false;
  morePage.value = 'root';
  pomoOpen.value = false;
  menubarOpen.value = null;
}

/** Run a More-menu action and close the menu. */
function act(fn: () => unknown) {
  closeAllDropdowns();
  void fn();
}
function toggleThemeFromMenu() {
  closeAllDropdowns();
  settings.toggleTheme();
  track('theme_changed', { theme: settings.theme });
}

// ── Windows unified title bar: in-app menubar ────────────────────────────────
// Replaces the native Windows menu bar (removed together with the window
// decorations). bug/C1: the tree is lib/app-menu.ts — the same one runner.rs
// builds the native macOS / Linux menu from — so the two menu bars show the
// same seven menus, and every chord is the binding in effect right now.
// App.vue's `dispatchMenuAction` runs the ids for both. Rendered only when
// `winTitleBar`.
const appMenu = useAppMenu();
const menubarTree = computed<TopMenu[]>(() => appMenu.menuFor('windows'));
type MenubarName = string;
const menubarOpen = ref<MenubarName | null>(null);
function toggleMenubar(name: MenubarName, e: MouseEvent) {
  const wasOpen = menubarOpen.value === name;
  closeAllDropdowns();
  if (wasOpen) return;
  positionMenuFromButton(e.currentTarget as HTMLElement);
  menubarOpen.value = name;
}
// Native menubar behavior: once a menu is open, hovering a sibling switches.
function menubarHover(name: MenubarName, e: MouseEvent) {
  if (menubarOpen.value && menubarOpen.value !== name) {
    positionMenuFromButton(e.currentTarget as HTMLElement);
    menubarOpen.value = name;
  }
}
function menuAction(node: MenuNode) {
  if (node.type !== 'item' || node.enabled === false) return;
  menubarOpen.value = null;
  // Same dispatch surface the native menus use (App.vue listens for both this
  // DOM event and the Tauri `solomd://menu` event).
  window.dispatchEvent(new CustomEvent('solomd:menu-action', { detail: node.id }));
}
/** The chord shown beside an item — read at render time from the bindings. */
function menuShortcut(node: MenuNode): string {
  if (isNarrow.value) return '';
  return node.type === 'item' ? itemShortcut(node, { overrides: settings.keybindings, macKeys: macChord }) : '';
}
const menubarItems = computed<MenuNode[]>(
  () => menubarTree.value.find((m) => m.id === menubarOpen.value)?.items ?? [],
);

// The open submenu, placed beside its row. A separate fixed layer rather than
// a child of the menu: the menu scrolls (max-height), which would clip it.
const menubarSub = ref<{ key: string; top: number; left: number } | null>(null);
const SUBMENU_WIDTH = 240;
function openMenubarSub(key: string, e: MouseEvent) {
  cancelMenubarSubClose();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // Open to the right; flip left when the window has no room there.
  const left = r.right + SUBMENU_WIDTH > window.innerWidth - 8 ? r.left - SUBMENU_WIDTH : r.right - 2;
  menubarSub.value = { key, top: r.top - 4, left: Math.max(8, left) };
  // Like a native menu: a submenu that would run off the bottom of the window
  // slides up until it fits (it only scrolls when taller than the window).
  void nextTick(() => {
    const el = menubarSubEl.value;
    const sub = menubarSub.value;
    if (!el || !sub || sub.key !== key) return;
    const fitTop = Math.max(8, window.innerHeight - 8 - el.scrollHeight);
    if (fitTop < sub.top) menubarSub.value = { ...sub, top: fitTop };
  });
}
const menubarSubEl = ref<HTMLElement | null>(null);
// Moving diagonally from the row to the submenu crosses the rows below it;
// closing on the first of those would make the submenu impossible to reach.
let menubarSubTimer = 0;
function closeMenubarSubSoon() {
  if (!menubarSub.value || menubarSubTimer) return;
  menubarSubTimer = window.setTimeout(() => {
    menubarSubTimer = 0;
    menubarSub.value = null;
  }, 300);
}
function cancelMenubarSubClose() {
  clearTimeout(menubarSubTimer);
  menubarSubTimer = 0;
}
const menubarSubItems = computed<MenuNode[] | null>(() => {
  const sub = menubarSub.value;
  if (!sub || !menubarOpen.value) return null;
  const entry = menubarItems.value.find((e) => e.type === 'submenu' && e.id === sub.key);
  return entry && entry.type === 'submenu' ? entry.items : null;
});
const menubarSubStyle = computed(() => {
  const sub = menubarSub.value;
  if (!sub) return undefined;
  return {
    position: 'fixed' as const,
    top: `${sub.top}px`,
    left: `${sub.left}px`,
    minWidth: `${SUBMENU_WIDTH}px`,
    zIndex: 1001,
    maxHeight: `calc(100vh - ${sub.top}px - 8px)`,
  };
});
watch(menubarOpen, () => {
  cancelMenubarSubClose();
  menubarSub.value = null;
});

// Root element — used by onScrollAnywhere to tell "a scroll that moves the
// menu anchors" from pane scrolls.
const toolbarRef = ref<HTMLElement | null>(null);

// ── Windows caption buttons (min / max / close) ─────────────────────────────
const isMaximized = ref(false);
const maxBtnHover = ref(false);
const maxBtnRef = ref<HTMLElement | null>(null);
let unlistenWinChrome: UnlistenFn[] = [];
function winMinimize() {
  if (hasTauriShell) void getCurrentWindow().minimize();
}
function winToggleMax() {
  // Fallback path only: on the real Windows main window the Rust subclass
  // claims this button as HTMAXBUTTON, so clicks never reach the DOM (Windows
  // maximizes natively and shows Snap Layouts on hover). This handler covers
  // auxiliary windows and the dev preview.
  if (hasTauriShell) void getCurrentWindow().toggleMaximize();
}
function winClose() {
  // Routes through Tauri's close-requested flow → unsaved-tabs confirm.
  if (hasTauriShell) void getCurrentWindow().close();
}
async function refreshMaximized() {
  if (!hasTauriShell) return;
  try {
    isMaximized.value = await getCurrentWindow().isMaximized();
  } catch {
    /* not fatal */
  }
}
// Report the maximize button's rect so the Rust WM_NCHITTEST subclass can
// answer HTMAXBUTTON there (Snap Layouts). Main window only; CSS px + the
// devicePixelRatio (which folds in webview zoom) → physical px in Rust.
let rectRaf = 0;
function reportMaxBtnRect() {
  if (!isTitlebar.value || !winTitleBar || !hasTauriShell || !isWindowsDesktop()) return;
  if (getCurrentWindow().label !== 'main') return;
  cancelAnimationFrame(rectRaf);
  rectRaf = requestAnimationFrame(() => {
    const scale = window.devicePixelRatio || 1;
    const r = maxBtnRef.value?.getBoundingClientRect();
    void invoke('set_max_button_rect', r && r.width > 0
      ? { x: r.left, y: r.top, w: r.width, h: r.height, scale }
      : { x: 0, y: 0, w: 0, h: 0, scale });
  });
}
onMounted(async () => {
  if (!isTitlebar.value || !winTitleBar || !hasTauriShell) return;
  await refreshMaximized();
  reportMaxBtnRect();
  window.addEventListener('resize', reportMaxBtnRect);
  try {
    unlistenWinChrome.push(
      await getCurrentWindow().onResized(() => {
        void refreshMaximized();
        reportMaxBtnRect();
      }),
    );
    unlistenWinChrome.push(
      await listen<boolean>('solomd://maxbtn-hover', (e) => {
        maxBtnHover.value = !!e.payload;
      }),
    );
  } catch {
    /* browser dev preview — no Tauri events */
  }
});
onBeforeUnmount(() => {
  if (!isTitlebar.value || !winTitleBar) return;
  window.removeEventListener('resize', reportMaxBtnRect);
  for (const un of unlistenWinChrome) un();
  unlistenWinChrome = [];
  if (hasTauriShell && isWindowsDesktop()) {
    void invoke('set_max_button_rect', { x: 0, y: 0, w: 0, h: 0, scale: 1 });
  }
});
// Exclusive open: opening one dropdown closes others.
type DropdownName = 'export' | 'more';
// Both triggers sit at the right end of the header.
const dropdowns: Record<DropdownName, { open: typeof exportOpen; btn: typeof exportBtnRef; align: 'left' | 'right' }> = {
  export: { open: exportOpen, btn: exportBtnRef, align: 'right' },
  more: { open: moreOpen, btn: moreBtnRef, align: 'right' },
};
/** The trigger of the menu that is open now, so Escape can hand focus back. */
let lastTrigger: HTMLElement | null = null;
function toggleDropdown(name: DropdownName, e?: MouseEvent) {
  const d = dropdowns[name];
  const wasOpen = d.open.value;
  closeAllDropdowns();
  if (wasOpen) return;
  positionMenuFromButton(d.btn.value, d.align);
  d.open.value = true;
  lastTrigger = d.btn.value;
  // `detail === 0` — the click came from Enter/Space on the focused trigger,
  // not a mouse: move focus into the menu so the arrow keys work.
  if (e && e.detail === 0) void focusMenuItem('first');
}
function openByKey(name: DropdownName) {
  if (!dropdowns[name].open.value) toggleDropdown(name);
  void focusMenuItem('first');
}
const anyToolbarMenuOpen = computed(() => exportOpen.value || moreOpen.value);
watch(
  () => [menuPos.value, anyToolbarMenuOpen.value, menubarOpen.value],
  () => {
    if (anyToolbarMenuOpen.value || menubarOpen.value) keepMenuOnScreen();
  },
  { flush: 'post' },
);

// ── Keyboard access for the toolbar menus ────────────────────────────────────
// Items act on `mousedown.prevent` so a mouse click never steals focus (and
// the selection) from the editor — Insert and AI rewrite depend on it. The
// keyboard path reuses that exact handler by synthesising the mousedown, so
// there is one action per item, not a click and a mousedown to keep in step.
const MENU_ITEM_SEL = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
async function focusMenuItem(which: 'first' | 'last') {
  await nextTick();
  const menu = document.querySelector<HTMLElement>('.dropdown__menu[data-tb-menu]');
  const items = Array.from(menu?.querySelectorAll<HTMLElement>(MENU_ITEM_SEL) ?? []);
  const el = which === 'first' ? items[0] : items[items.length - 1];
  el?.focus();
}
function onMenuKeydown(e: KeyboardEvent) {
  const menu = e.currentTarget as HTMLElement;
  const items = Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SEL));
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement as HTMLElement);
  const move = (i: number) => items[(i + items.length) % items.length].focus();
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(idx < 0 ? 0 : idx + 1); break;
    case 'ArrowUp': e.preventDefault(); move(idx < 0 ? items.length - 1 : idx - 1); break;
    case 'Home': e.preventDefault(); move(0); break;
    case 'End': e.preventDefault(); move(items.length - 1); break;
    case 'Enter':
    case ' ': {
      if (idx < 0) return;
      e.preventDefault();
      const trigger = lastTrigger;
      items[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      // An action that opened a dialog took focus itself; otherwise don't
      // strand focus on <body> where the removed menu was.
      void nextTick(() => {
        if (!document.activeElement || document.activeElement === document.body) trigger?.focus();
      });
      break;
    }
    case 'Tab':
      closeAllDropdowns();
      break;
  }
}
// Escape closes whichever toolbar menu is open and returns focus to its
// trigger. Capture phase, so the editor or a global handler doesn't also act
// on an Escape that was only meant to dismiss the menu.
function onEscapeKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (!anyToolbarMenuOpen.value && !menubarOpen.value) return;
  e.preventDefault();
  e.stopPropagation();
  const trigger = anyToolbarMenuOpen.value ? lastTrigger : null;
  closeAllDropdowns();
  trigger?.focus();
}
function onOpenPomodoroEvent() {
  openPomodoro();
}
function onDocClick(e: MouseEvent) {
  // Menus are teleported to <body>, so `.closest('.dropdown')` from a menu
  // item won't reach the original `.dropdown` wrapper — also check for the
  // menu's own marker class.
  const target = e.target as HTMLElement | null;
  if (target && (target.closest('.dropdown') || target.closest('.dropdown__menu'))) return;
  closeAllDropdowns();
}
function onViewportChange() {
  // Teleported menus position from the button's getBoundingClientRect at
  // open time; on resize / scroll those coords go stale.
  closeAllDropdowns();
}
function onScrollAnywhere(e: Event) {
  // #221(3) — only a scroll that can actually move the anchor buttons (the
  // toolbar's own horizontal overflow scroll (#134), or a document-level
  // scroll) invalidates the teleported menu's position. The capture-phase
  // listener also sees editor/preview pane scrolls, and wheel-scrolling under
  // an open View menu was closing it — native menus don't do that.
  const t = e.target as Node | null;
  if (t && t !== document && toolbarRef.value && !toolbarRef.value.contains(t)) return;
  closeAllDropdowns();
}
onMounted(() => {
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onEscapeKey, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onScrollAnywhere, true);
  // Two Toolbars exist on Windows; only the header answers these.
  if (isTitlebar.value) return;
  window.addEventListener('solomd:open-pomodoro', onOpenPomodoroEvent);
  window.addEventListener('solomd:toolbar-ai-rewrite', onAIRewrite);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onEscapeKey, true);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onScrollAnywhere, true);
  window.removeEventListener('solomd:open-pomodoro', onOpenPomodoroEvent);
  window.removeEventListener('solomd:toolbar-ai-rewrite', onAIRewrite);
});
</script>

<template>
  <!-- ── Windows: the frameless title bar ─────────────────────────────── -->
  <div
    v-if="isTitlebar"
    ref="toolbarRef"
    class="toolbar toolbar--titlebar"
    @mousedown.capture="onTitleBarMouseDown"
    @dblclick="onTitleBarDblClick"
  >
    <span class="titlebar__icon" aria-hidden="true"><BrandMark :size="18" /></span>
    <nav class="menubar" data-no-drag :aria-label="t('menubar.file')">
      <button
        v-for="m in menubarTree"
        :key="m.id"
        class="menubar__btn"
        :class="{ active: menubarOpen === m.id }"
        :data-menu="m.id"
        @click="toggleMenubar(m.id, $event)"
        @mouseenter="menubarHover(m.id, $event)"
      >{{ m.label }}</button>
      <Teleport to="body">
        <div v-if="menubarOpen" class="dropdown__menu menubar__menu" :data-menu-open="menubarOpen" :style="floatStyle">
          <template v-for="(entry, i) in menubarItems" :key="i">
            <div v-if="entry.type === 'sep'" class="dropdown__sep"></div>
            <button
              v-else-if="entry.type === 'submenu'"
              class="dropdown__item dropdown__item--single dropdown__item--sub"
              :class="{ active: menubarSub?.key === entry.id }"
              :data-sub="entry.id"
              @mouseenter="openMenubarSub(entry.id, $event)"
              @mousedown.prevent="openMenubarSub(entry.id, $event)"
            >
              <span class="dropdown__check"></span>
              <span class="dropdown__name">{{ entry.label }}</span>
              <span class="dropdown__shortcut"><Icon name="chevron-right" :size="12" /></span>
            </button>
            <button
              v-else-if="entry.type === 'item'"
              class="dropdown__item dropdown__item--single"
              :class="{ 'dropdown__item--disabled': entry.enabled === false }"
              :data-id="entry.id"
              :disabled="entry.enabled === false"
              @mouseenter="closeMenubarSubSoon"
              @mousedown.prevent="menuAction(entry)"
            >
              <span class="dropdown__check">{{ entry.checked ? '✓' : '' }}</span>
              <span class="dropdown__name">{{ entry.label }}</span>
              <span v-if="menuShortcut(entry)" class="dropdown__shortcut">{{ menuShortcut(entry) }}</span>
            </button>
          </template>
        </div>
        <div
          v-if="menubarOpen && menubarSubItems"
          ref="menubarSubEl"
          class="dropdown__menu dropdown__menu--sub"
          :style="menubarSubStyle"
          @mouseenter="cancelMenubarSubClose"
        >
          <template v-for="(entry, i) in menubarSubItems" :key="i">
            <div v-if="entry.type === 'sep'" class="dropdown__sep"></div>
            <button
              v-else-if="entry.type === 'item'"
              class="dropdown__item dropdown__item--single"
              :class="{ 'dropdown__item--disabled': entry.enabled === false }"
              :data-id="entry.id"
              :disabled="entry.enabled === false"
              @mousedown.prevent="menuAction(entry)"
            >
              <span class="dropdown__check">{{ entry.checked ? '✓' : '' }}</span>
              <span class="dropdown__name">{{ entry.label }}</span>
              <span v-if="menuShortcut(entry)" class="dropdown__shortcut">{{ menuShortcut(entry) }}</span>
            </button>
          </template>
        </div>
      </Teleport>
    </nav>
    <span class="titlebar__title" aria-hidden="true">{{ tabs.activeTab?.fileName ? `${tabs.activeTab.fileName} — SoloMD` : 'SoloMD' }}</span>
    <div class="win-controls" data-no-drag>
      <button class="win-controls__btn" @click="winMinimize" :title="t('menubar.minimize')" tabindex="-1">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1" /></svg>
      </button>
      <button
        ref="maxBtnRef"
        class="win-controls__btn win-controls__btn--max"
        :class="{ 'is-hover': maxBtnHover }"
        @click="winToggleMax"
        :title="isMaximized ? t('menubar.restore') : t('menubar.maximize')"
        tabindex="-1"
      >
        <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" /></svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1" /><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" /></svg>
      </button>
      <button class="win-controls__btn win-controls__btn--close" @click="winClose" :title="t('menubar.close')" tabindex="-1">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" /></svg>
      </button>
    </div>
  </div>

  <!-- ── The header row (every desktop platform; iPad too) ────────────── -->
  <div
    v-else
    ref="toolbarRef"
    class="toolbar"
    :class="{
      'toolbar--mac': macTitleBar,
      'toolbar--lead': !settings.showFileTree,
      'toolbar--minimal': settings.toolbarHidden,
      'toolbar--narrow': isNarrow,
    }"
    @mousedown.capture="onTitleBarMouseDown"
    @dblclick="onTitleBarDblClick"
  >
    <template v-if="isNarrow">
      <button class="toolbar__back" type="button" @click="phone.show('home')">
        <Icon name="chevron-left" :size="22" />
        <span>{{ t('phone.notes') }}</span>
      </button>
      <span class="toolbar__phone-title">{{ phoneTitle }}</span>
    </template>
    <button
      v-else-if="!settings.showFileTree"
      class="icon-btn toolbar__sidebar-btn"
      @click="settings.toggleFileTree"
      :title="tip('header.showSidebar', 'view.toggleFileTree')"
      :aria-label="t('header.showSidebar')"
    >
      <Icon name="sidebar" />
    </button>

    <!-- A single pane's tab strip is teleported in here (PaneHost.vue); with
         a split, each pane keeps its own strip and this stays an empty,
         draggable stretch of title bar. -->
    <div id="header-tabs" class="toolbar__tabs" />

    <div
      v-if="isMarkdown && !settings.toolbarHidden"
      class="seg"
      :class="{ 'seg--none': segIndex < 0 }"
      role="radiogroup"
      :aria-label="t('header.viewModes')"
      :style="{ '--seg-i': Math.max(0, segIndex) }"
    >
      <span class="seg__thumb" aria-hidden="true" />
      <button
        v-for="m in segModes"
        :key="m.mode"
        class="seg__btn"
        :class="{ 'is-on': settings.viewMode === m.mode }"
        role="radio"
        :aria-checked="settings.viewMode === m.mode"
        @click="pickViewMode(m.mode)"
      >{{ t(m.label) }}</button>
    </div>

    <div v-if="!settings.toolbarHidden" class="toolbar__actions">
      <button
        v-if="isNarrow && isMarkdown"
        class="icon-btn"
        :class="{ active: settings.viewMode === 'preview' }"
        :title="settings.viewMode === 'preview' ? t('header.segLive') : t('header.segPreview')"
        :aria-label="settings.viewMode === 'preview' ? t('header.segLive') : t('header.segPreview')"
        @click="togglePhonePreview"
      >
        <Icon :name="settings.viewMode === 'preview' ? 'pencil' : 'eye'" />
      </button>
      <button
        v-if="!isNarrow"
        class="icon-btn"
        @click="$emit('open-search')"
        :title="tip('toolbar.searchTooltip', 'search.global')"
        :aria-label="t('toolbar.searchTooltip')"
      >
        <Icon name="search" />
      </button>

      <div class="dropdown">
        <button
          ref="exportBtnRef"
          class="icon-btn"
          aria-haspopup="menu"
          :aria-expanded="exportOpen"
          :class="{ active: exportOpen }"
          @click="toggleDropdown('export', $event)"
          @keydown.down.prevent="openByKey('export')"
          :title="t('toolbar.exportTooltip')"
          :aria-label="t('toolbar.exportTooltip')"
        >
          <Icon name="share" />
        </button>
        <Teleport to="body">
          <div v-if="exportOpen" class="dropdown__menu" role="menu" data-tb-menu :style="floatStyle" @keydown="onMenuKeydown">
            <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.exportHtml())">
              <span class="dropdown__name">{{ t('toolbar.exportHtml') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.exportDocx())">
              <span class="dropdown__name">{{ t('toolbar.exportDocx') }}</span>
            </button>
            <!-- Gitee IK8QJQ — the two PDF paths differ (vector text via the
                 OS print engine vs. a rasterised file with no dialog); say so. -->
            <button class="dropdown__item" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.exportPdfPrint())">
              <span class="dropdown__row">
                <span class="dropdown__name">{{ t('toolbar.exportPdfPrint') }}</span>
                <span v-if="chord('export.pdfPrint')" class="dropdown__shortcut">{{ chord('export.pdfPrint') }}</span>
              </span>
              <span class="dropdown__path">{{ t('toolbar.exportPdfPrintHint') }}</span>
            </button>
            <button class="dropdown__item" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.exportPdf())">
              <span class="dropdown__name">{{ t('toolbar.exportPdf') }}</span>
              <span class="dropdown__path">{{ t('toolbar.exportPdfHint') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.exportImage())">
              <span class="dropdown__name">{{ t('toolbar.exportImage') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.copyAsHtml())">
              <span class="dropdown__name">{{ t('toolbar.copyHtml') }}</span>
              <span v-if="chord('export.copyHtml')" class="dropdown__shortcut">{{ chord('export.copyHtml') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.copyAsPlainText())">
              <span class="dropdown__name">{{ t('toolbar.copyPlain') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.copyAsMarkdown())">
              <span class="dropdown__name">{{ t('toolbar.copyMarkdown') }}</span>
              <span v-if="chord('export.copyMd')" class="dropdown__shortcut">{{ chord('export.copyMd') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => exporter.copyAsImage())">
              <span class="dropdown__name">{{ t('toolbar.copyImage') }}</span>
            </button>
            <template v-if="isIOS()">
              <div class="dropdown__sep"></div>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(onOpenExternal)">
                <span class="dropdown__name">{{ t('header.share') }}</span>
              </button>
            </template>
          </div>
        </Teleport>
      </div>

      <button
        v-if="!isNarrow"
        class="icon-btn"
        :class="{ active: !settings.rightSidebarHidden }"
        @click="settings.toggleRightSidebar"
        :title="tip('toolbar.rightSidebarTooltip', 'view.toggleRightSidebar')"
        :aria-label="t('toolbar.rightSidebarTooltip')"
        :aria-pressed="!settings.rightSidebarHidden"
      >
        <Icon name="sidebar-right" />
      </button>

      <div class="dropdown">
        <button
          ref="moreBtnRef"
          class="icon-btn"
          aria-haspopup="menu"
          :aria-expanded="moreOpen"
          :class="{ active: moreOpen }"
          @click="toggleDropdown('more', $event)"
          @keydown.down.prevent="openByKey('more')"
          :title="t('header.more')"
          :aria-label="t('header.more')"
        >
          <Icon name="more" />
        </button>
        <Teleport to="body">
          <div
            v-if="moreOpen"
            class="dropdown__menu dropdown__menu--more"
            role="menu"
            data-tb-menu
            :style="floatStyle"
            @keydown="onMenuKeydown"
          >
            <!-- Root page -->
            <template v-if="morePage === 'root'">
              <!-- A phone or a narrow window has no room for the switch. -->
              <template v-if="isNarrow && isMarkdown">
                <div class="dropdown__heading">{{ t('header.viewModes') }}</div>
                <button
                  v-for="m in segModes"
                  :key="m.mode"
                  class="dropdown__item dropdown__item--single"
                  role="menuitemradio"
                  :aria-checked="settings.viewMode === m.mode"
                  tabindex="-1"
                  @mousedown.prevent="pickViewMode(m.mode)"
                >
                  <span class="dropdown__check">{{ settings.viewMode === m.mode ? '✓' : '' }}</span>
                  <span class="dropdown__name">{{ t(m.label) }}</span>
                </button>
                <div class="dropdown__sep"></div>
              </template>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => files.newFile())">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.newMarkdown') }}</span>
                <span v-if="chord('file.new')" class="dropdown__shortcut">{{ chord('file.new') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => files.newTextFile())">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('menubar.newText') }}</span>
                <span v-if="chord('file.newText')" class="dropdown__shortcut">{{ chord('file.newText') }}</span>
              </button>
              <div class="dropdown__sep"></div>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => files.openFile())">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('menubar.openFile') }}</span>
                <span v-if="chord('file.open')" class="dropdown__shortcut">{{ chord('file.open') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => files.openFolder())">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('menubar.openFolder') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single dropdown__item--sub" role="menuitem" tabindex="-1" @mousedown.prevent="goMorePage('recent')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('menubar.openRecent') }}</span>
                <span class="dropdown__shortcut"><Icon name="chevron-right" :size="12" /></span>
              </button>
              <div class="dropdown__sep"></div>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => files.saveActive())">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.save') }}</span>
                <span v-if="chord('file.save')" class="dropdown__shortcut">{{ chord('file.save') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => files.saveActiveAs())">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('menubar.saveAs') }}</span>
                <span v-if="chord('file.saveAs')" class="dropdown__shortcut">{{ chord('file.saveAs') }}</span>
              </button>
              <template v-if="isMarkdown">
                <div class="dropdown__sep"></div>
                <button class="dropdown__item dropdown__item--single dropdown__item--sub" role="menuitem" tabindex="-1" @mousedown.prevent="goMorePage('insert')">
                  <span class="dropdown__check"></span>
                  <span class="dropdown__name">{{ t('header.insert') }}</span>
                  <span class="dropdown__shortcut"><Icon name="chevron-right" :size="12" /></span>
                </button>
                <button
                  v-if="aiRewriteAvailable"
                  class="dropdown__item dropdown__item--single dropdown__item--sub"
                  role="menuitem"
                  tabindex="-1"
                  @mousedown.prevent="goMorePage('ai')"
                >
                  <span class="dropdown__check"></span>
                  <span class="dropdown__name">{{ t('header.ai') }}</span>
                  <span class="dropdown__shortcut"><Icon name="chevron-right" :size="12" /></span>
                </button>
                <button
                  v-else
                  class="dropdown__item dropdown__item--single"
                  role="menuitem"
                  tabindex="-1"
                  @mousedown.prevent="act(onCleanAI)"
                >
                  <span class="dropdown__check"></span>
                  <span class="dropdown__name">{{ t('toolbar.cleanAiMarks') }}</span>
                </button>
              </template>
              <div class="dropdown__sep"></div>
              <button
                v-if="isNarrow"
                class="dropdown__item dropdown__item--single"
                role="menuitemcheckbox"
                :aria-checked="!settings.rightSidebarHidden"
                tabindex="-1"
                @mousedown.prevent="act(() => settings.toggleRightSidebar())"
              >
                <span class="dropdown__check">{{ settings.rightSidebarHidden ? '' : '✓' }}</span>
                <span class="dropdown__name">{{ t('menubar.toggleRightSidebar') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => $emit('open-palette'))">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('header.palette') }}</span>
                <span v-if="chord('palette.open')" class="dropdown__shortcut">{{ chord('palette.open') }}</span>
              </button>
              <button
                class="dropdown__item dropdown__item--single"
                :class="{ 'dropdown__item--disabled': settings.viewMode === 'preview' }"
                role="menuitemcheckbox"
                :aria-checked="settings.focusMode"
                tabindex="-1"
                :disabled="settings.viewMode === 'preview'"
                @mousedown.prevent="act(() => settings.toggleFocusMode())"
              >
                <span class="dropdown__check">{{ settings.focusMode ? '✓' : '' }}</span>
                <span class="dropdown__name">{{ t('menubar.focusMode') }}</span>
              </button>
              <button
                class="dropdown__item dropdown__item--single"
                :class="{ 'dropdown__item--disabled': settings.viewMode === 'preview' }"
                role="menuitemcheckbox"
                :aria-checked="settings.typewriterMode"
                tabindex="-1"
                :disabled="settings.viewMode === 'preview'"
                @mousedown.prevent="act(() => settings.toggleTypewriterMode())"
              >
                <span class="dropdown__check">{{ settings.typewriterMode ? '✓' : '' }}</span>
                <span class="dropdown__name">{{ t('menubar.typewriterMode') }}</span>
              </button>
              <button
                class="dropdown__item dropdown__item--single"
                :class="{ 'dropdown__item--disabled': settings.viewMode === 'preview' }"
                role="menuitemcheckbox"
                :aria-checked="settings.spellCheck"
                tabindex="-1"
                :disabled="settings.viewMode === 'preview'"
                @mousedown.prevent="act(() => settings.toggleSpellCheck())"
              >
                <span class="dropdown__check">{{ settings.spellCheck ? '✓' : '' }}</span>
                <span class="dropdown__name">{{ t('menubar.spellCheck') }}</span>
              </button>
              <button
                v-if="isMarkdown"
                class="dropdown__item dropdown__item--single"
                :class="{ 'dropdown__item--disabled': settings.viewMode === 'preview' }"
                role="menuitem"
                tabindex="-1"
                :disabled="settings.viewMode === 'preview'"
                @mousedown.prevent="act(onOpenCjkProofread)"
              >
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('proofread.heading') }}</span>
                <span v-if="chord('proofread.cjk')" class="dropdown__shortcut">{{ chord('proofread.cjk') }}</span>
              </button>
              <div class="dropdown__sep"></div>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(onOpenExternal)">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ isIOS() ? t('header.share') : t('header.openExternal') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitemcheckbox" :aria-checked="settings.theme === 'dark'" tabindex="-1" @mousedown.prevent="toggleThemeFromMenu()">
                <span class="dropdown__check">{{ settings.theme === 'dark' ? '✓' : '' }}</span>
                <span class="dropdown__name">{{ t('toolbar.darkMode') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => $emit('open-help'))">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.helpTooltip') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => $emit('open-settings'))">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('header.settings') }}</span>
                <span v-if="chord('settings.open')" class="dropdown__shortcut">{{ chord('settings.open') }}</span>
              </button>
            </template>

            <!-- Sub-pages share a back row -->
            <template v-else>
              <button class="dropdown__item dropdown__item--single dropdown__item--back" role="menuitem" tabindex="-1" @mousedown.prevent="goMorePage('root')">
                <span class="dropdown__check"><Icon name="chevron-left" :size="12" /></span>
                <span class="dropdown__name">{{ morePage === 'insert' ? t('header.insert') : morePage === 'recent' ? t('menubar.openRecent') : t('header.ai') }}</span>
              </button>
              <div class="dropdown__sep"></div>
            </template>

            <template v-if="morePage === 'insert'">
              <!-- #296 — formatting commands wrap the selection; snippets below insert. -->
              <button
                v-for="f in formatItems"
                :key="f.kind"
                class="dropdown__item dropdown__item--single"
                role="menuitem"
                tabindex="-1"
                @mousedown.prevent="dispatchFormat(f.kind)"
              >
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t(f.label) }}</span>
                <span v-if="chord(f.action)" class="dropdown__shortcut">{{ chord(f.action) }}</span>
              </button>
              <div class="dropdown__sep"></div>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchFormat('codeblock')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertCodeBlock') }}</span>
                <span v-if="chord('fmt.codeblock')" class="dropdown__shortcut">{{ chord('fmt.codeblock') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchFormat('code')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertInlineCode') }}</span>
                <span v-if="chord('fmt.code')" class="dropdown__shortcut">{{ chord('fmt.code') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchInsert('\n$$\n$|$\n$$\n')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertMathBlock') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchInsert('$$|$$')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertMathInline') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchInsert('\n| $|$ | Header |\n| --- | --- |\n| cell | cell |\n')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertTable') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchInsert('\n```mermaid\ngraph TD\n  A[$|$] --> B[End]\n```\n')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertMermaid') }}</span>
              </button>
              <div class="dropdown__sep"></div>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchFormat('link')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertLink') }}</span>
                <span v-if="chord('fmt.link')" class="dropdown__shortcut">{{ chord('fmt.link') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="pickAndInsertImage()">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertImage') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="openImageUrlDialog()">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertNetworkImage') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchFormat('quote')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertQuote') }}</span>
                <span v-if="chord('fmt.quote')" class="dropdown__shortcut">{{ chord('fmt.quote') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="dispatchInsert('\n---\n')">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.insertDivider') }}</span>
              </button>
            </template>

            <template v-if="morePage === 'recent'">
              <div v-if="!workspace.recentFiles.length" class="dropdown__empty">{{ t('header.noRecent') }}</div>
              <button
                v-for="p in workspace.recentFiles"
                :key="p"
                class="dropdown__item dropdown__item--recent"
                role="menuitem"
                tabindex="-1"
                @mousedown.prevent="act(() => files.openPath(p))"
                :title="p"
              >
                <span class="dropdown__name">{{ shortPath(p) }}</span>
                <span class="dropdown__path">{{ p }}</span>
                <!-- #112 — remove ONE stale entry without touching the file. -->
                <span
                  class="dropdown__remove"
                  role="button"
                  :title="t('toolbar.removeRecent')"
                  @mousedown.stop.prevent="workspace.removeRecent(p)"
                ><Icon name="close" :size="11" /></span>
              </button>
              <template v-if="workspace.recentFiles.length">
                <div class="dropdown__sep"></div>
                <button class="dropdown__item dropdown__item--single dropdown__item--muted" role="menuitem" tabindex="-1" @mousedown.prevent="act(() => workspace.clearRecent())">
                  <span class="dropdown__check"></span>
                  <span class="dropdown__name">{{ t('toolbar.clearRecent') }}</span>
                </button>
              </template>
            </template>

            <template v-if="morePage === 'ai'">
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(onAIRewrite)">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('cmd.editor.aiRewrite') }}</span>
                <span v-if="chord('editor.aiRewrite')" class="dropdown__shortcut">{{ chord('editor.aiRewrite') }}</span>
              </button>
              <button class="dropdown__item dropdown__item--single" role="menuitem" tabindex="-1" @mousedown.prevent="act(onCleanAI)">
                <span class="dropdown__check"></span>
                <span class="dropdown__name">{{ t('toolbar.cleanAiMarks') }}</span>
              </button>
            </template>
          </div>
        </Teleport>
      </div>
    </div>

    <!-- Writing-session presets, opened from the palette ("solomd:open-pomodoro"). -->
    <Teleport to="body">
      <div v-if="pomoOpen" class="dropdown pomo-anchor" :style="pomoAnchorStyle">
        <PomodoroPopover :open="pomoOpen" @close="pomoOpen = false" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ── Header (spec §3) ──────────────────────────────────────────────────── */
.toolbar {
  position: relative;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--header-h);
  flex-shrink: 0;
  padding: 0 10px 0 12px;
  background: var(--bg);
  border-bottom: var(--bd-hair);
  user-select: none;
  -webkit-user-select: none;
}
/* Sidebar hidden on macOS: the traffic lights now float over the header's
   left end (they sit at x≈20…72 in the 52px line). */
.toolbar--mac.toolbar--lead {
  padding-left: 80px;
}
.toolbar--minimal .toolbar__tabs {
  justify-content: center;
}
.toolbar__sidebar-btn {
  margin-right: 2px;
}
.toolbar__tabs {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
}
.toolbar__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.dropdown {
  position: relative;
  display: inline-flex;
}

/* Icon buttons — 32px, quiet until hovered. */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-2);
  cursor: default;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.icon-btn:hover {
  background: var(--fill-1);
  color: var(--text);
}
.icon-btn:active,
.icon-btn.active {
  background: var(--fill-2);
  color: var(--text);
}
.icon-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}

/* Touch screens (iPad): finger-sized targets in the header. */
@media (pointer: coarse) {
  .icon-btn {
    width: 40px;
    height: 40px;
  }
  .seg__btn {
    height: 32px;
    padding: 0 14px;
  }
}
/* ── Phone nav bar (5.0 §8) ──────────────────────────────────────────── */
.toolbar--narrow {
  padding: 0 4px 0 2px;
  gap: 2px;
}
.toolbar--narrow .toolbar__tabs {
  display: none;
}
.toolbar--narrow .icon-btn {
  width: 44px;
  height: 44px;
  color: var(--accent-text);
}
.toolbar__back {
  display: inline-flex;
  align-items: center;
  gap: 0;
  height: 44px;
  padding: 0 6px 0 2px;
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font: inherit;
  font-size: 16px;
  flex-shrink: 0;
  -webkit-tap-highlight-color: transparent;
}
.toolbar__back:active {
  opacity: 0.5;
}
.toolbar__phone-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

/* ── Segmented 实时 / 源码 / 预览 — the thumb slides ─────────────────── */
.seg {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, minmax(44px, 1fr));
  grid-auto-columns: 1fr;
  padding: 3px;
  gap: 0;
  border-radius: var(--r-md);
  background: var(--fill-1);
  flex-shrink: 0;
  margin: 0 6px;
}
.seg__thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc((100% - 6px) / 4);
  border-radius: var(--r-sm);
  background: var(--bg);
  box-shadow: var(--sh-thumb);
  transform: translateX(calc(var(--seg-i) * 100%));
  transition: transform var(--dur) var(--ease-out), opacity var(--dur-fast);
}
:root[data-theme="dark"] .seg__thumb {
  background: var(--fill-2);
}
.seg--none .seg__thumb {
  opacity: 0;
}
.seg__btn {
  position: relative;
  z-index: 1;
  height: 26px;
  min-width: 0;
  padding: 0 12px;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 12px;
  font-weight: 450;
  color: var(--text-2);
  white-space: nowrap;
  cursor: default;
  border-radius: var(--r-sm);
  transition: color var(--dur-fast) var(--ease-out);
}
.seg__btn:hover {
  color: var(--text);
}
.seg__btn.is-on {
  color: var(--text);
  font-weight: 560;
}
.seg__btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
/* The switch needs ~180px; below ~640px it moves into "More". */
.toolbar--narrow .seg {
  display: none;
}

/* ── Windows title bar ─────────────────────────────────────────────────── */
.toolbar--titlebar {
  height: var(--win-titlebar-h);
  padding: 0;
  gap: 0;
  background: var(--bg-sidebar);
  z-index: 30;
}
.titlebar__icon {
  width: 44px;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.titlebar__title {
  position: absolute;
  left: 50%;
  top: 0;
  height: 100%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--text-3);
  pointer-events: none;
}
.menubar {
  display: flex;
  align-items: center;
  position: relative;
  z-index: 1;
}
.menubar__btn {
  height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  cursor: default;
}
.menubar__btn:hover,
.menubar__btn.active {
  background: var(--fill-1);
}
.win-controls {
  display: flex;
  margin-left: auto;
  height: 100%;
  position: relative;
  z-index: 1;
}
.win-controls__btn {
  width: 46px;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-2);
  cursor: default;
}
.win-controls__btn:hover,
.win-controls__btn.is-hover {
  background: var(--fill-1);
  color: var(--text);
}
.win-controls__btn--close:hover {
  background: #c42b1c;
  color: #fff;
}

/* ── Menus (structure; the look is styles/menus.css) ───────────────────── */
.pomo-anchor {
  pointer-events: auto;
}
.dropdown__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: min(240px, calc(100vw - 16px));
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  z-index: var(--z-pop);
  padding: 4px;
  max-height: 360px;
  overflow-y: auto;
}
.dropdown__menu--more {
  min-width: min(264px, calc(100vw - 16px));
}
.dropdown__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  min-height: 28px;
  padding: 4px 10px;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--text);
  border-radius: var(--r-sm);
  cursor: default;
}
.dropdown__item:hover,
.dropdown__item:focus-visible {
  outline: none;
  background: var(--fill-1);
}
.dropdown__item--single {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.dropdown__name {
  color: inherit;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dropdown__path {
  color: var(--text-3);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.dropdown__heading {
  padding: 6px 10px 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.dropdown__row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
}
.dropdown__check {
  flex: 0 0 16px;
  width: 16px;
  display: inline-flex;
  justify-content: center;
  color: var(--text);
  font-size: 12px;
}
.dropdown__item--back .dropdown__name {
  font-weight: 600;
}
.dropdown__shortcut {
  margin-left: auto;
  padding-left: 16px;
  display: inline-flex;
  align-items: center;
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
}
.dropdown__item--sub.active {
  background: var(--fill-1);
}
.dropdown__item--muted {
  color: var(--text-2);
}
.dropdown__item--disabled,
.dropdown__item:disabled {
  color: var(--text-3);
}
.dropdown__item--disabled:hover,
.dropdown__item:disabled:hover {
  background: transparent;
}
/* #112 — per-entry recents removal, revealed on hover. */
.dropdown__item--recent {
  position: relative;
  padding-right: 28px;
}
.dropdown__remove {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  display: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--r-xs);
  color: var(--text-3);
}
.dropdown__item--recent:hover .dropdown__remove {
  display: inline-flex;
}
.dropdown__remove:hover {
  color: var(--text);
  background: var(--fill-2);
}
.dropdown__sep {
  height: var(--hair-w);
  background: var(--hairline);
  margin: 4px 8px;
}
.dropdown__empty {
  padding: 12px;
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
</style>
