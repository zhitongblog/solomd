<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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
import { useExport } from '../composables/useExport';
import { useToastsStore } from '../stores/toasts';
import { cleanAIArtifacts } from '../lib/clean-ai';
import { useI18n } from '../i18n';
import { openPath } from '@tauri-apps/plugin-opener';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { forceWinChromePreview, isIOS, isMacOS, isWindowsDesktop } from '../lib/platform';
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import { EditorView } from '@codemirror/view';

const { t } = useI18n();

defineEmits<{
  (e: 'open-palette'): void;
  (e: 'open-settings'): void;
  (e: 'open-help'): void;
  (e: 'open-search'): void;
}>();

const tabs = useTabsStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const tiles = useTilesStore();
const files = useFiles();
const exporter = useExport();
const toasts = useToastsStore();

const isMarkdown = computed(() => tabs.activeTab?.language === 'markdown');

// v4.6 unified title bar (macOS only). With `titleBarStyle: "Overlay"` in
// tauri.conf, the red/yellow/green traffic lights float over the top-left of
// our toolbar instead of sitting in a separate native title bar above it —
// one combined bar (Tolaria-style). We reserve ~72px on the left for them and
// make the bar background draggable. Windows / Linux keep native decorations
// and get neither the pad nor the drag region. Computed once at module init
// (platform doesn't change at runtime).
const macTitleBar = isMacOS();

// Windows unified title bar. The Windows build is frameless (`decorations:
// false` in tauri.windows.conf.json), so the toolbar row also hosts the
// File/Edit/View/Help menubar (replacing the removed native menu bar) and the
// min/max/close caption buttons. `?forceWinChrome` previews the layout in the
// macOS dev build (window keeps its own chrome there; caption buttons no-op).
const hasTauriShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const winTitleBar =
  (isWindowsDesktop() && hasTauriShell) || (import.meta.env.DEV && forceWinChromePreview());
const customTitleBar = macTitleBar || winTitleBar;

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
    'button, input, select, textarea, a, [contenteditable="true"], .dropdown__menu, [data-no-drag]',
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

// #134 — when the bar overflows on a narrow window, let a plain mouse wheel
// scroll it horizontally so the clipped buttons stay reachable (trackpads
// already emit horizontal deltas natively). Leave Ctrl/Cmd+wheel alone — that
// is the app-wide zoom gesture handled in App.vue.
function onToolbarWheel(e: WheelEvent) {
  if (e.ctrlKey || e.metaKey || e.deltaY === 0) return;
  const el = e.currentTarget as HTMLElement;
  if (el.scrollWidth <= el.clientWidth) return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
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
    const jChord = isMacOS() ? '⌘J' : 'Ctrl+J';
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
  // doesn't handle `file://` URLs — and the JS plugin's scope check
  // (`$HOME/**`) rejects paths from deep-linked Files-app sources before
  // we even get to the native call. Route through the Web Share API
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

const recentOpen = ref(false);
const exportOpen = ref(false);
const newOpen = ref(false);
const insertOpen = ref(false);
const pomoOpen = ref(false);

const newBtnRef = ref<HTMLElement | null>(null);
const recentBtnRef = ref<HTMLElement | null>(null);
const exportBtnRef = ref<HTMLElement | null>(null);
const insertBtnRef = ref<HTMLElement | null>(null);
const menuPos = ref<{ top: number; left?: number; right?: number } | null>(null);
const floatStyle = computed<Record<string, string | number> | undefined>(() => {
  if (!menuPos.value) return undefined;
  const s: Record<string, string | number> = {
    position: 'fixed',
    top: `${menuPos.value.top}px`,
    zIndex: 1000,
  };
  if (menuPos.value.left !== undefined) s.left = `${menuPos.value.left}px`;
  if (menuPos.value.right !== undefined) s.right = `${menuPos.value.right}px`;
  return s;
});
function positionMenuFromButton(btn: HTMLElement | null, align: 'left' | 'right' = 'left') {
  if (!btn) { menuPos.value = null; return; }
  const rect = btn.getBoundingClientRect();
  if (align === 'right') {
    menuPos.value = { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) };
  } else {
    menuPos.value = { top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 16) };
  }
}

function togglePomo() {
  // Mirror the same exclusive-open behaviour as the other dropdowns.
  closeAllDropdowns();
  pomoOpen.value = !pomoOpen.value;
}

