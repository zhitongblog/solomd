import { inject } from 'vue';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { documentDir, join } from '@tauri-apps/api/path';
import { isIOS, isAndroid, isMobile } from '../lib/platform';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useRecentEditsStore } from '../stores/recentEdits';
import { useWindowsStore } from '../stores/windows';
import { openImageOverlay, type OverlayStrings } from '../lib/image-overlay';
import { useI18n } from '../i18n';
import type { FileReadResult, Tab } from '../types';
import { isSafPath, fromSafPath, safRead, safWrite, safLaunchPicker } from '../lib/saf-fs';

// Save dialogs only — opening uses no filter so any file is selectable.
// (rfd treats `'*'` literally as the extension `*`, not as wildcard, so we
// can't reliably express "all files" via filters on macOS.)
/** #160 — pre-fill the Save dialog from the document's first heading. A
 *  never-saved tab still carries the default "Untitled" name, so a note that
 *  opens with `# 会议纪要` saves as `会议纪要.md` without retyping. Inert
 *  once the tab has a real path or a user-chosen name. */
export function deriveNameFromHeading(tab: Pick<Tab, 'filePath' | 'fileName' | 'content' | 'language'>): string | null {
  if (tab.filePath || !/^Untitled(\.(md|txt))?$/i.test(tab.fileName ?? '')) return null;
  const m = tab.content?.match(/^#{1,6}[ \t]+(.{1,60})/m);
  const stem = m?.[1]?.trim().replace(/[\\/:*?"<>|#]/g, '_').replace(/^\.+/, '').trim();
  if (!stem || /^[_\s.]*$/.test(stem)) return null;
  return tab.language === 'markdown' ? `${stem}.md` : `${stem}.txt`;
}

const SAVE_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
  { name: 'Plain Text', extensions: ['txt'] },
];

export function useFiles() {
  const tabs = useTabsStore();
  const workspace = useWorkspaceStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();
  const recentEdits = useRecentEditsStore();
  const windowsStore = useWindowsStore();
  const { t } = useI18n();

  // #103 — spawn an auxiliary window with a *stable* label (`solomd-window-N`)
  // instead of a timestamp, and record it in the shared windows registry so
  // (a) tauri-plugin-window-state can restore its geometry by label and
  // (b) the main window re-spawns it on the next launch. Returns the label,
  // or null when window creation failed (caller falls back to in-tab open).
  function spawnAuxWindow(path: string): string | null {
    try {
      const label = windowsStore.nextAuxLabel();
      const url = `/?path=${encodeURIComponent(path)}`;
      new WebviewWindow(label, { url, title: 'SoloMD', width: 1000, height: 700 });
      windowsStore.register(label, { path, folder: workspace.currentFolder });
      return label;
    } catch (e) {
      console.warn('aux-window spawn failed', e);
      return null;
    }
  }

  async function newFile() {
    tabs.newTab();
  }

  async function newTextFile() {
    tabs.newTab({ fileName: 'Untitled.txt', language: 'plaintext' });
  }

  async function openFile() {
    // No filters: rfd's filter behavior on macOS greys out non-matching files
    // and `'*'` is not treated as a wildcard. Letting the user pick anything
    // is simpler and more reliable.
    const selected = await openDialog({ multiple: false });
    if (!selected || typeof selected !== 'string') return;
    await openPath(selected);
  }

  // Extensions that the built-in converter handles (Rust, no Python).
  const CONVERT_BUILTIN = new Set(['docx', 'csv', 'xlsx', 'xls', 'html', 'htm']);

  // Extensions that need markitdown CLI (Python).
  // #98 — image extensions were removed from here: clicking an image in the
  // FileTree used to run it through the markitdown OCR converter (which fails
  // and toasts an error). Images now open in the fullscreen viewer instead.
  const CONVERT_CLI = new Set([
    'pdf', 'pptx', 'epub',
    'mp3', 'wav', 'm4a', 'ogg', 'flac',
  ]);

  // #98 — image files open in the fullscreen image overlay (same viewer the
  // preview pane uses), not the document converter.
  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

  function overlayStrings(): OverlayStrings {
    return {
      close: t('overlay.close'),
      zoomIn: t('overlay.zoomIn'),
      zoomOut: t('overlay.zoomOut'),
      resetZoom: t('overlay.resetZoom'),
      image: t('overlay.image'),
      diagram: t('overlay.diagram'),
    };
  }

  // #98 — open an image file in the fullscreen overlay viewer. Mirrors the
  // click-to-zoom flow in Preview.vue: build an <img> from an asset:// URL
  // and hand it to openImageOverlay(). We wait for the image to load so the
  // overlay's fit-to-screen sees real natural dimensions.
  async function openImageFile(path: string) {
    const fileName = path.split(/[\\/]/).pop() ?? path;
    try {
      const img = new Image();
      img.src = convertFileSrc(path);
      img.alt = fileName;
      await new Promise<void>((resolve, reject) => {
        if (img.complete && img.naturalWidth > 0) return resolve();
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image failed to load'));
      });
      openImageOverlay({ source: img, title: fileName, strings: overlayStrings() });
      workspace.pushRecent(path);
      toasts.success(`Opened ${fileName}`);
    } catch (e) {
      console.error('open image failed', e);
      toasts.error(`Failed to open image: ${e}`);
    }
  }

  /** #148 — Android delivers file-manager / "Open with" / picker files as SAF
   *  `content://` URIs, which neither std::fs nor our whole path-based stack
   *  can read (the raw URI reached fs::read and failed with os error 2).
   *  Import the bytes through the fs plugin's ContentResolver bridge into the
   *  SoloMD Documents folder — mirroring what iOS does with Files-app opens —
   *  and hand back a real filesystem path for the rest of openPath. */
  async function importContentUri(uri: string): Promise<string> {
    const { readFile, exists } = await import('@tauri-apps/plugin-fs');
    const bytes = await readFile(uri as unknown as string);
    // Recover a filename where the URI encodes one ("…document/primary%3A
    // Download%2Fnote.md"); opaque numeric document ids fall back to a
    // timestamped name.
    let name = '';
    try {
      const seg = decodeURIComponent(uri).split(/[/:]/).filter(Boolean).pop() ?? '';
      if (/\.[A-Za-z0-9]{1,8}$/.test(seg)) name = seg.replace(/[\\/:*?"<>|]/g, '_');
    } catch {
      /* malformed encoding — fall through to the timestamped name */
    }
    // Opaque provider ids (e.g. the Downloads provider's "msf:29") carry no
    // filename at all. For text payloads, fall back to the document's first
    // Markdown heading — far friendlier than a timestamp when it exists.
    if (!name) {
      const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512));
      if (!head.includes('\u0000')) {
        const m = head.match(/^#{1,6}[ \t]+(.{1,60})/m);
        const stem = m?.[1]?.trim().replace(/[\\/:*?"<>|#]/g, '_');
        if (stem) name = `${stem}.md`;
      }
    }
    if (!name) name = `imported-${Date.now()}.md`;
    const dir = await documentDir();
    let dest = await join(dir, name);
    // Never overwrite an existing note the user may have edited — pick a
    // suffixed sibling instead.
    if (await exists(dest)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 1;
      while (await exists(dest)) {
        dest = await join(dir, `${stem}-${n}${ext}`);
        n += 1;
      }
    }
    await invoke('write_binary_file', { path: dest, data: Array.from(bytes) });
    return dest;
  }

  async function openPath(path: string, opts: { bypassNewWindow?: boolean } = {}) {
    // #148 — see importContentUri; must run before any path parsing below.
    if (isAndroid() && path.startsWith('content://')) {
      try {
        path = await importContentUri(path);
      } catch (e) {
        console.error('content:// import failed', e);
        toasts.error(`Failed to open: ${e}`);
        return;
      }
    }

    // #139 — normalize `file://` URLs to a plain filesystem path here, at the
    // single shared entry point. On iOS a Files-app open arrives via the
    // `solomd://opened-file` channel as a raw, percent-encoded file URL
    // (e.g. file:///private/var/.../tmp/app.solomd-Inbox/Markdown%20%E8%AF%AD….md)
    // and was handed straight to Rust's fs::read, which then failed with
    // "No such file or directory" because the scheme + %-encoding made it a
    // bogus path. iOS already copied the file into our sandbox (readable), so
    // the only bug was the un-decoded URL. Stripping the scheme + decoding
    // fixes it; desktop absolute paths (no scheme) pass through untouched, and
    // the deep-link channel that already strips is a harmless no-op here.
    if (path.startsWith('file://')) {
      const stripped = path.replace(/^file:\/\/(localhost)?/, '');
      try {
        path = decodeURIComponent(stripped);
      } catch {
        path = stripped;
      }
    }

    // #139 — iOS app-container paths embed a per-install UUID
    // (/…/Data/Application/<UUID>/…) that iOS CHANGES on every app update, so
    // an absolute path persisted in "recent files" (or a restored tab) points
    // at a dead container after any update — the reporter saw "Documents
    // unreadable" for recents whose UUID no longer matched. Re-anchor any
    // stored container path onto the CURRENT container root before reading.
    // (A fresh in-session path re-maps to itself — harmless no-op.)
    // Anchor on `/Data/Application/` (lazy `.*?` = first occurrence): a greedy
    // bare `/Application/` match would eat a user folder literally named
    // "Application" below Documents, and would also mis-rewrite app-BUNDLE
    // paths (/…/Bundle/Application/<UUID>/…), which are not ours to re-anchor.
    if (isIOS() && /\/Data\/Application\/[^/]+\//.test(path)) {
      try {
        const docDir = await documentDir(); // …/Data/Application/<current>/Documents
        const curRoot = docDir.replace(/\/Documents\/?$/, '');
        path = path.replace(/^.*?\/Data\/Application\/[^/]+/, curRoot);
      } catch {
        /* documentDir unavailable — leave path as-is */
      }
    }

    // #98 — image files open in the fullscreen overlay viewer, never as a
    // tab and never in a new window (an overlay isn't document content, so
    // routing it through the markitdown converter just toasts an error).
    const imgExt = (path.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXTENSIONS.has(imgExt)) {
      return openImageFile(path);
    }

    // Spawn a new Tauri window with the path in the query string when the
    // user has opted in. Only applies when the current window already has
    // at least one tab (fresh-launch first file should stay in this window).
    if (
      settings.openFileInNewWindow &&
      !opts.bypassNewWindow &&
      tabs.tabs.length > 0
    ) {
      if (spawnAuxWindow(path)) return;
      // Window creation failed — fall through to in-tab open.
    }

    const ext = (path.split('.').pop() || '').toLowerCase();

    // If it's a convertible format, convert to Markdown first.
    if (CONVERT_BUILTIN.has(ext) || CONVERT_CLI.has(ext)) {
      return openAndConvert(path, ext);
    }

    // Native open: text files, markdown, code, etc.
    try {
      // #148 — SAF vault file: read through ContentResolver. The parent is
      // already the open vault, so skip the reveal-parent dance below.
      const isSaf = isSafPath(path);
      const result = isSaf
        ? await safRead(workspace.safTreeUri!, fromSafPath(path))
        : await invoke<FileReadResult>('read_file', { path });

      // Reveal the file's folder in the sidebar BEFORE adding the tab.
      // Order matters: `workspace.setFolder` switches the per-workspace tab
      // session (tabs.onWorkspaceSwitched), and that swap only *carries* DIRTY
      // tabs across a folder change. A freshly opened CLEAN file added BEFORE
      // the switch would be discarded — the editor kept showing the previously
      // open document (or a blank Untitled) while the tree revealed the new
      // folder, and only a close+reopen "fixed" it (by then the folder was
      // already current). That was the real "double-click opens nothing" bug.
      // Switching first means `openFromDisk` below adds the tab into the
      // already-settled workspace, so it survives and becomes active.
      if (settings.revealInFileTreeOnOpen && !isSaf) {
        const parent = path.replace(/[\\/][^\\/]+$/, '');
        if (parent && parent !== path) {
          workspace.setFolder(parent);
          if (!settings.showFileTree) settings.toggleFileTree();
        }
      }

      tabs.openFromDisk({
        filePath: path,
        content: result.content,
        encoding: result.encoding,
        language: result.language,
        hadBom: result.had_bom,
      });
      workspace.pushRecent(path);
      // #148 (mobile) — a phone can't show the file tree and editor
      // side-by-side (the doc becomes an unreadable sliver), so collapse the
      // tree once a file opens; the editor gets the full width. The toolbar
      // folder button reopens the tree to pick another file.
      if (isMobile() && settings.showFileTree) settings.toggleFileTree();
      const fileName = path.split(/[\\/]/).pop() ?? path;
      toasts.success(`Opened ${fileName}`);
    } catch (e) {
      console.error('open failed', e);
      toasts.error(`Failed to open file: ${e}`);
    }
  }

  async function openAndConvert(path: string, ext: string) {
    const fileName = path.split(/[\\/]/).pop() ?? path;
    const tid = toasts.info(`Converting ${fileName} to Markdown…`, 0);
    try {
      const markdown = await invoke<string>('convert_file_to_markdown', { path });
      toasts.dismiss(tid);
      // Open as a new unsaved Markdown tab with the converted content.
      const baseName = fileName.replace(/\.[^.]+$/, '');
      tabs.newTab();
      const tab = tabs.activeTab;
      if (tab) {
        tab.content = markdown;
        tab.fileName = `${baseName}.md`;
        tab.language = 'markdown';
      }
      toasts.success(`Converted ${fileName} → Markdown`);
    } catch (e) {
      toasts.dismiss(tid);
      const msg = String(e);
      if (msg.includes('markitdown')) {
        // Show install hint for markitdown-dependent formats
        toasts.warning(
          `Converting .${ext} requires markitdown:\npip install 'markitdown[all]'`,
          8000,
        );
      } else {
        toasts.error(`Conversion failed: ${msg}`);
      }
    }
  }

  async function openFolder() {
    // Open the OS folder picker rooted at the previously chosen workspace
    // so the user lands in a familiar tree, not at $HOME or wherever the
    // OS defaults. Without `defaultPath` Tauri's picker re-opens at the
    // OS-level last-used directory, which is unrelated to SoloMD state
    // and surprised users with a "why isn't my last folder remembered"
    // bug. We persist `currentFolder` already; this just feeds it back.
    //
    // #96 fix: on Android, `openDialog({ directory: true })` resolves to
    // `null` silently — Tauri's dialog plugin doesn't surface SAF's
    // directory-tree picker on Android, so the button looked dead. Mirror
    // iOS behaviour and pin the workspace to the app's Documents dir.
    // The user can drop .md files into that folder via the Files app
    // ("On My Device > SoloMD"); SoloMD reads them back on next open.
    // #139 — neither Android nor iOS surfaces a usable OS folder picker
    // through Tauri's dialog plugin (`openDialog({directory:true})` resolves to
    // null), so the "Open Folder" button looked dead on both. Mirror the
    // Android behaviour on iOS: pin the workspace to the app's own Documents
    // dir ("On My iPhone/iPad › SoloMD" via UIFileSharingEnabled). Users drop
    // .md files there through the Files app and they show up in the tree.
    // #148 / #151 — Android: with all-files access the user can point SoloMD
    // at a REAL vault folder anywhere on shared storage (…/Documents, a
    // Syncthing/Dropbox dir) and edit in place, instead of being stuck with
    // the unreachable /Android/data sandbox. Check the permission; if missing,
    // prompt the user to grant it in Settings (App.vue drives the request +
    // re-check on resume); if granted, open our own folder browser.
    if (isAndroid()) {
      // #148 — use the Storage Access Framework. MANAGE_EXTERNAL_STORAGE is
      // unreliable across OEMs (grants nothing on Honor/Huawei Magic OS — the
      // permission reads as granted but std::fs still hits EACCES even after a
      // restart), while SAF works everywhere with no special permission. The
      // user picks a folder in the system dialog; we read/write it via
      // ContentResolver (see lib/saf-fs.ts).
      try {
        // Launch and mark that a pick is in flight; App.vue resolves the result
        // on resume (the picker backgrounds our WebView, so we can't await it
        // inline — the JS poll loop is lost across the transition).
        localStorage.setItem('solomd:saf-picking', '1');
        await safLaunchPicker();
      } catch (e) {
        localStorage.removeItem('solomd:saf-picking');
        toasts.error(String(e));
      }
      return;
    }
    if (isIOS()) {
      try {
        const dir = await documentDir();
        workspace.setFolder(dir);
        if (!settings.showFileTree) settings.toggleFileTree();
        toasts.info(
          `Workspace pinned to the SoloMD folder. Drop .md files there via the Files app and they'll show up here.`,
        );
      } catch (e) {
        toasts.error(String(e));
      }
      return;
    }
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: workspace.currentFolder ?? undefined,
    });
    if (!selected || typeof selected !== 'string') return;
    workspace.setFolder(selected);
    if (!settings.showFileTree) settings.toggleFileTree();
  }

  // iOS save policy: ignore the in-place path (could be a security-scoped
  // URL from a "Open With" deep-link — unwritable from plain Rust fs) and
  // route everything through the app's own Documents directory. With
  // UIFileSharingEnabled set, that folder appears as "On My iPhone › SoloMD"
  // in the Files app, so users can iCloud-sync or move from there.
  async function iosResolvePath(tab: Tab): Promise<string> {
    const fname =
      deriveNameFromHeading(tab) ||
      tab.fileName ||
      (tab.language === 'markdown' ? 'Untitled.md' : 'Untitled.txt');
    const dir = await documentDir();
    return await join(dir, fname);
  }


  /** Android — write to a SAF `content://` URI through the fs plugin's
   *  ContentResolver bridge ("wt" mode: write + truncate). Rust's std::fs
   *  cannot open content URIs — routing them into our `write_file` command
   *  failed with "No such file or directory (os error 2)" AFTER the SAF
   *  save dialog had already created the (empty) document, which is how
   *  "Save As produced a 0-byte file" happened on Android. */
  async function writeContentUri(uri: string, payload: string): Promise<void> {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(uri as unknown as string, payload);
  }

  /** Display name for a content:// URI ("…%2Fnote.md" → "note.md"). */
  function contentUriName(uri: string): string {
    try {
      return decodeURIComponent(uri).split(/[\\/:]/).filter(Boolean).pop() ?? uri;
    } catch {
      return uri.split(/[\\/]/).pop() ?? uri;
    }
  }

  async function saveTab(tab: Tab, opts: { silent?: boolean } = {}): Promise<boolean> {
    let path = tab.filePath;
    if (isIOS()) {
      // On iOS, never trust the existing path — it may have come from a
      // deep-link "Open With" and not be writable from Rust fs. Always
      // route to Documents.
      path = await iosResolvePath(tab);
    } else if (!path) {
      return saveTabAs(tab);
    }
    try {
      // Restore the file's original line endings on write — we
      // normalize CRLF→LF on open so CodeMirror behaves, but the user
      // expects a Windows-saved file to stay Windows-saved.
      const payload =
        tab.lineEnding === 'crlf' ? tab.content.replace(/\n/g, '\r\n') : tab.content;
      // #148 — SAF vault: write through ContentResolver. Git/AutoGit can't
      // operate on content-URI paths, so skip the recent/MFU/AutoGit hooks
      // (they key off real filesystem paths) for SAF saves.
      const isSaf = isSafPath(path);
      const isContentUri = path.startsWith('content://');
      if (isSaf) {
        await safWrite(workspace.safTreeUri!, fromSafPath(path), payload);
      } else if (isContentUri) {
        // Android — a tab previously Saved-As through the SAF dialog keeps
        // its content:// URI as filePath; Ctrl+S must take the same
        // ContentResolver route as the original save.
        await writeContentUri(path, payload);
      } else {
        await invoke('write_file', {
          path,
          content: payload,
          encoding: tab.encoding || 'UTF-8',
        });
      }
      tabs.markSaved(tab.id, path);
      if (!isSaf && !isContentUri) {
        workspace.pushRecent(path);
        // v2.5: feed the ⌘P quick-switcher's MFU ranking.
        recentEdits.recordEdit(path);
        // v2.2: notify the AutoGit composable so the debounced auto-commit
        // pipeline picks up this save. Listener is in `useAutoCommit.ts`.
        window.dispatchEvent(
          new CustomEvent('solomd:saved', { detail: { filePath: path } }),
        );
      }
      if (!opts.silent) {
        if (isIOS()) {
          const fname = path.split(/[\\/]/).pop() ?? path;
          toasts.success(`Saved to On My iPhone › SoloMD › ${fname}`);
        } else {
          toasts.success(`Saved ${tab.fileName}`);
        }
      }
      return true;
    } catch (e) {
      console.error('save failed', e);
      toasts.error(`Failed to save: ${e}`);
      return false;
    }
  }

  async function saveTabAs(tab: Tab): Promise<boolean> {
    const defaultName =
      deriveNameFromHeading(tab) ||
      tab.fileName ||
      (tab.language === 'markdown' ? 'Untitled.md' : 'Untitled.txt');
    let path: string | null;
    if (isIOS()) {
      // iOS: no Save-As picker UI that round-trips to Rust safely. Write
      // straight to app Documents; user surfaces / moves via Files app.
      path = await iosResolvePath(tab);
    } else {
      path = await saveDialog({
        defaultPath: tab.filePath ?? defaultName,
        filters: SAVE_FILTERS,
      });
      if (!path) return false;
    }
    try {
      const payload =
        tab.lineEnding === 'crlf' ? tab.content.replace(/\n/g, '\r\n') : tab.content;
      // Android — the SAF save dialog returns a content:// URI (and has
      // already created the empty document); write the bytes through
      // ContentResolver, not std::fs. The fs-path-keyed hooks below
      // (recents/MFU/AutoGit) are skipped, same as SAF-vault saves.
      const isContentUri = path.startsWith('content://');
      if (isContentUri) {
        await writeContentUri(path, payload);
        tabs.markSaved(tab.id, path);
        const fileName = contentUriName(path);
        toasts.success(`Saved as ${fileName}`);
        return true;
      }
      await invoke('write_file', {
        path,
        content: payload,
        encoding: tab.encoding || 'UTF-8',
      });
      tabs.markSaved(tab.id, path);
      workspace.pushRecent(path);
      // v2.5: feed the ⌘P quick-switcher's MFU ranking.
      recentEdits.recordEdit(path);
      window.dispatchEvent(
        new CustomEvent('solomd:saved', { detail: { filePath: path } }),
      );
      const fileName = path.split(/[\\/]/).pop() ?? path;
      toasts.success(isIOS() ? `Saved to On My iPhone › SoloMD › ${fileName}` : `Saved as ${fileName}`);
      return true;
    } catch (e) {
      console.error('save-as failed', e);
      toasts.error(`Failed to save: ${e}`);
      return false;
    }
  }

  async function saveActive() {
    if (tabs.activeTab) await saveTab(tabs.activeTab);
  }

  async function saveActiveAs() {
    if (tabs.activeTab) await saveTabAs(tabs.activeTab);
  }

  // #85 — auto-save on window blur. Persist every dirty tab that already has
  // a file path, silently (no per-file toast). Untitled tabs are skipped on
  // purpose: saving them would pop a Save-As dialog, which is jarring when
  // triggered by simply switching to another app. Errors still toast so a
  // failed background save isn't swallowed.
  async function autoSaveDirtyTabs(): Promise<void> {
    if (!settings.autoSaveOnBlur) return;
    for (const tab of tabs.tabs) {
      if (tab.filePath && tabs.isDirty(tab.id)) {
        await saveTab(tab, { silent: true });
      }
    }
  }

  type UnsavedDialog = (mode: 'tab' | 'window', fileName: string, count: number) => Promise<'save' | 'discard' | 'cancel'>;
  // Pass `null` default so Vue doesn't emit "injection not found" warnings
  // when useFiles() is called before App.vue's provide() runs (e.g. inside
  // App.vue's own setup). The real dialog is always available via the
  // window global fallback below.
  const injectedDialog = inject<UnsavedDialog | null>('showUnsavedDialog', null);

  function getUnsavedDialog(): UnsavedDialog | undefined {
    if (injectedDialog) return injectedDialog;
    const w = window as any;
    return w.__solomd_showUnsavedDialog as UnsavedDialog | undefined;
  }

  async function closeTabSafe(id: string) {
    const tab = tabs.tabs.find((t) => t.id === id);
    if (!tab) return;
    const showUnsavedDialog = getUnsavedDialog();
    if (tab.content !== tab.savedContent && showUnsavedDialog) {
      const action = await showUnsavedDialog('tab', tab.fileName, 1);
      if (action === 'save') {
        const ok = await saveTab(tab);
        if (!ok) return;
      } else if (action === 'cancel') {
        return; // go back to editing
      }
      // 'discard' → fall through to close
    }
    tabs.closeTab(id);
  }

  return {
    newFile,
    newTextFile,
    openFile,
    openPath,
    openFolder,
    saveActive,
    saveActiveAs,
    autoSaveDirtyTabs,
    closeTabSafe,
    spawnAuxWindow,
  };
}
