# Windows regression suite (Win11-ARM VM)

Drives a real SoloMD MSI build inside the local Win11-ARM UTM VM from the Mac,
with **real keyboard / mouse input** (keybd_event with MapVirtualKey scan codes,
SendInput unicode, mouse_event), and verifies through files read back over SSH,
UI Automation and screenshots. Covers checklist columns **W** (CodeMirror engine,
the default) and **Wp** (native / plain textarea engine) of
`docs/regression-checklist.md`.

```bash
gh release download <tag> -p '*arm64*.msi' -D /tmp/x       # a CI draft: pass the tag!
scripts/regress/windows/run.sh /tmp/x/SoloMD_*_arm64_en-US.msi          # everything
scripts/regress/windows/run.sh /tmp/x/SoloMD_*.msi find replace         # ids containing "find"/"replace"
scripts/regress/windows/run.sh --no-install ime                          # reuse the installed build
scripts/regress/windows/run.sh --restore                                 # put the user's profile back after an abort
scripts/regress/windows/run.sh --one checks/06-find.steps native         # debug one steps file (cm | native | fresh)
```

Output: `out/<timestamp>/` (or `$REGRESS_WIN_OUT`) — `results.json`, `logs/<id>.log`
(the driver log, every `CHECK <label> PASS|FAIL <detail>` line), `shots/o-<id>-*.png`,
`logs/o-<id>-uia-*.txt` (UIA dumps). Exit code 0 = all passed, 1 = a check failed,
2 = setup error (VM unreachable, not logged in, MSI failed).

## Requirements

- VM up, reachable as `zhitong@192.168.64.3` with key `~/.ssh/solomd_win11_vm`
  (override: `REGRESS_WIN_HOST`, `REGRESS_WIN_KEY`).
- `zhitong` **logged in on the console** (not the lock screen) — the preflight checks `query user`.
- Hold `caffeinate -d -i` on the Mac while it runs: when the Mac display sleeps, WebView2
  in the VM crashes.
- Microsoft Pinyin installed (the IME check switches the default input method to it;
  Sogou re-makes itself default after reboots).

## What a run does

1. Uninstalls any SoloMD MSI, installs the given one (`msiexec /qn`), logs exe version + hash.
2. Renames `%LOCALAPPDATA%\app.solomd` and `%APPDATA%\app.solomd` to `*.regressbak-<stamp>`
   (state in `C:\Users\Public\regress\profile-state.txt`) and remembers the default input
   method override; both are restored by an EXIT trap or `--restore`. `--one` leaves the profile
   aside on purpose (so you can iterate) — finish with `--restore`.
3. Generates the fixture vault (`make_fixtures.py`) and keeps a pristine copy in the VM.
4. Builds two **golden profiles** with real UI steps (`setup/golden-cm.steps`: fresh start,
   dismiss first-run UI, open the vault through the folder picker; `setup/golden-native.steps`:
   Settings → 编辑器引擎（Windows）→ 原生). Both are closed gracefully so WebView2 flushes
   localStorage, then copied aside.
5. For every check × engine: kill SoloMD + its WebView2, restore the golden profile, re-copy
   the pristine vault (`Desktop\regress-vault`), then run the steps as an **Interactive
   scheduled task** (the only way into the user's desktop session). Every check launches the
   app itself — the task's end kills it — and the window is pinned to `0,0,1400,800`
   (below the Kingsoft antivirus toast in the bottom-right corner).
6. Grades: a check PASSes when its log has ≥1 `CHECK … PASS`, no `CHECK … FAIL`, no `ERR`
   (an `ERR` = a missing UI element, unknown op, PowerShell error) and it finished in time.

Checks are independent: a failing / hanging check is graded FAIL and the next one starts
from a clean profile + vault.

## Steps language (`driver.ps1`)

One op per line, `op:arg`; `#` comments; `$V` = vault path. A line prefixed `[cm]` or
`[native]` runs only for that engine. Header comments: `# title:`, `# engines: cm native`
(default `cm`; `fresh` = no profile at all), `# timeout:` (s), `# checklist:`.

UI elements are found through **UI Automation** (WebView2 exposes its DOM accessibility
tree), so clicks don't depend on hard-coded coordinates. Spec: `name` (exact, falls back to
contains), `~text` (contains — also matches an Edit whose *value* contains it, for native
textareas), `%text` (Edit value only), `@ControlType` suffix, `#n` index. `@Edit` alone =
the nameless editor. Containers (Group/Pane/Document) are tried last.

