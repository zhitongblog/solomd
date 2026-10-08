# Full regression checklist

Run before every major release. Built from the app's own tables — the menu
(`lib/app-menu.ts`), palette commands (`composables/useCommands.ts`),
bindable actions (`lib/keybindings.ts`) and settings — so a feature that is in
the app is on this list. Add a row when you add a feature.

Platforms: **M** macOS (Developer ID) · **S** Mac App Store build (no AI) ·
**W** Windows (CodeMirror engine; **Wp** = plain/native engine) · **L** Linux ·
**I** iOS/iPadOS app · **A** Android app. "—" = not on that platform.

Automated layers that run first: `pnpm test` (frontend unit tests),
`cargo test --lib` (Rust), `.github/workflows/tests.yml` in CI.

## A. Files, tabs, windows
| id | check | pass when |
|---|---|---|
| A1 | file.new / file.newText | new untitled tab of the right type, focused editor |
| A2 | file.newInFolder | file created in the selected folder, appears in tree |
| A3 | file.open / file.openFolder | picker opens; file/folder loads; tree shows folder |
| A4 | file.save / file.saveAs | bytes on disk match editor; dirty dot clears; save-as renames tab |
| A5 | file.autoSave (focus change) | switching window writes the file |
| A6 | file.closeTab / tab.reopenClosed | unsaved prompt on dirty; reopen restores the tab |
| A7 | tab.next / tab.prev / click tab | active tab changes (click must work on Windows title row) |
| A8 | file.import (docx/pdf/xlsx) | converted Markdown opens |
| A9 | file.openExternal | file opens in system app |
| A10 | recent list / recent.clear | recent shows last files; clear empties it |
| A11 | window.new | second window works independently |
| A12 | session restore | quit + relaunch restores tabs, cursor, unsaved buffer |
| A13 | external change | file edited outside reloads (or asks when dirty) |
| A14 | tree: rename / move (drag) / delete→trash / reveal | disk changes match; tree follows active file |
| A15 | encodings | GBK / Big5 / UTF-16 files open correctly and save back |

## B. Editing and formatting
| id | check | pass when |
|---|---|---|
| B1 | fmt.* (bold, italic, strike, code, link, h1–h6, ul, ol, task, quote, …) | each toggles on and off; selection kept; CJK not over-extended |
| B2 | heading.promote / demote / paragraph | level changes |
| B3 | insert.table / mathBlock / mathInline / mermaid / hr | snippet inserted, cursor placed |
| B4 | editor.insertImage / insertImageUrl / paste image / drop image | image saved to assets, link inserted, renders |
| B5 | editor.tableEditor / formulaEditor | editor opens, edits write back |
| B6 | editor.case* (upper/lower/title/cycle) | text transformed |
| B7 | editor.selectWord / selectLine / deleteWord / jumpToSelection | behave |
| B8 | undo / redo across all of the above | restores exactly |
| B9 | list continuation, renumbering, Tab indent | correct numbers |
| B10 | task checkbox click (live + preview) | toggles `[ ]`/`[x]` in source |
| B11 | [[wiki link]] autocomplete + click to open | completes; opens target |
| B12 | fold.toggle / all / none + gutter chevrons | folds headings |
| B13 | selection bubble | appears on selection, buttons apply, hides while find bar focused |
| B14 | IME (Chinese) typing in editor, find bar, settings fields | no dropped/doubled chars (W: MS Pinyin + Sogou) |

## C. Find and navigation
| id | check | pass when |
|---|---|---|
| C1 | editor.find (Ctrl/⌘F) | bar opens, query focus, n/m count, Enter cycles, Esc closes |
| C2 | editor.replace (Ctrl+H / ⌘⌥F) | replace one / all; Aa / .* / W options |
| C3 | search.global | results across folder; click jumps to line |
| C4 | quickSwitcher.open / palette.open | open; fuzzy match; Enter runs |
| C5 | preview find | find works in preview/reading |

