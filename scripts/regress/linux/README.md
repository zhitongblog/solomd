# SoloMD Linux regression suite

Scripted version of the Linux column (L) of `docs/regression-checklist.md`
plus the Linux bugs found in the 5.0 regression rounds. Every check drives the
real, packaged app with real X input (xdotool / XTEST) and verifies the result
on disk, in the app's localStorage, on the clipboard, through the window
title, or by OCR / pixel tests on screenshots. No dev bridge, no JS
injection: what is tested is the `.deb` / AppImage a user installs.

## Run it (from the Mac)

```bash
gh release download probe/v5-r2 -R zhitongblog/solomd \
  -p '*arm64.deb' -p '*aarch64.AppImage' -D /tmp/pkg
scripts/regress/linux/run.sh /tmp/pkg/SoloMD_*_arm64.deb          # all checks
scripts/regress/linux/run.sh /tmp/pkg/SoloMD_*_arm64.deb L08 L15   # a subset (file-name prefixes)
```

- Needs the Lima VM `solomd-linux` running (Ubuntu 24.04 aarch64; see
  memory `reference_linux_repro_harness`). Override with `LIMA_VM=…`.
- An `*.AppImage` next to the `.deb` is picked up for the AppImage check; or
  pass `--appimage <path>`. Without one that check is `SKIP`.
- Missing tools are apt-installed in the VM on first run (`vm-suite.sh deps`).
- Results land in `OUT_DIR` (default `/tmp/solomd-regress-linux/<timestamp>`):
  `results.json`, `shots/<check>-<step>.png`, `logs/<check>.log` (check
  trace), `logs/<check>.app.log` (app stderr).
- Exit code 0 = no FAIL. A full run takes about 20 minutes.

## What it does inside the box

`vm-suite.sh all` (also usable directly on any Linux box):

1. **Rig** — its own `Xvfb :94` (refuses to start if `:94` belongs to someone
   else), `openbox` (without a WM nothing gets keyboard focus), a private
   `dbus-daemon --session` (keeps the single-instance handshake away from any
   other SoloMD on the machine), then an xterm self-test proving keystrokes
   arrive. Every process it starts carries `SOLOMD_REGRESS_TAG` in its
   environment; cleanup kills only processes with that tag. Other rigs
   (`:96`, `:99`, …) and their apps are never touched.
2. **Install** — `dpkg -i` the `.deb` (records name, sha256 and the binary's
   md5 in `build.txt`).
3. **Each check** gets a fresh fixture vault (`$RG_ROOT/vault`) and a fresh
   profile, launches the app, waits for the first *non-blank, stable* frame,
   does its thing, and is killed afterwards. Checks run in their own process
   with a timeout, so one failure or hang never affects the next.
4. **Report** — PASS/FAIL table on stdout, `results.json`.

### Profile handling

The app runs with `HOME=$RG_ROOT/home` (plus `XDG_*` pointing inside it), so
every check starts from an empty profile **and the VM user's real profile is
never moved or touched**, even while another SoloMD instance is using it.
(The earlier manual rounds moved `~/.local/share/app.solomd` aside and back;
that is unsafe when another rig's SoloMD is running from it, which it is on
this VM. The private HOME also catches files the app writes straight into
`$HOME`, e.g. `~/.solomd-language`, `~/.solomd-device-id`.)

The profile's localStorage (WebKitGTK SQLite, `ItemTable`, UTF‑16LE values)
is **seeded** before launch by `lib/seed.py`: welcome tour / AI wizard /
telemetry banner / star prompt marked as seen, update check off, the vault as
the open folder. Checks add overrides with `SEED_SETTINGS='{"language":"zh"}'`
or `SEED_EXTRA='{"key": value}'`. After a quit, checks read state back with
`ls_json KEY 'v.get(...)'` (`lib/ls.py`).

### The five false-freeze traps (all handled)

1. no WM → no focus: openbox + xterm self-test;
2. first-run modal eats input: seeded flags;
3. WAL leftovers restore an old buffer: profile created from scratch per check;
4. debug build loads `devUrl`: the suite only runs packaged builds;
5. blank screen "settles": readiness = first frame with >60 colours that is
   stable across two screenshots.

## Checks

