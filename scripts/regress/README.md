# macOS regression suite

Drives a real SoloMD dev build through the dev bridge and checks the rows of
`docs/regression-checklist.md` that can be driven without a human. Run it
before every release.

```sh
scripts/regress/mac-suite.sh                    # build + launch, run all checks, stop
scripts/regress/mac-suite.sh find split D05     # only checks whose file name contains one of these
REGRESS_KEEP=1 scripts/regress/mac-suite.sh     # leave the instance running afterwards
REGRESS_ATTACH=1 scripts/regress/mac-suite.sh   # reuse the running instance (fast iteration)
```

Exit code: 0 if every check passed, 1 if any check failed, 2 if setup failed.
The run prints a PASS/FAIL table and writes `scripts/regress/out/results.json`.
The dev log is in `out/tauri-dev.log`.

## What it does

1. Starts `pnpm tauri dev --no-watch` from `app/` with its own identifier
   (`app.solomd.regress`, vite on :1450, override with `REGRESS_VITE_PORT`). It
   runs in its own process group, and only that group is stopped at the end.
   `--no-watch` means an edit under `src-tauri/` during the run does not
   rebuild and restart the app.
2. Deletes `~/Library/Application Support/app.solomd.regress` first, then
   waits for `dev-bridge.port`. A cold cargo build can take many minutes
   (`REGRESS_BOOT_TIMEOUT`, default 1500 s).
3. Builds a fresh fixture vault in a temp dir (`lib/make_fixture.py`). It uses
   the canonical `/private/var/…` path because FSEvents reports real paths.
4. `lib/setup.js` clears this origin's localStorage and reloads, sets the UI to
   zh, turns telemetry off, opens the vault and records the baseline settings.
   Before each check, `lib/reset.js` closes every overlay, restores the
   baseline settings, leaves one pane with one blank tab, and points the
   workspace back at the vault. A failing or timed-out check does not stop the
   run.

## Writing a check

`checks/<ROW>-<name>.js` is the body of an async function that runs in the main
WebView with `lib/prelude.js` in front of it. It returns `{ok, detail}`.
Header comments: `// id:` (checklist rows), `// title:`, `// timeout:` (ms).

Prelude handles: `act(id)` (the menu dispatch, `App.vue dispatchMenuAction`),
`APP` (App.vue setup state, e.g. `APP.settingsOpen`), `st(name)` (Pinia),
`V()` (the focused pane's CodeMirror view), `inv(cmd, args)`, `open(rel)`,
`fresh(name, text)` (a check-private file under `_work/`), `setDoc`, `doc`,
`sel`, `key(el, k, {meta,shift,alt})` (synthetic keydown: keymaps fire, text
insertion does not), `waitFor`, and the assertion collector `checks()`.

Some things only the outside world can do. For these a check runs in phases:
it returns `{next: carry, …}` and the runner calls it again with `PHASE` + 1 and
`CARRY`.

- `reload: true`: restart simulation (A12, K2).
- `host: {write, delete, rename}`: file changes made by a foreign process. The
  app's own `write_file` counts as a self-write, which the watcher ignores
  (A13, C4).
- `host: {menu: true}`: reads the native menu over Accessibility, aimed at our
  pid only (L1).

## Not covered (drive by hand)

- Native open/save dialogs. The underlying functions are tested instead
  (`setFolder` and `openPath`; `__solomdSavePathOverride` for exports).
- IME composition (B14).
- Real mouse drags (tree move, splitter).
- The slideshow window.
- Pandoc formats.
- GitHub/Gitea sync and image hosts.
- AI with real keys.
- Update checks.

## Requirements

- The screen must be unlocked while the suite runs. Split-view sync needs
  `requestAnimationFrame`, and D01b reports when it is not running.
- L1 needs Accessibility permission for the terminal that runs the suite.
- F5, G1 and K4 use the system clipboard and put your text back afterwards
  (text only).