## D. Views and display
| id | check | pass when |
|---|---|---|
| D1 | Live / Source / Split / Preview switch | correct panes; math+mermaid render; split scroll sync |
| D2 | view.toggleReading / view.slideshow | reading view; slides, arrows, Esc |
| D3 | focus mode / typewriter / line numbers / wrap / live preview / fit width | each toggles visibly and persists |
| D4 | view.toggleToolbar, view.toggleFileTree (Ctrl/⌘B once = once) | toggles exactly once (Linux GTK!) |
| D5 | zoom editor / preview / UI (in/out/reset) | sizes change, reset restores |
| D6 | theme light/dark/system + theme styles + custom CSS / clear | applied everywhere incl. menus, dialogs, find bar |
| D7 | tile.splitRight / splitDown / focusNext / focusPrev / closePane | panes split and close |
| D8 | narrow window | menus stay on screen; header doesn't overflow |

## E. Panels
| id | check | pass when |
|---|---|---|
| E1 | outline / backlinks / tags / tasks / types / neighborhood / relationships | open, show correct data, click navigates |
| E2 | history panel / inspector (properties) / views / bases | open and work |
| E3 | view.resetSidebarPanes, splitter drag | layout resets |

## F. Export
| id | check | pass when |
|---|---|---|
| F1 | export.pdf (text) / pdfPrint | file written, text selectable, math/mermaid/images present, no endless pages |
| F2 | export.docx (+ template) | opens in Word; tables, images, lists |
| F3 | export.html / image | file written; looks like preview |
| F4 | export.epub / odt / rtf / latex / pandocCustom | with pandoc installed; clear message without |
| F5 | export.copyMd / copyHtml / copyPlain / copyImage | clipboard holds the right format |

## G. Chinese tools
| id | check | pass when |
|---|---|---|
| G1 | cn.s2t / cn.t2s / cn.copyPinyin | correct conversion |
| G2 | proofread.cjk (F7) | real issues found; file names / ellipses / URLs not flagged; fix + fix all |

## H. Notes workflow
| id | check | pass when |
|---|---|---|
| H1 | daily today / yesterday / tomorrow | note created in daily folder |
| H2 | inbox.open / organizeAndAdvance / toggle | works |
| H3 | capture.quick | captured text lands in inbox |
| H4 | pomodoro open / startLast | timer runs, notifies |
| H5 | type.create / views.create / views.toggle / bases.open | created and listed |
| H6 | clean.stripMarkdown / clean.aiArtifacts / format.markdown | text cleaned |

## I. History and sync
| id | check | pass when |
|---|---|---|
| I1 | history.initWorkspace / toggleAutoGit / commitNow | commits created; restore from history |
| I2 | sync.pullNow / pushNow / copyShareLink / note.copyGitUrl | against a test repo (GitHub + Gitea) |
| I3 | image.uploadLocalImages | image host upload (configured) |

## J. AI (not in App Store builds)
| id | check | pass when |
|---|---|---|
| J1 | wizard opens on first AI reach (not on launch) | |
| J2 | editor.aiRewrite / agent panel with Ollama + one cloud key | |
| J3 | **S/I: no AI surface at all** | no menu items, no settings, no wizard |

## K. Settings
| id | check | pass when |
|---|---|---|
| K1 | every section opens; search finds items; deep links (keys) land | |
| K2 | each toggle takes effect immediately and survives restart | |
| K3 | shortcuts: rebind, conflict warning, reset, Typora preset; native menu accelerators follow | |
| K4 | language switch (all 15) — no overflow in header, menus, settings | |
| K5 | telemetry switch (not shown in S/I) | |

## L. Platform specials
| id | check | pass when |
|---|---|---|
| L1 | M/S native menu: every item enabled state + accelerators | |
| L2 | W in-app menubar: every menu opens, items run, Alt access | |
| L3 | W plain engine (Wp): typing, IME, cross-block selection, find, focus mode | |
| L4 | W window: drag title row, snap, maximize/restore, minimize memory trim | |
| L5 | L: GTK menu accelerators fire once; AppImage + deb start | |
| L6 | I phone: home/search/editor bottom bar, keyboard bar, Files app folder, in-place edit | |
| L7 | I iPad: overlay sidebar portrait, tabs, hardware keyboard ⌘ shortcuts | |
| L8 | A: SAF folder open, edit in place, toolbar under status bar, back button | |
| L9 | touch: taps don't select chrome text; no key hints on phone | |

## M. Help, CLI, MCP
| id | check | pass when |
|---|---|---|
| M1 | help.about / checkUpdate / shortcuts / markdown / welcomeTour / cli | |
| M2 | CLI: every subcommand against a fixture vault | |
| M3 | MCP: read tools; write tools only with --allow-write | |