| id | what | verified by |
|---|---|---|
| L01 | .deb launches on a fresh profile; KaTeX/mermaid/table render; Ctrl+Q exits | title, OCR, process list |
| L02 | AppImage launches, typing lands, quits, no FUSE mount left | exe path, clipboard read-back, /proc/mounts |
| L03 | Open Folder through the GTK chooser (typed path) | OCR tree, persisted `currentFolder` |
| L04 | type + Ctrl+S | exact bytes on disk (incl. UTF‑8 äö 中文) |
| L05 | Save As via GTK dialog | `cmp`, title, next save goes to the new file |
| L06 | Ctrl+N focuses the new note | clipboard read-back of the editor |
| L07 | Ctrl+W on a dirty tab: prompt; Esc keeps; N = Don't Save | OCR, title, disk unchanged |
| L08 | Ctrl+F in 中文 UI: labels, query focus, n/m, Enter, Shift+Enter, Esc | OCR (chi_sim, fuzzy) + counter OCR |
| L09 | Ctrl+H replace one / Replace All | bytes on disk |
| L10 | Live / Source / Split / Preview + reading mode; persistence | OCR (raw source), mermaid-node pixel count, persisted `viewMode` |
| L11 | Ctrl+B held 0.15 s toggles the tree exactly once ×4 | OCR tree, persisted `showFileTree` |
| L12 | Ctrl+Alt+M in `$$…$$` opens the formula editor, not Quick Capture | OCR dialog, window list |
| L13 | Quick Capture → inbox file; then Ctrl+Q exits fully; relaunch shows a window | file, process list |
| L14 | type then Ctrl+Q after 0.3 s / 0.1 s → text restored on relaunch | clipboard read-back |
| L15a/b/c | no false "File Changed on Disk": restored session / after Reload / new note | OCR per round, typed text present, disk |
| L16 | closing a second window with unsaved edits prompts; Don't Save drops them | OCR, window list, disk |
| L17 | PDF (text) through GTK print → Print to File keeps KaTeX letters | `pdftotext`, `pdffonts` |
| L18 | Export to Image writes a real PNG | `identify`, colour count |
| L19 | Copy as Image: no dialog, clipboard has `image/png` | `xclip -t TARGETS` |
| L20 | paste image → `_assets/` + link | files, disk |
| L21 | Edit menu Undo / Redo exist and work | OCR GTK menu, clipboard read-back |
| L22 | File menu shows "Sync & History" (ampersand) | OCR GTK menu |
| L23 | tree + tab context menus say "Show in File Manager" | OCR |
| L24 | UTF‑16LE+BOM opens, encoding shown, saved back as UTF‑16LE+BOM | bytes, `iconv` |
| L25 | CJK proofread ignores file names / `...`; control file is flagged | OCR panel |
| L26 | Ctrl+Shift+Z is redo, no pomodoro starts | clipboard read-back, no `solomd.pomodoro.state.v1` |
| L27 | invalid mermaid: inline error, no bomb, chrome stays put after preview find | OCR regions |
| L28 | DOCX export → import (Ctrl+Shift+L): bold, numbered list, `[ ]`/`[x]`, links | imported Markdown |

## Writing a check

A check is a bash file in `checks/` sourced with the helpers loaded. Typical:

```bash
start_on note.md || fail "app did not start"       # fresh vault+profile, launch on a file
key ctrl+End; typ "hello"; key ctrl+s               # real input (chords held 0.15 s)
expect "saved" grep -q hello "$VAULT/note.md"       # soft assertion, recorded in notes
img=$(shot after)                                    # shots/<check>-after.png
expect "toast" ocr_has "Saved" "$img"
finish "summary when everything passed"             # PASS unless an expect failed
```

Helpers (lib/common.sh, lib/app.sh): `key`, `tap`, `typ`, `click`, `rclick`,
`palette "<command title>"`, `editor_text` (Ctrl+A/Ctrl+C read-back),
`main_title`, `wait_title`, `app_open FILE` (single-instance hand-off),
`app_quit`, `app_launch`, `away` (focus another X client), `gtk_save PATH`,
`gtk_open PATH`, `gtk_print_to_file PDF`, `ocr_has / ocr_hasf / ocr_find /
ocr_click / ocr_line`, `mermaid_px`, `clip_targets`, `clip_get`,
`clip_put_file`, `ls_json`, `file_changed_dialog`.

OCR notes: text is OCR'd at 2× in grey; white-on-colour buttons (e.g. the
red "Don't Save") are not read reliably, so assert on neighbouring text or on
behaviour. Chinese UI text is matched fuzzily (`ocr_hasf`, one glyph of
slack) because tesseract's chi_sim misreads 替 as 蔡 at UI sizes.

Interactive debugging against a live rig:

```bash
limactl shell solomd-linux -- bash -c 'cd /tmp/rg2/suite && ./vm-suite.sh up'
limactl shell solomd-linux -- bash -c "cd /tmp/rg2/suite && ./vm-suite.sh exec 'start_on index.md; shot x'"
limactl shell solomd-linux -- bash -c 'cd /tmp/rg2/suite && ./vm-suite.sh run L08'
limactl shell solomd-linux -- bash -c 'cd /tmp/rg2/suite && ./vm-suite.sh down'
```

## Running it in GitHub Actions later

`vm-suite.sh` and `checks/` are box-agnostic; on an `ubuntu-24.04` runner:

- use the **amd64** `.deb` / AppImage from the build job (artifact download);
- `sudo` is passwordless on hosted runners, so `vm-suite.sh deps` and
  `dpkg -i` work as-is; add `libfuse2t64` for the AppImage (or the check
  falls back to `APPIMAGE_EXTRACT_AND_RUN=1`);
- no `xvfb-run` needed — the suite starts its own Xvfb; WebKitGTK renders
  in software (the app already sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`);
- step: `RG_ROOT=$RUNNER_TEMP/rg SOLOMD_DEB=… SOLOMD_APPIMAGE=… scripts/regress/linux/vm-suite.sh all`
  then upload `$RUNNER_TEMP/rg/out` as an artifact (screenshots + results.json);
- expect slower launches on 2-core runners: raise `LAUNCH_TIMEOUT` (default
  45 s) and `CHECK_TIMEOUT` (default 240 s) if needed;
- coordinates assume the 1440×900 screen the suite creates (`RG_SCREEN`);
  keep it.
