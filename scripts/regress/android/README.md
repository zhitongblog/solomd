# Android regression suite

Drives a **release-signed** SoloMD APK on an emulator or phone using adb
only: `input tap/text/keyevent`, `uiautomator dump` for element bounds,
`screencap` for screenshots. It covers checklist column A rows L8/L9
(`docs/regression-checklist.md`) and the 5.0 phone shell (`docs/v5-ui-spec.md` §8).
Release builds have no WebView devtools, so this works from the outside.

```sh
./scripts/build-android.sh                      # wipe app/src-tauri/gen/android/app/build first (see below)
scripts/regress/android/run.sh                  # install newest arm64 release APK, run every check
scripts/regress/android/run.sh A10 search       # only checks whose file name contains A10 or search
scripts/regress/android/run.sh --apk path.apk   # a specific APK
scripts/regress/android/run.sh --no-install     # test what is installed (no provenance proof)
scripts/regress/android/run.sh --avd Pixel7 --keep-emulator
```

If no device is attached, it starts the AVD (`-no-snapshot-load -no-audio`) and
stops it again at the end. An emulator or phone that was already attached is left
alone. Exit code: 0 all passed, 1 a check failed, 2 setup failed. It prints a
PASS/FAIL table and writes `results.json`, `shots/*.png` and the last
`ui/<check>.xml` dump per check to `$OUT_DIR` (default
`/tmp/solomd-regress-android/<timestamp>`).

**It wipes app data.** A00 uninstalls and installs, and A01 runs `pm clear` so
the run starts from a first launch. Rotation, display density, font scale and
night mode are restored on exit, including when a check fails.

## Before you trust a result: A00

Two traps have made Android self-tests run stale code without anyone noticing:

1. Gradle does not re-embed `app/dist` into `libapp_lib.so` when only the
   frontend changed. Always `rm -rf app/src-tauri/gen/android/app/build` before
   building.
2. `adb install -r` over an APK signed with a different key fails without
   making noise.

A00 checks that `app/dist` < the cargo-linked `.so` < the APK (time chain), that the
`.so` inside the APK matches `merged_jni_libs` byte for byte, that `app/dist` has the
5.0 phone shell, and that the `.so` has 16 KB LOAD alignment. It then
uninstalls, installs, md5-compares the installed APK with the local one and checks
versionName against `tauri.conf.json`. If A00 fails, the run stops.
(`target/aarch64-linux-android/release/libapp_lib.so` is *not* the reference
file: the `.aab` step re-links it after the APKs are packaged, and the link
is not bit-reproducible.)

## Checks

| id | what |
|----|------|
| A00 | install + provenance (see above) |
| A01 | cold first launch → 笔记 home: title, bottom bar Notes/Search/Settings, FAB New note, Open Folder… |
| A02 | Settings from the bottom bar opens (Close below the status bar) and closes |
| A03 | SAF Open Folder… through DocumentsUI (Documents → SoloRegress → USE THIS FOLDER → ALLOW); notes listed |
| A04 | the folder pick leaves the phone on the folder's notes, not on a blank editor |
| A05 | tap a note → editor with ‹ Notes, title, text read through SAF |
| A06 | header buttons / home title below the status bar (`dumpsys window` statusBars frame) |
| A07 | More (⋯) menu inside the screen, view modes present, no shortcut hints |
| A08 | Source / Preview / Live through More (Preview: no EditText, heading rendered) |
| A09 | edit + Save in the SAF folder → `adb shell cat /sdcard/…` contains the new text |
| A10 | system Back in the editor → home, Back with the menu open → menu closes, app stays |
| A11 | FAB New note → type → Save → SAF create-document dialog → bytes on /sdcard + listed |
| A12 | Search tab finds a note by its text |
| A13 | Search screen shows no keyboard hints (↑↓ / ↵ / Esc) |
| A14 | tapping the note that is already the active tab opens it |
| A15 | Dark mode (More menu): mean screenshot luma light → dark → light |
| A16 | long-press on chrome text (title, tab bar) does not start a text selection |
| A17 | rotate to landscape and back with a note open (`user_rotation`, accelerometer off) |
| A18 | `wm density 600` + `font_scale 1.3`: header + More menu inside the screen |

## Writing a check

`checks/<ID>-<name>.sh` defines `run_check()` and ends it with `pass "…"` or
`fail "…"`. It has `# title:` and `# row:` header lines. Checks are sourced
in order into one shell, so state carries over: A03 opens the vault that
later checks use. Helpers are in `lib/common.sh`:

- `dump` reads the UI tree. The WebView builds its accessibility tree lazily,
  so the first dump after a navigation is often one opaque node, and `dump`
  retries until the tree has children.
- Lookups: `has`, `find_el`, `tap REGEX [--class C] [--within y0,y1] [--nth N]`,
  `wait_for`, `bounds_all`.
- Navigation: `open_note`, `go_home`, `open_more`, `menu_pick`, `in_editor`,
  `on_home`.
- Device and output: `shot`, `luma`, `type_ascii` (single-quoted for the
  device shell, so `#` survives), `screen_size`, `status_bar_bottom`.

Coordinates always come from the dump, never from guesses. UI regexes accept
English or Chinese (`RX_*` in `common.sh`).

## Limits

- `adb input text` is ASCII only. Driving a CJK IME needs a real keyboard
  (see the Win VM notes).
- The emulator's input devices report TOUCHSCREEN|STYLUS, so Chromium may say
  the pointer is `fine`. Landscape then gets the desktop header instead of
  the phone shell (`(max-height:480px) and (pointer:coarse)`). A17 records
  which layout it saw, and a real phone is needed to judge landscape.
- Emulator storage is permissive. Magic OS EACCES and R8-only failures need a
  real device and a release build. This suite does use a release build.
