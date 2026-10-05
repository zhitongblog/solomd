# SoloMD 5.0 — interface spec

The 5.0 prototype (claude.ai artifact "SoloMD 5.0 UI Prototype", seven boards) approved
2026-10-05, with the refinements below. Theme of the release: **writing first, tools out of
the way.** The default window shows files, tabs and the text; everything else lives in the
menus, the command palette and panels that appear when asked for.

This document is the contract. Every part of the 5.0 build follows it; where code and spec
disagree, fix one of them on purpose.

## 1. Where 5.0 deliberately departs from the prototype

The prototype was judged against what a demanding Mac user notices first.

| Prototype | 5.0 | Why |
|---|---|---|
| Geist web font | **System fonts**: SF Pro + PingFang on Apple, Segoe UI Variable + Microsoft YaHei UI on Windows | A Mac app set in a web font reads as a website. The system face is what every first-party app uses and what the eye expects. |
| Accent `#E07B39` for everything | Split into **fill** `#E07B39`, **text** `#B4561B`, **strong fill** (white label) `#B9561F` | `#E07B39` is 2.97:1 on white — fine as a mark, illegible as text. |
| Captions `#8A8780` | `#78756E` | 3.58:1 fails at 12 px; `#78756E` is ~4.5:1. |
| 1 px hairlines | 0.5 px on 2× screens | What AppKit draws; 1 px reads heavy on Retina. |
| Static segmented control | Thumb slides between segments (180 ms) | The detail people associate with "native". |
| Selection always tinted orange | Tint turns **neutral grey when the window is inactive** | Exactly what Finder / Notes do; a still-orange selection in a background window looks wrong. |
| Doc meta line (date · words · tags) above the title | **Stats pill** bottom-right of the editor (words · characters; click for the full status) | A meta line inside the editable document would have to be a CodeMirror widget that the cursor walks around; a quiet pill gives the same information without touching the text. The old status bar goes away. |
| Sidebar `#F4F3F0` opaque | Same, opaque | Real vibrancy needs a transparent window, which on macOS needs private API — not allowed in the Mac App Store build. |

## 2. Tokens

All in `app/src/styles/tokens.css` (default light + `data-theme="dark"`). The seven other
built-in themes and marketplace themes keep working: they only set the existing variables
(`--bg`, `--bg-elev`, `--text`, …), and every new variable falls back to those.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#1C1C1E` | editor / main surface |
| `--bg-sidebar` | `#F4F3F0` | `#232325` | sidebar, Windows title bar |
| `--bg-elev` | `#F7F6F3` | `#2C2C2F` | quotes, code blocks, inputs, cards |
| `--bg-pop` | `#FFFFFF` | `#2C2C2F` | menus, popovers, dialogs |
| `--fill-1` | `rgba(31,30,28,.05)` | `rgba(255,255,255,.07)` | hover, search field, segmented track |
| `--fill-2` | `rgba(31,30,28,.08)` | `rgba(255,255,255,.11)` | pressed, active tab |
| `--hairline` | `rgba(31,30,28,.08)` | `rgba(255,255,255,.08)` | every separator |
| `--text` | `#1F1E1C` | `#ECEAE6` | body |
| `--text-2` | `#5E5B55` | `#A9A6A0` | secondary (icons, inactive tabs) |
| `--text-3` | `#78756E` | `#8C8984` | captions, counts, placeholders |
| `--accent` | `#E07B39` | `#F0965A` | marks, caret, checkbox, focus ring |
| `--accent-text` | `#B4561B` | `#F4A26B` | links, selected sidebar row label |
| `--accent-strong` | `#B9561F` | `#E07B39` | primary-button fill (white label) |
| `--accent-soft` | `rgba(224,123,57,.13)` | `rgba(240,150,90,.18)` | selected row, text selection |
| `--select-inactive` | `rgba(31,30,28,.08)` | `rgba(255,255,255,.10)` | selection in an inactive window |

Type (system font, `--font-ui`):

| Role | Size / weight / line |
|---|---|
| Document title (H1) | 30 / 650 / 1.25, tracking −0.015em |
| H2 | 20 / 620 |
| H3 | 17 / 600 |
| Body (editor) | 16 / 400 / 1.8 (CJK-comfortable) |
| UI | 13 / 450 |
| Caption | 12 |
| Section label (sidebar) | 11 / 600, tracking .06em |

Spacing 4·8·12·16·24·32·48. Radii 6 (small controls) · 8 (buttons, fields, tabs) · 10
(menus, popovers, blocks) · 14 (dialogs, cards) · 999 (chips).

Elevation: menus `0 12px 32px rgba(0,0,0,.14), 0 1px 3px rgba(0,0,0,.08)` + hairline
border; dialogs `0 24px 64px rgba(0,0,0,.20)`. Dark: same with ×2 alpha.

Motion: `--ease-out: cubic-bezier(.2,.8,.2,1)`. Menus / popovers fade + scale .98→1 from
their anchor in 120 ms; dialogs 180 ms; segmented thumb 180 ms; sidebar width 220 ms.
`prefers-reduced-motion` turns all of it off.

Icons: one inline-SVG set (`components/Icons.vue`), 24-grid, stroke 1.6, round caps/joins,
`currentColor`, drawn at 16 px in the chrome and 20 px on touch. **No emoji anywhere in
chrome** (📁 🗂 🧹 ✨ ⚙️ … all go).