function dispatchInsert(snippet: string) {
  window.dispatchEvent(
    new CustomEvent('solomd:insert-markdown', {
      detail: { snippet, paneId: tiles.focusedPaneId },
    })
  );
  insertOpen.value = false;
}

async function pickAndInsertImage() {
  insertOpen.value = false;
  const sel = await openFileDialog({
    multiple: false,
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
  insertOpen.value = false;
  window.dispatchEvent(new CustomEvent('solomd:open-image-url-dialog'));
}

function shortPath(p: string) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Close any open dropdown when user clicks outside.
// More reliable than @blur which doesn't fire consistently across browsers.
function closeAllDropdowns() {
  newOpen.value = false;
  recentOpen.value = false;
  exportOpen.value = false;
  insertOpen.value = false;
  pomoOpen.value = false;
  menubarOpen.value = null;
}

// ── Windows unified title bar: in-app menubar ────────────────────────────────
// Replaces the native Windows menu bar (removed together with the window
// decorations). Item ids mirror runner.rs's native menu ids exactly; App.vue's
// `dispatchMenuAction` handles both, so the two menus can never drift apart in
// behavior. Rendered only when `winTitleBar`.
type MenubarName = 'file' | 'edit' | 'view' | 'help';
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
function menuAction(id: string) {
  menubarOpen.value = null;
  // Same dispatch surface the native menus use (App.vue listens for both this
  // DOM event and the Tauri `solomd://menu` event).
  window.dispatchEvent(new CustomEvent('solomd:menu-action', { detail: id }));
}
type MenubarEntry = { id: string; label: string; shortcut?: string } | { sep: true };
// Shortcut labels show what the JS handlers (useShortcuts.ts) actually bind on
// Windows — NOT the old native accelerators where the two differ (e.g. Ctrl+P
// is the quick switcher, so Print shows Ctrl+Alt+Shift+P).
const menubarMenus = computed<Record<MenubarName, MenubarEntry[]>>(() => ({
  file: [
    { id: 'file.new', label: t('menubar.newMd'), shortcut: 'Ctrl+N' },
    { id: 'file.newText', label: t('menubar.newText'), shortcut: 'Ctrl+Alt+N' },
    { sep: true },
    { id: 'file.open', label: t('menubar.openFile'), shortcut: 'Ctrl+O' },
    { id: 'file.openFolder', label: t('menubar.openFolder') },
    { sep: true },
    { id: 'file.save', label: t('menubar.save'), shortcut: 'Ctrl+S' },
    { id: 'file.saveAs', label: t('menubar.saveAs'), shortcut: 'Ctrl+Shift+S' },
    { sep: true },
    { id: 'file.openExternal', label: t('menubar.openExternal'), shortcut: 'Ctrl+Shift+E' },
    { sep: true },
    { id: 'file.print', label: t('menubar.print'), shortcut: 'Ctrl+Alt+Shift+P' },
    { sep: true },
    { id: 'window.new', label: t('menubar.newWindow'), shortcut: 'Ctrl+Shift+N' },
    { id: 'file.closeTab', label: t('menubar.closeTab'), shortcut: 'Ctrl+W' },
    { sep: true },
    // #221 — parity with the removed native menu's quit item.
    { id: 'file.exit', label: t('menubar.exit'), shortcut: 'Alt+F4' },
  ],
  edit: [
    { id: 'edit.undo', label: t('menubar.undo'), shortcut: 'Ctrl+Z' },
    { id: 'edit.redo', label: t('menubar.redo'), shortcut: 'Ctrl+Y' },
    { sep: true },
    { id: 'edit.cut', label: t('menubar.cut'), shortcut: 'Ctrl+X' },
    { id: 'edit.copy', label: t('menubar.copy'), shortcut: 'Ctrl+C' },
    { id: 'edit.paste', label: t('menubar.paste'), shortcut: 'Ctrl+V' },
    { sep: true },
    { id: 'edit.selectAll', label: t('menubar.selectAll'), shortcut: 'Ctrl+A' },
  ],
  view: [
    { id: 'view.toggleTheme', label: t('menubar.toggleTheme') },
    { sep: true },
    { id: 'view.toggleFileTree', label: t('menubar.toggleFileTree'), shortcut: 'Ctrl+B' },
    { id: 'view.toggleOutline', label: t('menubar.toggleOutline'), shortcut: 'Ctrl+Shift+O' },
    { id: 'view.cycleView', label: t('menubar.cycleView'), shortcut: 'Ctrl+Shift+P' },
    { sep: true },
    { id: 'view.zoomUiIn', label: t('menubar.uiZoomIn'), shortcut: 'Ctrl+=' },
    { id: 'view.zoomUiOut', label: t('menubar.uiZoomOut'), shortcut: 'Ctrl+-' },
    { id: 'view.zoomUiReset', label: t('menubar.uiZoomReset'), shortcut: 'Ctrl+0' },
    { sep: true },
    { id: 'view.zoomEditorIn', label: t('menubar.editorZoomIn'), shortcut: 'Ctrl+Shift+=' },
    { id: 'view.zoomEditorOut', label: t('menubar.editorZoomOut'), shortcut: 'Ctrl+Shift+-' },
    { id: 'view.zoomEditorReset', label: t('menubar.editorZoomReset'), shortcut: 'Ctrl+Shift+0' },
    { sep: true },
    { id: 'view.zoomPreviewIn', label: t('menubar.previewZoomIn') },
    { id: 'view.zoomPreviewOut', label: t('menubar.previewZoomOut') },
    { id: 'view.zoomPreviewReset', label: t('menubar.previewZoomReset') },
    { sep: true },
    { id: 'view.cmdPalette', label: t('menubar.palette'), shortcut: 'Ctrl+Shift+K' },
    { id: 'search.global', label: t('menubar.globalSearch'), shortcut: 'Ctrl+Shift+F' },
    { sep: true },
    { id: 'view.settings', label: t('menubar.settings'), shortcut: 'Ctrl+,' },
  ],
  help: [
    { id: 'help.markdown', label: t('menubar.mdHelp'), shortcut: 'F1' },
    { sep: true },
    { id: 'help.about', label: t('menubar.about') },
  ],
}));
const menubarNames: MenubarName[] = ['file', 'edit', 'view', 'help'];

// Root element — used by onScrollAnywhere to tell "a scroll that moves the
// menu anchors" (toolbar's own overflow scroll) from pane scrolls.
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
  if (!winTitleBar || !hasTauriShell || !isWindowsDesktop()) return;
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
  if (!winTitleBar || !hasTauriShell) return;
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
  if (!winTitleBar) return;
  window.removeEventListener('resize', reportMaxBtnRect);
  for (const un of unlistenWinChrome) un();
  unlistenWinChrome = [];
  if (hasTauriShell && isWindowsDesktop()) {
    void invoke('set_max_button_rect', { x: 0, y: 0, w: 0, h: 0, scale: 1 });
  }
});
// Exclusive open: opening one dropdown closes others.
function toggleDropdown(name: 'new' | 'recent' | 'export' | 'insert') {
  const isOpen =
    (name === 'new' && newOpen.value) ||
    (name === 'recent' && recentOpen.value) ||
    (name === 'export' && exportOpen.value) ||
    (name === 'insert' && insertOpen.value);
  closeAllDropdowns();
  if (!isOpen) {
    if (name === 'new') { positionMenuFromButton(newBtnRef.value); newOpen.value = true; }
    else if (name === 'recent') { positionMenuFromButton(recentBtnRef.value); recentOpen.value = true; }
    else if (name === 'export') { positionMenuFromButton(exportBtnRef.value); exportOpen.value = true; }
    else if (name === 'insert') { positionMenuFromButton(insertBtnRef.value); insertOpen.value = true; }
  }
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
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onScrollAnywhere, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onScrollAnywhere, true);
});
</script>

