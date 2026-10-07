import { inject } from 'vue';
import { windowChromeOptions } from '../lib/window-chrome-options';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { documentDir, desktopDir, homeDir, join } from '@tauri-apps/api/path';
import { isIOS, isAndroid } from '../lib/platform';
import { isNarrowViewport } from './useViewport';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useRecentEditsStore } from '../stores/recentEdits';
import { useWindowsStore } from '../stores/windows';
import { openImageOverlay, type OverlayStrings } from '../lib/image-overlay';
import { openPath as openWithSystemDefault } from '@tauri-apps/plugin-opener';
import { useI18n } from '../i18n';
import type { FileReadResult, Tab } from '../types';
import { isSafPath, fromSafPath, safRead, safWrite, safLaunchPicker } from '../lib/saf-fs';
import { baseNameOf, fileNameOf, claimImportName, joinInFolder } from '../lib/import-plan';
import { newFileDirFor, treeSelection } from '../lib/new-file-target';

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

// Source path → the unsaved tab its conversion opened (#356). Module-level:
// every component calls useFiles() for its own instance, and the FileTree's
// instance must see conversions started from anywhere.
const convertedTabs = new Map<string, string>();

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
      // Windows ships frameless (unified title bar; tauri.windows.conf.json
      // only covers the main window) — aux windows must match or they'd get
      // native chrome PLUS the in-app caption buttons Toolbar.vue renders.
      new WebviewWindow(label, {
        url,
        title: 'SoloMD',
        width: 1000,
        height: 700,
        ...windowChromeOptions(),
      });
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

  /**
   * B4 — reopen the most recently closed tab (Typora ⌘⇧T). A saved file is
   * re-read from disk; an unsaved note that was discarded comes back with its
   * text as a new, unsaved tab. A file that is already open again is just
   * focused, and the next record down is not consumed for it.
   */
  async function reopenClosedTab(): Promise<boolean> {
    const rec = tabs.popClosedTab();
    if (!rec) {
      toasts.info(t('toast.nothingToReopen'));
      return false;
    }
    if (rec.filePath) {
      const open = tabs.tabs.find((x) => x.filePath === rec.filePath);
      if (open) tabs.activate(open.id);
      else await openPath(rec.filePath, { bypassNewWindow: true });
      return true;
    }
    const tab = tabs.newTab({ fileName: rec.fileName, language: rec.language });
    tabs.setContent(tab.id, rec.content);
    return true;
  }

  async function newTextFile() {
    tabs.newTab({ fileName: 'Untitled.txt', language: 'plaintext' });
  }

  async function openFile() {
    // No filters: rfd's filter behavior on macOS greys out non-matching files
    // and `'*'` is not treated as a wildcard. Letting the user pick anything
    // is simpler and more reliable.
    const selected = await openDialog({
      multiple: false,
      defaultPath: await filePickerStartDir(),
    });
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

  // Text / code files SoloMD opens natively as an editor tab. A Markdown link
  // to one of these always opens in-app, regardless of the
  // `openLinkedFilesExternally` setting (that setting only diverts non-text
  // documents like PDF / Office / audio to the OS default app). `md` is here
  // too so `[note](./other.md)` never leaves the editor.
  const TEXT_LINK_EXTENSIONS = new Set([
    'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'rst', 'tex', 'org',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'yaml', 'yml',
    'toml', 'ini', 'conf', 'cfg', 'env', 'xml', 'css', 'scss', 'sass', 'less',
    'vue', 'svelte', 'astro', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt',
    'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'sh', 'bash', 'zsh', 'fish',
    'pl', 'lua', 'r', 'sql', 'graphql', 'proto', 'gradle', 'properties',
  ]);

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
      // 5.0 §8 — the phone shell moves to its editor screen on this (opening a
      // note that is already the active tab changes no store state).
      window.dispatchEvent(new CustomEvent('solomd:file-opened', { detail: { path } }));
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

  async function openPath(
    path: string,
    opts: { bypassNewWindow?: boolean; fromTree?: boolean } = {},
  ) {
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
    // #356 — except an HTML file clicked in the file tree: that is a text
    // file in the user's own folder (often one we just exported), and a click
    // there means "open it", not "import it". Converting made a new unsaved
    // .md tab on every click. File → Import still converts HTML.
    const openHtmlAsText = opts.fromTree && (ext === 'html' || ext === 'htm');
    if (!openHtmlAsText && (CONVERT_BUILTIN.has(ext) || CONVERT_CLI.has(ext))) {
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
          // 张工 4.14.8 report #3: this used to also re-open a tree the user
          // had hidden, on every file open. Switching the folder is the
          // setting's job; whether the tree is shown is the user's.
          workspace.setFolder(parent);
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
      // #148 / #168 — on a phone the tree is a drawer over the editor, so
      // close it once a file opens: picking a file means you want to read it.
      // Keyed off viewport width (not the UA) so a narrow desktop window
      // behaves the same way the layout does.
      if (isNarrowViewport() && settings.showFileTree) settings.toggleFileTree();
      const fileName = fileNameOf(path);
      toasts.success(`Opened ${fileName}`);
    } catch (e) {
      console.error('open failed', e);
      toasts.error(`Failed to open file: ${e}`);
    }
  }

  /**
   * Open a file that was reached by clicking a Markdown LINK (not the file
   * tree). When `openLinkedFilesExternally` is on, a link to a non-text,
   * non-image document (PDF, Office, audio, archives, unknown binaries) is
   * handed to the OS default app — matching the "click the link to open the
   * file" intuition users have from Typora / Obsidian. Markdown / text / code
   * and images always stay inside SoloMD (editor tab / image overlay). When
   * the setting is off, everything routes through `openPath` as before
   * (PDF/PPTX/EPUB → markitdown conversion).
   */
  async function openLinkedFile(
    path: string,
    opts: { bypassNewWindow?: boolean } = {},
  ) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isTextLike = TEXT_LINK_EXTENSIONS.has(ext);
    if (settings.openLinkedFilesExternally && !isImage && !isTextLike) {
      if (import.meta.env.DEV) {
        (window as unknown as { __lastLinkOpen?: unknown }).__lastLinkOpen = {
          mode: 'external',
          path,
        };
      }
      try {
        await openWithSystemDefault(path);
      } catch (e) {
        console.error('openWithSystemDefault failed', e);
        toasts.error(`Failed to open: ${e}`);
      }
      return;
    }
    if (import.meta.env.DEV) {
      (window as unknown as { __lastLinkOpen?: unknown }).__lastLinkOpen = {
        mode: isImage ? 'image' : isTextLike ? 'internal' : 'convert',
        path,
      };
    }
    return openPath(path, opts);
  }

  async function openAndConvert(path: string, ext: string) {
    const fileName = path.split(/[\\/]/).pop() ?? path;
    // #356 — opening the same document again goes back to the tab its first
    // conversion produced, instead of converting into yet another tab.
    const prevId = convertedTabs.get(path);
    if (prevId && tabs.tabs.some((x) => x.id === prevId)) {
      tabs.activate(prevId);
      return;
    }
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
        convertedTabs.set(path, tab.id);
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

  /**
   * Import documents — Word / PDF / HTML / spreadsheets / slides / EPUB — as
   * Markdown files in the workspace.
   *
   * The converter has been in the app since v2.x, but the only way to reach it
   * was to open or drag a non-Markdown file and get an unsaved tab back. That
   * is fine for a one-off look and useless for the actual job, which is
   * "I have a folder of Word documents and I want them in my notes": no
   * multi-select, nothing written to disk, and no accounting of what failed.
   *
   * Converted files land in the workspace root as `<original name>.md`. That
   * is a deliberate default rather than a picker — one more dialog per import
   * for a location the user can change afterwards with a drag is not a trade
   * worth making. Without a workspace open there is nowhere to write, so it
   * falls back to the old behaviour and opens unsaved tabs.
   */
  async function importDocuments() {
    const selected = await openDialog({
      multiple: true,
      defaultPath: await filePickerStartDir(),
      filters: [
        {
          name: 'Documents',
          extensions: [
            'docx', 'pdf', 'html', 'htm', 'csv', 'xlsx', 'xls',
            'pptx', 'epub', 'json', 'xml',
          ],
        },
      ],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === 'string'
        ? [selected]
        : [];
    if (!paths.length) return;

    const folder = workspace.currentFolder;
    // SAF vaults write through ContentResolver with document ids rather than
    // paths; rather than half-support that here, Android imports open as tabs.
    const writeToDisk = !!folder && !isSafPath(folder);

    // One listing instead of an existence check per file: importing 40
    // documents should not be 40 extra IPC round-trips.
    const taken = new Set<string>();
    if (writeToDisk) {
      try {
        const entries = await invoke<Array<{ name: string }>>('list_dir', { path: folder });
        for (const e of entries) taken.add(e.name.toLowerCase());
      } catch {
        /* an unreadable folder will surface on the first write anyway */
      }
    }

    const imported: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    let needsMarkitdown = false;

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const fileName = fileNameOf(path);
      // A sticky toast per file (timeout 0, dismissed in `finally`): converting
      // a big PDF takes seconds, and an import that looks like nothing is
      // happening is one the user starts again.
      const progressId = toasts.info(
        t('import.progress', { done: i + 1, total: paths.length, name: fileName }),
        0,
      );
      try {
        const markdown = await invoke<string>('convert_file_to_markdown', { path });
        const base = baseNameOf(fileName);
        if (writeToDisk) {
          // `claimImportName` is where an existing note is protected — see
          // import-plan.ts. It also reserves the name inside this batch, so
          // importing two `report.*` files produces two notes.
          const target = joinInFolder(folder!, claimImportName(taken, fileName));
          await invoke('write_file', { path: target, content: markdown, encoding: 'UTF-8' });
          imported.push(target);
        } else {
          tabs.newTab();
          const tab = tabs.activeTab;
          if (tab) {
            tab.content = markdown;
            tab.fileName = `${base}.md`;
            tab.language = 'markdown';
          }
          imported.push(`${base}.md`);
        }
      } catch (e) {
        const msg = String(e);
        if (msg.includes('markitdown')) needsMarkitdown = true;
        failed.push({ name: fileName, error: msg });
      } finally {
        toasts.dismiss(progressId);
      }
    }

    if (imported.length && writeToDisk) {
      window.dispatchEvent(new CustomEvent('solomd:saved', { detail: { filePath: imported[0] } }));
      // Open the first import so the result is visible rather than merely
      // reported — a summary toast alone leaves the user hunting in the tree.
      await openPath(imported[0], { bypassNewWindow: true });
    }

    if (imported.length) {
      toasts.success(
        writeToDisk
          ? t('import.done', { count: imported.length, folder: fileNameOf(folder!) })
          : t('import.doneTabs', { count: imported.length }),
        4000,
      );
    }
    if (needsMarkitdown) {
      toasts.warning(t('import.needsMarkitdown'), 9000);
    }
    if (failed.length) {
      // Naming the files that failed matters more than the stack: the user
      // needs to know which documents did not make it, and re-running an
      // import is cheap.
      toasts.error(
        t('import.failed', {
          count: failed.length,
          names: failed.slice(0, 3).map((f) => f.name).join(', ') + (failed.length > 3 ? '…' : ''),
        }),
        8000,
      );
      console.warn('[import] failures', failed);
    }
  }

  /** The starting folder handed to the OS folder picker.
   *
   *  Never let the picker open without one, and never hand it a path that is
   *  not a real directory:
   *
   *  - Windows' picker falls back to the shell's *Desktop root* when it is
   *    given no starting folder. That root is a namespace item, not a
   *    directory — it has no filesystem path — so pressing OK on it makes the
   *    shell answer "no object for moniker" (MK_E_UNAVAILABLE, zh: "没有供标
   *    记使用的对象") and refuse to close the dialog. "Open Folder" then reads
   *    as a dead button and the Desktop itself cannot be chosen.
   *  - rfd silently drops a starting folder it cannot resolve
   *    (`SHCreateItemFromParsingName` fails → `SetFolder` is skipped), so a
   *    remembered workspace on a deleted / unmounted path lands the user in
   *    exactly that virtual root.
   *
   *  A directory that exists keeps the dialog on the filesystem: the caller's
   *  own candidates first (a remembered path, the active file's folder), then
   *  the last workspace, else the Desktop (where the picker would have opened
   *  anyway), else Documents, else the home folder. */
  async function pickerStartDir(
    ...preferred: Array<string | null | undefined>
  ): Promise<string | undefined> {
    const candidates = [
      ...preferred,
      workspace.currentFolder,
      await desktopDir().catch(() => null),
      await documentDir().catch(() => null),
      await homeDir().catch(() => null),
    ];
    for (const c of candidates) {
      if (!c) continue;
      try {
        // A SAF vault path ("saf:…") is not a filesystem path — skip it and
        // let the next candidate win, same as a folder that has gone away.
        if (await invoke<boolean>('fs_dir_exists', { path: c })) return c;
      } catch {
        /* path API unavailable — try the next candidate */
      }
    }
    return undefined;
  }

  /** Directory a *file* picker should open in.
   *
   *  The active document's folder first — that is where the next file the user
   *  reaches for almost always lives (an image next to the note, a sibling
   *  chapter, the CSS for the theme you're editing) — then the chain above. */
  async function filePickerStartDir(): Promise<string | undefined> {
    const active = tabs.activeTab?.filePath;
    const dir = active?.replace(/[\\/][^\\/]+$/, '');
    return pickerStartDir(dir && dir !== active ? dir : null);
  }

  async function openFolder() {
    // Open the OS folder picker rooted at the previously chosen workspace
    // so the user lands in a familiar tree, not at $HOME or wherever the
    // OS defaults. Without `defaultPath` Tauri's picker re-opens at the
    // OS-level last-used directory, which is unrelated to SoloMD state
    // and surprised users with a "why isn't my last folder remembered"
    // bug. We persist `currentFolder` already; this just feeds it back —
    // via pickerStartDir(), which guarantees the folder it hands over
    // actually exists (see there for why that matters on Windows).
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
      // The system folder picker (src-tauri/src/ios_folder.rs): any folder —
      // iCloud Drive, another app's folder, or "On My iPhone › SoloMD" — with
      // its security scope opened and remembered across launches. Cancelling
      // changes nothing; only if the picker cannot be shown at all do we fall
      // back to the app's own folder, as before.
      try {
        const picked = await invoke<string | null>('ios_pick_folder');
        if (!picked) return;
        workspace.setFolder(picked);
        if (!settings.showFileTree) settings.toggleFileTree();
      } catch {
        try {
          workspace.setFolder(await documentDir());
          if (!settings.showFileTree) settings.toggleFileTree();
          toasts.info(t('iosFolder.pickerUnavailable'));
        } catch (e) {
          toasts.error(String(e));
        }
      }
      return;
    }
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: await pickerStartDir(),
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
    // Into the folder the user is working in (a picked folder, or the app's
    // own); never over a file that is already there.
    const dir = workspace.currentFolder || (await documentDir());
    let taken = new Set<string>();
    try {
      const entries = await invoke<Array<{ name: string }>>('list_dir', { path: dir, showHidden: true });
      taken = new Set(entries.map((e) => e.name));
    } catch {
      /* unreadable — fall through with the plain name */
    }
    const dot = fname.lastIndexOf('.');
    const stem = dot > 0 ? fname.slice(0, dot) : fname;
    const ext = dot > 0 ? fname.slice(dot) : '';
    let name = fname;
    for (let i = 2; taken.has(name) && i < 1000; i++) name = `${stem} ${i}${ext}`;
    return await join(dir, name);
  }

  /** iOS: a path we can write in place — inside the app's own Documents or
   *  inside the folder picked as the workspace (its scope is open). A path
   *  from an "Open With" hand-off is neither, and keeps the copy-to-Documents
   *  route. */
  async function iosWritableInPlace(path: string | null | undefined): Promise<boolean> {
    if (!path) return false;
    const roots = [workspace.currentFolder];
    try {
      roots.push(await documentDir());
    } catch {
      /* no Documents — only the workspace counts */
    }
    if (roots.some((r) => !!r && path.startsWith(r.replace(/\/+$/, '') + '/'))) return true;
    // A document opened in place from the Files app: its security scope is
    // open for this session, so save back to the original. iOS may report
    // the same file with or without the /private prefix.
    try {
      const bare = (p: string) => p.replace(/^\/private(?=\/)/, '');
      const scoped = await invoke<string[]>('ios_scoped_files');
      return scoped.some((p) => bare(p) === bare(path));
    } catch {
      return false;
    }
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
    // #222 — the CodeMirror editor syncs doc→tab.content on a 350ms debounce.
    // A save issued inside that window (vim `:w`/`:wq`, a fast Ctrl+S) would
    // read a stale document; for `:wq` the tab then closes and the tail of the
    // edit is silently lost. Editors flush their pending sync synchronously on
    // this event, so `tab.content` below is current.
    window.dispatchEvent(new Event('solomd:flush-content-sync'));
    let path = tab.filePath;
    let iosCopy = false;
    if (isIOS()) {
      // A file inside the workspace (or the app's Documents) saves where it
      // is. Anything else — no path yet, or a deep-link "Open With" path Rust
      // cannot write — goes into the workspace as a new file. (This used to
      // send every save to the Documents root, even files in a subfolder.)
      if (!(await iosWritableInPlace(path))) {
        path = await iosResolvePath(tab);
        iosCopy = true;
      }
    } else if (!path) {
      return saveTabAs(tab);
    }
    if (!path) return saveTabAs(tab);
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
        if (isIOS() && iosCopy) {
          const fname = path.split(/[\\/]/).pop() ?? path;
          toasts.success(t('iosFolder.savedAs', { name: fname }));
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
      // A document with no path yet (File → New, the toolbar ＋, Ctrl+N) is
      // being named for the first time: open the dialog in the folder the user
      // is actually looking at — the Explorer's selection (a folder, or the
      // folder of the selected file), else the open document's folder —
      // instead of wherever the OS save dialog remembered last. An existing
      // file keeps its own path, which is what "Save As" means.
      const dir = tab.filePath
        ? null
        : await pickerStartDir(newFileDirFor(treeSelection(), tabs.activeTab?.filePath));
      path = await saveDialog({
        defaultPath: tab.filePath ?? (dir ? joinInFolder(dir, defaultName) : defaultName),
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
    // #222 — same stale-window hazard as saveTab: the dirty check below reads
    // tab.content, which lags the CodeMirror doc by up to 350ms. A close
    // landing inside that window (vim `:q`, fast Ctrl+W) saw a clean tab and
    // discarded the unsynced tail without the unsaved-changes dialog.
    window.dispatchEvent(new Event('solomd:flush-content-sync'));
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
    importDocuments,
    openPath,
    openLinkedFile,
    openFolder,
    // Starting directories for the OS dialogs. Every picker needs one: an
    // unset `defaultPath` is not "neutral" on Windows — it strands the dialog
    // on the shell's virtual desktop root, which OK cannot return.
    pickerStartDir,
    filePickerStartDir,
    saveActive,
    saveActiveAs,
    // Exposed for the task panel: ticking a checkbox in a file that happens to
    // be open has to go through the tab, not straight to disk, or the tab's
    // in-memory copy would silently overwrite it on the next save.
    saveTab,
    autoSaveDirtyTabs,
    closeTabSafe,
    reopenClosedTab,
    spawnAuxWindow,
  };
}
