#!/usr/bin/env bash
# SoloMD Windows regression suite — drives the Win11-ARM VM from the Mac. See README.md.
#
#   scripts/regress/windows/run.sh <SoloMD_*_arm64*.msi> [filter...]
#       install the MSI, move the user's profile aside, build two golden test profiles
#       (CodeMirror + native engine), run every check (or those whose id contains a filter word),
#       restore the user's profile, print a PASS/FAIL table, write results.json.
#   run.sh --no-install <filter...>     reuse the installed build (still swaps the profile)
#   run.sh --restore                    put the user's profile back after an aborted run
#   run.sh --one <steps> [engine] [save-as-golden]
#                                       debug one steps file (engine: cm | native | fresh); leaves the profile aside
#
# Env: REGRESS_WIN_HOST (zhitong@192.168.64.3)  REGRESS_WIN_KEY (~/.ssh/solomd_win11_vm)
#      REGRESS_WIN_OUT (default: <this dir>/out/<timestamp>)   REGRESS_WIN_KEEP_PROFILE=1 (don't restore)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${REGRESS_WIN_HOST:-zhitong@192.168.64.3}"
KEY="${REGRESS_WIN_KEY:-$HOME/.ssh/solomd_win11_vm}"
SSHO=(-o ConnectTimeout=10 -o BatchMode=yes -o ServerAliveInterval=15 -i "$KEY")
RD='C:\Users\Public\regress'                 # work dir in the VM
VAULT='C:\Users\zhitong\Desktop\regress-vault' # fixture vault (Desktop: the folder picker starts there)
EXE='C:\Program Files\SoloMD\SoloMD.exe'
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${REGRESS_WIN_OUT:-$HERE/out/$STAMP}"
say() { printf '[win-regress %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

# Run PowerShell (stdin) in the VM over SSH. UTF-8 out; the CLIXML progress noise is dropped.
vm() { local body enc; body="\$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $(cat)"
  enc=$(printf '%s' "$body" | iconv -t UTF-16LE | base64 | tr -d '\n')
  ssh "${SSHO[@]}" "$HOST" "powershell -NoProfile -NonInteractive -EncodedCommand $enc" 2>/dev/null | tr -d '\r' | grep -v -e '^#< CLIXML' -e '<Objs ' ; return "${PIPESTATUS[0]}"; }
put() { scp -q "${SSHO[@]}" "$1" "$HOST:$2"; }
get() { scp -q "${SSHO[@]}" "$HOST:$1" "$2" 2>/dev/null; }

restore_profile() {
  vm <<PS
\$st = '$RD\profile-state.txt'
if (-not (Test-Path \$st)) { 'no saved profile state - nothing to restore'; return }
\$suffix = (Get-Content \$st -Raw).Trim()
Get-Process SoloMD -EA SilentlyContinue | Stop-Process -Force; Start-Sleep 2
foreach (\$base in @("\$env:LOCALAPPDATA\app.solomd", "\$env:APPDATA\app.solomd")) {
  if (Test-Path \$base) { Remove-Item -Recurse -Force \$base -EA SilentlyContinue }
  if (Test-Path "\$base.\$suffix") { Rename-Item "\$base.\$suffix" \$base; "restored \$base" } }
Remove-Item \$st
if (Test-Path '$RD\ime-override.txt') { \$tip = (Get-Content '$RD\ime-override.txt' -Raw).Trim()
  if (\$tip) { Set-WinDefaultInputMethodOverride -InputTip \$tip; "input method override restored: \$tip" } else { Remove-ItemProperty 'HKCU:\Control Panel\International\User Profile' -Name InputMethodOverride -EA SilentlyContinue; 'input method override cleared' }
  Remove-Item '$RD\ime-override.txt' }
PS
}

if [[ "${1:-}" == "--restore" ]]; then restore_profile; exit 0; fi
INSTALL=1; MSI=""; ONE=""; ONE_ENGINE=""
ONE_SAVE=""
if [[ "${1:-}" == "--one" ]]; then INSTALL=0; ONE="${2:?steps file}"; ONE_ENGINE="${3:-}"; ONE_SAVE="${4:-}"; shift $#
elif [[ "${1:-}" == "--no-install" ]]; then INSTALL=0; shift; else MSI="${1:-}"; shift || true; fi
if [[ $INSTALL == 1 && ! -f "$MSI" ]]; then echo "usage: $0 <path-to-arm64.msi> [filter...] | --no-install [filter...] | --restore" >&2; exit 2; fi
FILTERS=("$@")
mkdir -p "$OUT/shots" "$OUT/logs"
say "output: $OUT"

# ---------- preflight ----------
q=$(vm <<'PS'
$s = (query user 2>&1 | Out-String); if ($s -match 'zhitong\s+console\s+\d+\s+\S*') { 'CONSOLE-OK' } else { "NO-CONSOLE $s" }
PS
) || { say "VM unreachable over SSH ($HOST)"; exit 2; }
if [[ "$q" != *CONSOLE-OK* ]]; then say "zhitong is not logged in on the VM console (unlock the VM first): $q"; exit 2; fi

vm >/dev/null <<PS
New-Item -ItemType Directory -Force '$RD' | Out-Null
Get-ChildItem '$RD' -Filter 'o-*' -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue
PS
# the driver must be saved with a UTF-8 BOM or Windows PowerShell 5 misreads the Chinese in steps/logs
add_bom() { if [[ "$(head -c3 "$1" | xxd -p)" != efbbbf ]]; then printf '\xef\xbb\xbf' | cat - "$1"; else cat "$1"; fi; }
add_bom "$HERE/driver.ps1" > "$OUT/driver.ps1"; put "$OUT/driver.ps1" "C:/Users/Public/regress/driver.ps1"

# ---------- install ----------
if [[ -n "$ONE" ]]; then EXEINFO="(--one)"
elif [[ $INSTALL == 1 ]]; then
  say "installing $(basename "$MSI") ($(shasum -a 256 "$MSI" | cut -c1-12)…)"
  put "$MSI" "C:/Users/Public/regress/under-test.msi"
  inst=$(vm <<PS
Get-Process SoloMD -EA SilentlyContinue | Stop-Process -Force; Start-Sleep 1
\$keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
foreach (\$k in (Get-ItemProperty \$keys -EA SilentlyContinue | ? { \$_.DisplayName -eq 'SoloMD' -and \$_.PSChildName -match '^\{' })) {
  \$p = Start-Process msiexec.exe -ArgumentList "/x \$(\$k.PSChildName) /qn /norestart" -Wait -PassThru; "uninstalled \$(\$k.DisplayVersion) exit=\$(\$p.ExitCode)" }
\$p = Start-Process msiexec.exe -ArgumentList '/i "$RD\under-test.msi" /qn /norestart /l*v "$RD\msi.log"' -Wait -PassThru; "install exit=\$(\$p.ExitCode)"
if (Test-Path '$EXE') { \$f = Get-Item '$EXE'; "EXE \$(\$f.VersionInfo.FileVersion) \$(\$f.LastWriteTime.ToString('s')) sha256=\$((Get-FileHash '$EXE').Hash.Substring(0,16))" } else { 'EXE MISSING' }
PS
)
  echo "$inst" | sed 's/^/    /' >&2
  if [[ "$inst" != *"install exit=0"* || "$inst" == *"EXE MISSING"* ]]; then say "MSI install failed"; exit 2; fi
  EXEINFO=$(echo "$inst" | grep '^EXE')
else
  EXEINFO=$(vm <<PS
\$f = Get-Item '$EXE'; "EXE \$(\$f.VersionInfo.FileVersion) \$(\$f.LastWriteTime.ToString('s')) sha256=\$((Get-FileHash '$EXE').Hash.Substring(0,16))"
PS
)
fi
say "$EXEINFO"

# ---------- move the user's profile aside ----------
vm <<PS | sed 's/^/    /' >&2
\$st = '$RD\profile-state.txt'
Get-Process SoloMD -EA SilentlyContinue | Stop-Process -Force; Start-Sleep 2
if (Test-Path \$st) { "profile already aside (suffix \$((Get-Content \$st -Raw).Trim())) - keeping it" } else {
  \$suffix = 'regressbak-$STAMP'; Set-Content \$st \$suffix
  # the IME check switches the default input method to Microsoft Pinyin — remember the user's choice
  Set-Content '$RD\ime-override.txt' ([string](Get-ItemProperty 'HKCU:\Control Panel\International\User Profile' -EA SilentlyContinue).InputMethodOverride)
  foreach (\$base in @("\$env:LOCALAPPDATA\app.solomd", "\$env:APPDATA\app.solomd")) { if (Test-Path \$base) { Rename-Item \$base "\$base.\$suffix"; "moved \$base -> .\$suffix" } } }
PS
on_exit() { [[ -n "${RESTORED:-}" ]] && return; RESTORED=1; say "restoring the user profile"; restore_profile | sed "s/^/    /" >&2; }
if [[ "${REGRESS_WIN_KEEP_PROFILE:-0}" != 1 ]]; then trap on_exit EXIT; fi

# ---------- fixtures ----------
python3 "$HERE/make_fixtures.py" "$OUT/fixtures" >/dev/null || { say "fixture generation failed"; exit 2; }
( cd "$OUT/fixtures" && rm -f ../fixtures.zip && zip -qr ../fixtures.zip . )
put "$OUT/fixtures.zip" "C:/Users/Public/regress/fixtures.zip"
vm >/dev/null <<PS
Remove-Item -Recurse -Force '$RD\pristine' -EA SilentlyContinue
Expand-Archive -Force '$RD\fixtures.zip' '$RD\pristine'
PS

# ---------- one check = one interactive scheduled task ----------
# run_steps <id> <stepsfile> <timeout-s>   -> leaves $OUT/logs/<id>.log and shots; returns 0 if the log came back
run_steps() { local id="$1" sf="$2" to="$3" eng="${4:-cm}" o="$RD\\o-$1"
  add_bom "$sf" > "$OUT/logs/$id.steps"; put "$OUT/logs/$id.steps" "C:/Users/Public/regress/$id.steps"
  vm >/dev/null <<PS
Remove-Item '$o*' -EA SilentlyContinue
\$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "$RD\driver.ps1" -StepsFile "$RD\\$id.steps" -Out "$o" -Vault "$VAULT" -Engine $eng'
\$pr = New-ScheduledTaskPrincipal -UserId 'zhitong' -LogonType Interactive
\$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'solomd-regress' -Action \$a -Principal \$pr -Settings \$set -Force | Out-Null
Start-ScheduledTask -TaskName 'solomd-regress'
PS
  local t0=$SECONDS got=0
  while (( SECONDS - t0 < to )); do sleep 4
    if vm <<PS | grep -q READY
if (Test-Path '$o.txt') { 'READY' }
PS
    then got=1; break; fi
  done
  if [[ $got == 0 ]]; then
    vm >/dev/null <<PS
Stop-ScheduledTask -TaskName 'solomd-regress' -EA SilentlyContinue
if (Test-Path '$o.partial') { Copy-Item '$o.partial' '$o.txt' }
PS
  fi
  sleep 1
  vm > "$OUT/logs/$id.log" <<PS
if (Test-Path '$o.txt') { Get-Content '$o.txt' -Encoding UTF8 } else { 'NO LOG' }
PS
  [[ $got == 0 ]] && echo "CHECK harness.timeout FAIL steps did not finish within ${to}s" >> "$OUT/logs/$id.log"
  get "C:/Users/Public/regress/o-$id-*.png" "$OUT/shots/" ; get "C:/Users/Public/regress/o-$id-uia-*.txt" "$OUT/logs/"
  return 0; }

# restore a golden profile (or none) + a pristine vault before every check
prep() { local engine="$1"
  vm >/dev/null <<PS
Get-Process SoloMD -EA SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ? { \$_.CommandLine -match 'solomd' } | % { Stop-Process -Id \$_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep 1
foreach (\$p in @("\$env:LOCALAPPDATA\app.solomd", "\$env:APPDATA\app.solomd")) { if (Test-Path \$p) { Remove-Item -Recurse -Force \$p -EA SilentlyContinue } }
if ('$engine' -ne 'fresh') {
  robocopy "$RD\golden-$engine\local" "\$env:LOCALAPPDATA\app.solomd" /E /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy "$RD\golden-$engine\roaming" "\$env:APPDATA\app.solomd" /E /NFL /NDL /NJH /NJS /NP | Out-Null }
Remove-Item -Recurse -Force '$VAULT' -EA SilentlyContinue
Copy-Item -Recurse '$RD\pristine' '$VAULT'
Get-ChildItem '$VAULT' -Recurse -File | % { \$_.LastWriteTime = (Get-Date).AddMinutes(-5) }
PS
}
snapshot() { local engine="$1"
  vm <<PS
Get-Process SoloMD -EA SilentlyContinue | Stop-Process -Force; Start-Sleep 2
Remove-Item -Recurse -Force '$RD\golden-$engine' -EA SilentlyContinue
robocopy "\$env:LOCALAPPDATA\app.solomd" "$RD\golden-$engine\local" /E /NFL /NDL /NJH /NJS /NP /XD Crashpad GrShaderCache ShaderCache GPUCache 'Code Cache' | Out-Null
robocopy "\$env:APPDATA\app.solomd" "$RD\golden-$engine\roaming" /E /NFL /NDL /NJH /NJS /NP | Out-Null
"golden-$engine: \$([int]((Get-ChildItem -Recurse '$RD\golden-$engine' -File | Measure-Object Length -Sum).Sum/1KB)) KB"
PS
}

meta() { sed -n "s/^# $2: *//p" "$1" | head -1; }
grade() { local log="$1"
  if grep -q '^NO LOG' "$log"; then echo FAIL; return; fi
  if grep -qE 'CHECK [^ ]+ FAIL' "$log"; then echo FAIL; return; fi
  if grep -qE '(^| )ERR ' "$log"; then echo FAIL; return; fi
  if grep -qE 'CHECK [^ ]+ PASS' "$log"; then echo PASS; else echo FAIL; fi; }

# ---------- --one: debug a single steps file against the current golden profiles ----------
if [[ -n "$ONE" ]]; then
  trap - EXIT
  [[ -z "$ONE_ENGINE" ]] && ONE_ENGINE=$(meta "$ONE" engine); ONE_ENGINE=${ONE_ENGINE:-cm}
  id=$(basename "$ONE" .steps); prep "$ONE_ENGINE"; run_steps "$id" "$ONE" "$(meta "$ONE" timeout | grep . || echo 300)" "$ONE_ENGINE"
  cat "$OUT/logs/$id.log"; echo "grade: $(grade "$OUT/logs/$id.log")  shots: $OUT/shots"
  [[ -n "$ONE_SAVE" ]] && snapshot "$ONE_SAVE"
  exit 0
fi

# ---------- golden profiles ----------
for g in cm native; do
  sf="$HERE/setup/golden-$g.steps"
  say "building golden profile '$g'"
  if [[ $g == cm ]]; then prep fresh; else prep cm; fi
  run_steps "setup-$g" "$sf" 300 "$([[ $g == native ]] && echo native || echo cm)"
  r=$(grade "$OUT/logs/setup-$g.log")
  say "  setup-$g: $r"; [[ $r == PASS ]] || { say "  see $OUT/logs/setup-$g.log"; grep -E 'CHECK|ERR' "$OUT/logs/setup-$g.log" | sed 's/^/      /' >&2; }
  snapshot "$g" | sed 's/^/    /' >&2
done

# ---------- checks ----------
RESULTS=()
for sf in "$HERE"/checks/*.steps; do
  base=$(basename "$sf" .steps)
  engines=$(meta "$sf" engines); engines=${engines:-cm}
  for engine in $engines; do
  col=$( [[ $engine == native ]] && echo Wp || echo W )
  id="$base-$col"
  if (( ${#FILTERS[@]} )); then hit=0; for f in "${FILTERS[@]}"; do [[ "$id" == *"$f"* ]] && hit=1; done; (( hit )) || continue; fi
  title=$(meta "$sf" title); to=$(meta "$sf" timeout); to=${to:-240}
  say "$id $title"
  prep "$engine"
  t0=$SECONDS; run_steps "$id" "$sf" "$to" "$engine"; dt=$((SECONDS - t0))
  res=$(grade "$OUT/logs/$id.log")
  fails=$(grep -E 'CHECK [^ ]+ FAIL|(^| )ERR ' "$OUT/logs/$id.log" | sed -E 's/^[0-9:.]+ //' | head -6)
  shots=$(cd "$OUT/shots" && ls -1 "o-$id-"*.png 2>/dev/null | tr '\n' ' ')
  say "  -> $res (${dt}s)"; [[ $res == FAIL ]] && echo "$fails" | sed 's/^/      /' >&2
  RESULTS+=("$(python3 -c 'import json,sys; print(json.dumps(dict(id=sys.argv[1],col=sys.argv[2],engine=sys.argv[3],title=sys.argv[4],result=sys.argv[5],seconds=int(sys.argv[6]),failures=[l for l in sys.argv[7].splitlines() if l],shots=sys.argv[8].split(),checklist=sys.argv[9],checks=[l.split(" ",1)[1] for l in open(sys.argv[10],encoding="utf-8",errors="replace").read().splitlines() if " CHECK " in l])))' \
      "$base" "$col" "$engine" "$title" "$res" "$dt" "$fails" "$shots" "$(meta "$sf" checklist)" "$OUT/logs/$id.log")")
  done
done

# ---------- report ----------
printf '%s\n' "${RESULTS[@]}" | python3 -c '
import json, sys
rows = [json.loads(l) for l in sys.stdin if l.strip()]
meta = dict(build=sys.argv[1], out=sys.argv[2], passed=sum(r["result"] == "PASS" for r in rows), failed=sum(r["result"] != "PASS" for r in rows))
json.dump(dict(meta=meta, results=rows), open(sys.argv[2] + "/results.json", "w"), ensure_ascii=False, indent=1)
print("\n%-28s %-3s %-5s %s" % ("check", "col", "res", "title"))
for r in rows:
    print("%-28s %-3s %-5s %s" % (r["id"], r["col"], r["result"], r["title"]))
    if r["result"] != "PASS":
        for f in r["failures"]: print("      " + f)
        print("      shots: " + " ".join(r["shots"]))
print("\n%d passed, %d failed   build: %s\nresults: %s/results.json" % (meta["passed"], meta["failed"], meta["build"], meta["out"]))
' "$EXEINFO" "$OUT"
grep -q '"result": "FAIL"' "$OUT/results.json" && exit 1 || exit 0