## 3. Desktop window

### macOS (reference)

```
┌ sidebar 260 ──────────┬ header 52 ──────────────────────────────────────────┐
│ ● ● ●            [⇤]  │ [tab][tab][tab]        [实时|源码|预览] [⌕][⇪][▥][⋯] │
│ [⌕ 搜索        ⌘K]    ├──────────────────────────────────────────────────────┤
│ ☀ 今天                │                                                      │
│ ⤓ 收件箱          4   │              centred 680 px text column              │
│ ◷ 最近                │                                                      │
│ 文件夹 ▾ (workspace)   │                                                      │
│   tree…               │                                       [1,284 字 ▾]   │
│ 标签  #a #b #c        │                                                      │
│ ⟳ 已同步          [⚙] │                                                      │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

- The sidebar is **full window height**; the traffic lights sit in its top 52 px
  (`trafficLightPosition` in `tauri.conf.json`), vertically centred on the header line.
- With the sidebar hidden, the header gains left padding for the traffic lights and a
  sidebar button.
- Header = drag region (double-click zooms, as today). Tabs for a single pane render in the
  header; with a split, each pane keeps its own tab strip under its header and the header
  shows none.
- Segmented **实时 / 源码 / 预览** (`liveEdit` / `edit` / `preview`). Split and reading stay
  in the View menu and the palette.
- Four icon buttons: search in folder, export ▾, right sidebar, more ▾. **More** holds
  everything the old strip had that is not in the header: new / open / save, insert ▾, AI,
  command palette, focus / typewriter / spellcheck, settings.
- No status bar. The stats pill replaces it.

### Windows

A 44 px title bar spans the window: app icon, the seven in-app menus, the centred document
title, caption buttons. Below it, the same sidebar + header (without traffic lights) as
macOS. Same tokens, same type scale with the Windows system font.

## 4. Sidebar

Top to bottom: search field (opens the quick switcher; shows its chord) · 今天 (daily note) ·
收件箱 (inbox view, count) · 最近 (recent files popover) · 文件夹 section — its label is the
workspace switcher; hover reveals new-file / sort / filter / refresh icons · the tree (28 px
rows, 7 px radius, selected = `--accent-soft` + `--accent-text`) · 标签 (up to 8 most-used tags
as chips; click filters, "全部" opens the tags panel) · footer: sync status + settings.

Empty state (no folder): a centred illustration-free block — title "打开一个文件夹",
one sentence, primary button, secondary "最近" list.

## 5. Editor

- Live edit is the default mode for new installs; line numbers off by default in live edit.
- Text column `max-width: 680px`, centred, 56 px top padding; follows the "fit width"
  setting when on.
- Caret `--accent`; selection `--accent-soft` (`--select-inactive` when the window blurs).
- Blocks: quote = `--bg-elev` + 10 px radius, no left bar; code = `--bg-elev`, 10 px radius,
  13 px mono; inline code = `--fill-1`, 4 px radius, `--text` colour (not red).
- **Selection bubble**: on a non-empty selection in live/source mode, a floating bar above it —
  bold, italic, inline code, link | heading, list, AI rewrite (when available). Same actions
  as the `fmt.*` commands. Fades in after 150 ms of stillness, hides on typing / scroll /
  collapse. Both editors (CodeMirror and the Windows native editor).
- **Stats pill**: bottom-right of the editor pane, `--text-3`, 12 px, translucent `--bg`;
  "1,284 字" (CJK) / "1,284 words"; click opens a popover with line/column, words,
  characters, selection, encoding, language. Hidden in focus mode until hover.

## 6. Menus, popovers, dialogs

- One menu style for every dropdown / context menu / popover: `--bg-pop`, 10 px radius,
  4 px padding, 28 px rows, 6 px row radius, hover `--fill-1`, shortcut in `--text-3`,
  separators `--hairline` with 4 px vertical margin.
- Dialogs: 14 px radius, 24 px padding, title 17/600, primary button `--accent-strong`
  (white), secondary `--fill-1`. Settings: left navigation with 16 px line icons, no emoji.
- Command palette / quick switcher: 640 px, 12 px radius, 44 px input, 34 px rows.

## 7. iPad

Sidebar + editor in landscape (sidebar collapsible), editor only in portrait with the sidebar
as an overlay. Header 52 px: sidebar button, title, preview, share, more. Formatting bar
above the software keyboard (hidden with a hardware keyboard). Pointer hover states as on
desktop; ⌘ shortcuts unchanged.

## 8. iPhone (and Android phones)

- **Home**: large title "笔记", search field, three cards (今天 / 收件箱 / 最近), folder list
  (56 px rows with counts), floating new-note button.
- **Editor**: back button with the folder name, preview and more buttons; text 15/1.8 with
  22 px margins; formatting bar above the keyboard (heading, bold, list, task, link, image,
  undo, hide keyboard).
- Bottom navigation: 笔记 · 搜索 · 收件箱 · 设置; 44 px minimum targets everywhere.

## 9. Verification (before "done")

- Browser harness, light + dark, every surface, at 1440 / 1180 / 820 / 390 wide.
- `?forceWinChrome` for the Windows title bar; the real Windows VM for WebView2.
- `tauri dev` on macOS for traffic-light placement, drag regions and window blur.
- iOS simulator + TestFlight device check before release; Android emulator for the phone shell.
- The seven other themes and one marketplace theme still read correctly in the new shell.