<template>
  <div
    ref="toolbarRef"
    class="toolbar"
    :class="{ 'toolbar--mac': macTitleBar, 'toolbar--win': winTitleBar }"
    @mousedown.capture="onTitleBarMouseDown"
    @dblclick="onTitleBarDblClick"
    @wheel="onToolbarWheel"
  >
    <BrandMark class="toolbar__brand" :size="22" />

    <!-- Windows unified title bar: in-app File/Edit/View/Help menubar
         (replaces the removed native menu bar row). -->
    <nav v-if="winTitleBar" class="menubar" data-no-drag>
      <button
        v-for="name in menubarNames"
        :key="name"
        class="menubar__btn"
        :class="{ active: menubarOpen === name }"
        @click="toggleMenubar(name, $event)"
        @mouseenter="menubarHover(name, $event)"
      >{{ t(`menubar.${name}`) }}</button>
      <Teleport to="body">
        <div v-if="menubarOpen" class="dropdown__menu" :style="floatStyle">
          <template v-for="(entry, i) in menubarMenus[menubarOpen]" :key="i">
            <div v-if="'sep' in entry" class="dropdown__sep"></div>
            <button
              v-else
              class="dropdown__item dropdown__item--single"
              @mousedown.prevent="menuAction(entry.id)"
            >
              <span class="dropdown__name">{{ entry.label }}</span>
              <span v-if="entry.shortcut" class="dropdown__shortcut">{{ entry.shortcut }}</span>
            </button>
          </template>
        </div>
      </Teleport>
    </nav>

    <span
      v-if="tabs.activeTab?.fileName"
      class="toolbar__title"
      :title="tabs.activeTab?.filePath || tabs.activeTab?.fileName"
    >{{ tabs.activeTab.fileName }}</span>

    <div class="toolbar__group">
      <div class="dropdown">
        <button
          ref="newBtnRef"
          class="icon-btn"
          @click="toggleDropdown('new')"
          :title="t('toolbar.newFile')"
        >
          <Icon name="new" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="newOpen" class="dropdown__menu dropdown__menu--narrow" :style="floatStyle">
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="files.newFile(); newOpen = false">
              <Icon name="new" />
              <span class="dropdown__name">{{ t('toolbar.newMarkdown') }}</span>
              <span class="dropdown__shortcut">Ctrl+N</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="files.newTextFile(); newOpen = false">
              <Icon name="new-text" />
              <span class="dropdown__name">{{ t('toolbar.newPlainText') }}</span>
              <span class="dropdown__shortcut">Ctrl+Alt+N</span>
            </button>
          </div>
        </Teleport>
      </div>
      <button class="icon-btn" @click="files.openFile" :title="t('toolbar.openFileTooltip')">
        <Icon name="open" />
      </button>
      <div class="dropdown">
        <button
          ref="recentBtnRef"
          class="icon-btn"
          @click="toggleDropdown('recent')"
          :title="t('toolbar.recent')"
        >
          <Icon name="recent" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="recentOpen" class="dropdown__menu" :style="floatStyle">
            <div v-if="!workspace.recentFiles.length" class="dropdown__empty">{{ t('toolbar.noRecent') }}</div>
            <button
              v-for="p in workspace.recentFiles"
              :key="p"
              class="dropdown__item dropdown__item--recent"
              @mousedown.prevent="files.openPath(p); recentOpen = false"
              :title="p"
            >
              <span class="dropdown__name">{{ shortPath(p) }}</span>
              <span class="dropdown__path">{{ p }}</span>
              <!-- #112 — remove ONE stale entry without touching the file
                   (the only management before this was nuke-the-whole-list). -->
              <span
                class="dropdown__remove"
                role="button"
                :title="t('toolbar.removeRecent')"
                @mousedown.stop.prevent="workspace.removeRecent(p)"
              >✕</span>
            </button>
            <div v-if="workspace.recentFiles.length" class="dropdown__sep"></div>
            <button
              v-if="workspace.recentFiles.length"
              class="dropdown__item dropdown__item--muted"
              @mousedown.prevent="workspace.clearRecent(); recentOpen = false"
            >{{ t('toolbar.clearRecent') }}</button>
          </div>
        </Teleport>
      </div>
      <button class="icon-btn" @click="files.openFolder" v-bind:title="t('toolbar.openFolder')">
        <Icon name="folder" />
      </button>
      <button class="icon-btn" @click="files.saveActive" v-bind:title="t('toolbar.save') + ' (Ctrl+S)'">
        <Icon name="save" />
      </button>
      <button class="icon-btn" @click="files.saveActiveAs" :title="t('toolbar.saveAsTooltip')">
        <Icon name="save-as" />
      </button>
      <button class="icon-btn" @click="onOpenExternal" :title="t('toolbar.openExternalTooltip')">
        <Icon name="external" />
      </button>
      <div class="dropdown">
        <button
          ref="exportBtnRef"
          class="icon-btn"
          @click="toggleDropdown('export')"
          :title="t('toolbar.exportTooltip')"
        >
          <Icon name="export" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="exportOpen" class="dropdown__menu" :style="floatStyle">
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportHtml(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportHtml') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportDocx(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportDocx') }}</span>
            </button>
            <!-- Gitee IK8QJQ — these two produce very different PDFs and the
                 names alone did not say so. `exportPdf` goes through
                 html2pdf.js (html2canvas), which rasterises the page, so the
                 text is not selectable and files run several times larger;
                 `exportPdfPrint` hands off to the OS print engine and yields
                 real vector text. Both are worth keeping — the raster path
                 saves straight to a file with no dialog — so label the
                 tradeoff rather than hide it, and lead with the text one. -->
            <button class="dropdown__item" @mousedown.prevent="exporter.exportPdfPrint(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportPdfPrint') }}</span>
              <span class="dropdown__path">{{ t('toolbar.exportPdfPrintHint') }}</span>
            </button>
            <button class="dropdown__item" @mousedown.prevent="exporter.exportPdf(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportPdf') }}</span>
              <span class="dropdown__path">{{ t('toolbar.exportPdfHint') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportImage(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportImage') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsHtml(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyHtml') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsPlainText(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyPlain') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsMarkdown(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyMarkdown') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsImage(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyImage') }}</span>
            </button>
          </div>
        </Teleport>
      </div>
    </div>

    <span class="toolbar__divider"></span>

    <div class="toolbar__group">
      <button
        class="icon-btn"
        @click="settings.toggleFileTree"
        :class="{ active: settings.showFileTree }"
        :title="t('toolbar.fileTreeTooltip')"
      >
        <Icon name="sidebar" />
      </button>
      <button
        class="icon-btn"
        @click="settings.toggleRightSidebar"
        :class="{ active: !settings.rightSidebarHidden }"
        :title="t('toolbar.rightSidebarTooltip')"
      >
        <Icon name="sidebar-right" />
      </button>
    </div>

    <div class="toolbar__group" v-if="isMarkdown">
      <div class="dropdown">
        <button
          ref="insertBtnRef"
          class="icon-btn"
          @click="toggleDropdown('insert')"
          :title="t('toolbar.insertTooltip')"
        >
          <Icon name="insert" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="insertOpen" class="dropdown__menu" :style="floatStyle">
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n```\n$|$\n```\n')">
              <span class="dropdown__name">{{ t('toolbar.insertCodeBlock') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('`$|$`')">
              <span class="dropdown__name">{{ t('toolbar.insertInlineCode') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n$$\n$|$\n$$\n')">
              <span class="dropdown__name">{{ t('toolbar.insertMathBlock') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('$$|$$')">
              <span class="dropdown__name">{{ t('toolbar.insertMathInline') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n| $|$ | Header |\n| --- | --- |\n| cell | cell |\n')">
              <span class="dropdown__name">{{ t('toolbar.insertTable') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n```mermaid\ngraph TD\n  A[$|$] --> B[End]\n```\n')">
              <span class="dropdown__name">{{ t('toolbar.insertMermaid') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('[$|$](url)')">
              <span class="dropdown__name">{{ t('toolbar.insertLink') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="pickAndInsertImage()">
              <span class="dropdown__name">{{ t('toolbar.insertImage') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="openImageUrlDialog()">
              <span class="dropdown__name">{{ t('toolbar.insertNetworkImage') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('> $|$')">
              <span class="dropdown__name">{{ t('toolbar.insertQuote') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n---\n')">
              <span class="dropdown__name">{{ t('toolbar.insertDivider') }}</span>
            </button>
          </div>
        </Teleport>
      </div>
    </div>

    <div class="toolbar__group">
      <button
        class="icon-btn clean-ai-btn"
        @click="onCleanAI"
        v-bind:title="t('toolbar.cleanAiTitle')"
      >
        <span class="clean-ai-broom">🧹</span>
        <span class="clean-ai-label">AI</span>
      </button>
      <button
        v-if="!IS_APP_STORE_BUILD"
        class="icon-btn ai-rewrite-btn"
        @mousedown.prevent
        @click="onAIRewrite"
        :title="t('toolbar.aiRewriteTooltip')"
      >
        <span class="ai-rewrite-label">AI</span>
        <span class="ai-rewrite-spark">✨</span>
      </button>
    </div>

    <div class="toolbar__spacer"></div>

    <div class="toolbar__group" v-if="isMarkdown">
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('edit'); track('view_mode', { mode: 'edit' }); }"
        :class="{ active: settings.viewMode === 'edit' }"
        :title="t('toolbar.editOnly')"
      >
        <Icon name="view-edit" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('split'); track('view_mode', { mode: 'split' }); }"
        :class="{ active: settings.viewMode === 'split' }"
        :title="t('toolbar.splitPane')"
      >
        <Icon name="view-split" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('liveEdit'); track('view_mode', { mode: 'liveEdit' }); }"
        :class="{ active: settings.viewMode === 'liveEdit' }"
        :title="t('toolbar.liveEditMode')"
      >
        <Icon name="view-live" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('preview'); track('view_mode', { mode: 'preview' }); }"
        :class="{ active: settings.viewMode === 'preview' }"
        :title="t('toolbar.previewOnly')"
      >
        <Icon name="view-preview" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('reading'); track('view_mode', { mode: 'reading' }); }"
        :class="{ active: settings.viewMode === 'reading' }"
        :title="t('toolbar.readingMode')"
      >
        <Icon name="view-reading" />
      </button>
      <span
        class="toolbar__divider"
        v-if="settings.viewMode !== 'preview' && settings.viewMode !== 'liveEdit'"
      ></span>
      <button
        v-if="settings.viewMode !== 'preview' && settings.viewMode !== 'liveEdit'"
        class="icon-btn"
        @click="() => { settings.toggleLivePreview(); track('live_preview_toggled', { on: settings.livePreview ? 1 : 0 }); }"
        :class="{ active: settings.livePreview }"
        :title="settings.livePreview ? t('toolbar.livePreviewOn') : t('toolbar.livePreviewOff')"
      >
        <Icon :name="settings.livePreview ? 'live' : 'source'" />
      </button>
      <button
        v-if="settings.viewMode === 'split' || settings.viewMode === 'preview' || settings.viewMode === 'reading'"
        class="icon-btn"
        @click="settings.togglePreviewFitWidth"
        :class="{ active: settings.previewFitWidth }"
        :title="t('toolbar.fitWidthTooltip')"
      >
        <Icon name="fit-width" />
      </button>
    </div>

    <span v-if="isMarkdown" class="toolbar__divider"></span>

    <div class="toolbar__group">
      <div class="dropdown focus-with-pomo">
        <button
          class="icon-btn"
          :disabled="settings.viewMode === 'preview'"
          @click="settings.toggleFocusMode"
          :class="{ active: settings.focusMode }"
          :title="t('toolbar.focusModeTooltip')"
        >
          <Icon name="focus" />
        </button>
        <button
          v-if="settings.pomodoroShowControls"
          class="icon-btn pomo-chevron"
          @click="togglePomo"
          :title="t('pomodoro.openMenu')"
          aria-haspopup="dialog"
          :aria-expanded="pomoOpen"
        >
          <Icon name="chevron-down" :size="10" />
        </button>
        <PomodoroPopover :open="pomoOpen" @close="pomoOpen = false" />
      </div>
      <button
        class="icon-btn"
        :disabled="settings.viewMode === 'preview'"
        @click="settings.toggleTypewriterMode"
        :class="{ active: settings.typewriterMode }"
        :title="t('toolbar.typewriterTooltip')"
      >
        <Icon name="typewriter" />
      </button>
      <button
        class="icon-btn"
        :disabled="settings.viewMode === 'preview'"
        @click="settings.toggleSpellCheck"
        :class="{ active: settings.spellCheck }"
        :title="t('toolbar.spellCheckTooltip')"
      >
        <Icon name="spellcheck" />
      </button>
      <button
        class="icon-btn cjk-proof-btn"
        :disabled="settings.viewMode === 'preview'"
        @click="onOpenCjkProofread"
        :title="t('toolbar.cjkProofreadTooltip')"
      >
        <span class="cjk-proof-glyph">中</span>
      </button>
      <span class="toolbar__divider"></span>
      <button class="icon-btn" @click="$emit('open-search')" :title="t('toolbar.searchTooltip')">
        <Icon name="search" />
      </button>
      <button class="icon-btn" @click="$emit('open-palette')" :title="t('toolbar.paletteTooltip')">
        <Icon name="palette" />
      </button>
      <button class="icon-btn" @click="$emit('open-help')" :title="t('toolbar.helpTooltip')">
        <Icon name="help" />
      </button>
      <button class="icon-btn" @click="$emit('open-settings')" :title="t('toolbar.settingsTooltip')">
        <Icon name="settings" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.toggleTheme(); track('theme_changed', { theme: settings.theme }); }"
        :title="settings.theme === 'dark' ? t('toolbar.lightMode') : t('toolbar.darkMode')"
      >
        <Icon :name="settings.theme === 'dark' ? 'theme-light' : 'theme-dark'" />
      </button>
    </div>

    <!-- Windows caption buttons. `position: sticky; right: 0` keeps them
         pinned even when the strip scrolls horizontally on narrow windows.
         The maximize button doubles as the Snap-Layouts target: on the real
         main window the Rust subclass claims its rect via WM_NCHITTEST, so
         hover/click are handled natively and mirrored back through the
         `solomd://maxbtn-hover` event (hence `.is-hover`, not `:hover`). -->
    <div v-if="winTitleBar" class="win-controls" data-no-drag>
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
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--titlebar-h);
  padding: 0 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
  /* #134 — on narrow windows the button groups used to overflow the strip and
     become unclickable (no scroll). The old #181 attempt at `overflow-x: auto`
     was reverted because dropdown menus were `position: absolute` inside the
     bar and got clipped. They are now `<Teleport>`-ed to <body> (see the
     `.dropdown__menu` blocks below) and repositioned on scroll via
     `onViewportChange`, so the strip can scroll horizontally without clipping
     any menu. overflow-y stays hidden so a stray vertical scrollbar can't eat
     into the thin title bar. */
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none; /* Firefox: hide the bar, keep wheel/trackpad scroll */
}
/* WebKit: hide the horizontal scrollbar so it doesn't shrink the ~40px bar. */
.toolbar::-webkit-scrollbar { height: 0; width: 0; }
/* v4.6 unified title bar — macOS only. The native traffic-light buttons are
   overlaid at the top-left by `titleBarStyle: "Overlay"`; reserve room for
   them so they don't sit on top of the brand / New button. ~72px clears the
   three 12px lights + their inset. Windows / Linux keep native decorations
   and never get this class, so their toolbar starts flush-left as before. */
.toolbar--mac {
  padding-left: 72px;
}
/* Windows unified title bar — frameless window, so this row IS the title bar:
   caption buttons render flush against the top-right corner (no padding). */
.toolbar--win {
  padding-right: 0;
}
.menubar {
  display: flex;
  align-items: center;
  gap: 0;
}
.menubar__btn {
  font-size: 12px;
  padding: 4px 9px;
  border-radius: 5px;
  color: var(--text-muted);
  white-space: nowrap;
}
.menubar__btn:hover,
.menubar__btn.active {
  background: var(--bg-active);
  color: var(--text);
}
.win-controls {
  display: flex;
  align-self: stretch;
  align-items: stretch;
  margin-left: auto;
  position: sticky;
  right: 0;
  background: var(--bg-elev);
}
.win-controls__btn {
  width: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  border-radius: 0;
}
.win-controls__btn:hover,
.win-controls__btn.is-hover {
  background: var(--bg-active);
  color: var(--text);
}
/* Snap Layouts (future-proofing — NOT functional today, verified 2026-08-06
   on the Win11-ARM VM). WebView2's non-client region support (wry enables
   IsNonClientRegionSupportEnabled) currently only implements `app-region:
   drag` — COREWEBVIEW2_NON_CLIENT_REGION_KIND has no MAXIMIZE, so this value
   is ignored and the button works through its JS click handler (no hover
   flyout; Win+Arrow / drag-to-edge / drag-to-top snapping all still work
   natively). A top-level WM_NCHITTEST override can't claim the button
   either: the mouse lands on the cross-process Chrome_RenderWidgetHostHWND
   child first, and HTTRANSPARENT bubbling stops at thread boundaries
   (probe4b). If a future runtime adds the maximize region kind, this rule +
   the win_chrome.rs subclass (hover mirror + SC_MAXIMIZE) light up without
   code changes. */
.win-controls__btn--max {
  -webkit-app-region: maximize;
  app-region: maximize;
}
.win-controls__btn--close:hover {
  background: #e81123;
  color: #fff;
}
.toolbar > * { flex-shrink: 0; }
.toolbar__brand {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  flex: 0 0 22px;
  margin-right: 4px;
  pointer-events: none;
}

.toolbar__group {
  display: flex;
  gap: 1px;
  align-items: center;
}
.toolbar__group button {
  font-size: 12px;
  padding: 4px 10px;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
}
.toolbar__group button.active {
  background: var(--bg-active);
  color: var(--accent);
}
.icon-btn {
  padding: 5px 7px !important;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.icon-btn:hover {
  color: var(--text);
}
.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.icon-btn:disabled:hover {
  color: var(--text-muted);
}
.clean-ai-btn {
  position: relative;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px !important;
  padding: 3px 10px !important;
  border: 1px solid var(--border);
  border-radius: 6px;
  gap: 2px;
  color: var(--text-muted);
  transition: all 0.15s;
}
.clean-ai-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft, rgba(255, 159, 64, 0.08));
}
.clean-ai-label {
  letter-spacing: 0.04em;
}
.clean-ai-broom {
  font-size: 11px;
  opacity: 0.85;
  margin-right: 1px;
}
.ai-rewrite-btn {
  position: relative;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px !important;
  padding: 3px 10px !important;
  border: 1px solid var(--border);
  border-radius: 6px;
  gap: 2px;
  color: var(--text-muted);
  transition: all 0.15s;
}
.ai-rewrite-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft, rgba(255, 159, 64, 0.08));
}
.ai-rewrite-label { letter-spacing: 0.04em; }
.ai-rewrite-spark { font-size: 11px; opacity: 0.85; margin-left: 2px; }

/* v2.5 F6 — CJK proofread toolbar button. Uses the literal "中"
 * glyph instead of an SVG icon: it telegraphs the feature's CJK
 * scope at a glance and matches Spell-check (a small icon-as-mark
 * style sits in the same toolbar group). */
.cjk-proof-btn {
  font-family: var(--font-zh, 'PingFang SC', 'Hiragino Sans GB', sans-serif);
  font-size: 13px !important;
  font-weight: 700;
  padding: 4px 8px !important;
  line-height: 1;
}
.cjk-proof-glyph {
  display: inline-block;
}

.toolbar__spacer { flex: 1 1 0; min-width: 0; }
/* Document title sits right after the SoloMD mark, mirroring a native window
   title (VSCode / macOS Notes style). min-width:0 + flex-shrink:1 lets it
   ellipsis-shrink on narrow windows instead of pushing tool groups off the
   right edge (overrides `.toolbar > * { flex-shrink: 0 }`). */
.toolbar__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  margin-left: 4px;
  padding-right: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
  min-width: 0;
  flex-shrink: 1;
  cursor: default;
}
.toolbar__divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
}

.dropdown {
  position: relative;
}
.focus-with-pomo {
  display: inline-flex;
  align-items: center;
  gap: 0;
}
.pomo-chevron {
  padding: 5px 4px !important;
  color: var(--text-faint);
}
.pomo-chevron:hover { color: var(--text); }
.dropdown__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 280px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-pop);
  z-index: var(--z-pop);
  padding: 4px;
  max-height: 360px;
  overflow-y: auto;
}
.dropdown__menu--narrow {
  min-width: 200px;
}
.dropdown__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
}
.dropdown__name {
  color: var(--text);
  font-weight: 500;
}
.dropdown__path {
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.dropdown__shortcut {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
  font-family: var(--font-mono);
}
.dropdown__item--muted {
  color: var(--text-muted);
  font-size: 11px;
}
/* #112 — per-entry recents removal. Hidden until the row is hovered so the
   list stays clean; sits over the right edge of the (column-flex) row. */
.dropdown__item--recent {
  position: relative;
  padding-right: 26px;
}
.dropdown__remove {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  display: none;
  padding: 2px 4px;
  border-radius: 3px;
  color: var(--text-faint);
  font-size: 11px;
  line-height: 1;
}
.dropdown__item--recent:hover .dropdown__remove {
  display: inline-block;
}
.dropdown__remove:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.dropdown__item--single {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.dropdown__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}
.dropdown__empty {
  padding: 12px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}
</style>