| op | does |
|---|---|
| `launch`, `open:<file>`, `run:<args>` | start SoloMD (optionally with a file), wait for the window + title, pin, foreground, prime UIA |
| `open2:<file>` | hand a file to the running instance (single-instance) |
| `uclick` / `udbl` / `urclick` / `umove:<spec>` | real mouse at the element centre; `uclick?` = optional |
| `dclick:<spec>` | click inside the open native dialog (#32770) |
| `click` / `dbl` / `rclick` / `move:<x>,<y>` | window-relative coordinates (avoid) |
| `key:<combo>` | e.g. `ctrl+shift+z`, `alt+f4`, `enter` (scan codes) |
| `type:<text>` | unicode SendInput; `\n` / `\t` press the real Enter / Tab |
| `keys:<ascii>` | physical letter keys — goes through the IME (pinyin) |
| `fg`, `fgdlg[:<title rx>]`, `win2` / `win1`, `pin`, `show:<n>`, `taskbar:<rx>` | window focus |
| `wait:<s>`, `ms:<ms>`, `waitexit:<s>`, `kill` | timing |
| `imeon` / `imeoff` | ensure Chinese / English conversion mode of the IME (checked) |
| `uia` / `nouia:<label>\|<spec>` | assert element present / absent |
| `ucls` / `noucls:<label>\|<class rx>`, `ucount:<label>\|<class rx>\|<n>` | assert by DOM class |
| `fileeq` / `filehas` / `filelacks:<label>\|<vault file>\|<text>` | assert on disk (`\n` escapes) |
| `expect:<label>\|<PowerShell expr>` | assert any expression (`ReadV 'f.md'`, `$vars.x`, `UiaName '<rx>'`) |
| `set:<var>\|<expr>`, `urect:<var>\|<spec>`, `mem` (→ `$vars.mem`, WebView2 MB) | capture values |
| `title~:<label>\|<rx>`, `dlg` / `nodlg:<label>\|<title rx>`, `nwin:<label>\|<n>`, `alive:<label>\|dead` | window asserts |
| `nonblank:<label>` | screenshot the window, fail when it is one flat colour (the white-window trap) |
| `shot:<name>`, `udump:<name>`, `ddump:<name>`, `fileshow:<file>`, `ps:<expr>`, `wins`, `rect` | evidence / debugging |

To write a new check: `run.sh --one dev/calib.steps cm` with `udump:x` lines, read
`logs/o-calib-uia-x.txt` for element names / classes, then write asserts.

## Checks

| file | col | covers |
|---|---|---|
| 01-launch | W | window, title, menubar, view switch, CodeMirror present, non-blank pixels |
| 02-open-folder | W | fresh profile → 打开文件夹… → native picker → tree → click opens file |
| 03-type-save | W Wp | type ASCII + CJK, Ctrl+S, exact bytes, no BOM |
| 04-new-note-focus | W | Ctrl+N then type without clicking |
| 05-close-unsaved | W | Ctrl+W on dirty tab → 有未保存的修改 / 取消 keeps tab + disk |
| 06-find | W Wp | Ctrl+F Chinese labels, n/3 counter, Enter advances, Esc closes |
| 07-replace | W Wp | Ctrl+H 替换 (one) / 全部替换, bytes on disk |
| 08-view-modes | W | 分栏 / 预览 / 源码 / 实时 segmented control |
| 09-tab-click | W | clicking title-row tabs switches tab |
| 10-menubar | W | 文件 / 编辑 / 视图 / 帮助 open; 新建 Markdown, 查找…, 切换文件树 run; Esc closes |
| 11-ctrl-b | W | Ctrl+B = one file-tree toggle per press (it is NOT bold by default since 4.14.x — `fmt.bold` is Ctrl+Shift+B, checked too) |
| 12-formula | W | Ctrl+Alt+M opens 公式 editor, no quick-capture window |
| 13-tab-nest | W Wp | Tab on "2. two" nests the ordered item |
| 14-code-block | W | Ctrl+Alt+K wraps / unwraps a fenced block |
| 15-utf16 | W | UTF-16LE + BOM + CRLF round trip |
| 16-proofread | W | Ctrl+Shift+J: only "这是中文." flagged, file names / `...` not |
| 17-redo-no-pomodoro | W | Ctrl+Shift+Z starts no 专注 session |
| 18-altf4-restore | W | Alt+F4 right after typing, relaunch restores the text |
| 19-second-window | W | Ctrl+Shift+N, dirty edit, Alt+F4 on it prompts and stays open |
| 20-mermaid-invalid | W | broken mermaid in split: inline error, menubar/toolbar/document rects unchanged |
| 21-export | W | 文件 → 导出 → HTML / DOCX / PNG files written with content |
| 22-docx-import | W | export DOCX → Ctrl+Shift+L import: heading, bold, link, [ ]/[x], numbered list |
| 23-minimize-restore | W | minimize trims WebView2 working set ≥25 %; taskbar restore renders + edits save |
| 24-ime-pinyin | W Wp | real Microsoft Pinyin, 30 s settle, exact 8-line text on disk |

## Traps this suite already handles

- Chromium builds its a11y tree only after the first UIA query (17 → ~200 elements a few s later) — `launch` primes it.
- The interactive task's end kills SoloMD → every check launches its own instance.
- A leftover instance makes a new launch show a white window → SoloMD and its `msedgewebview2` are killed before each check.
- `SetForegroundWindow` from a task fails without the Alt-tap + AttachThreadInput dance (`fg`).
- scan code 0 → empty `event.code` in WebView2 → punctuation shortcuts silently fail; all keys carry real scan codes.
- The UTM clipboard is shared with the Mac — nothing here uses the clipboard; text is verified on disk / via UIA.
- Steps / driver need a UTF-8 BOM for Windows PowerShell 5 (added on upload).
- 选择文件夹 in the folder picker is a UIA *Pane*, not a Button.
- PowerShell variables are case-insensitive: a helper that assigns `$v` silently replaces the
  vault path `$V` (cost a false "file is empty" FAIL once). Driver code uses `$Vault`; `$V` in
  steps is substituted textually.
- MS Pinyin "di yi ge zi" with inner spaces commits per syllable — type phrases without inner spaces.
