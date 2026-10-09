param([string]$Exe = "C:\Program Files\SoloMD\SoloMD.exe", [string]$StepsFile, [string]$Out = "C:\Users\Public\regress\o-x",
      [string]$WinClass = "Tauri Window", [string]$ProcName = "SoloMD", [string]$Vault = "C:\Users\zhitong\Desktop\regress-vault",
      [string]$Pin = "0,0,1400,800", [string]$Engine = "cm")
# Regression step driver — an extended copy of scripts/dev/win-ui-steps.ps1.
# Runs INSIDE the interactive desktop (session 1) via a scheduled task; every input is real
# (keybd_event with MapVirtualKey scan codes, SendInput unicode, mouse_event).
# One step per line in $StepsFile; '#' lines are comments. Log -> "$Out.txt", screenshots -> "$Out-<name>.png".
# Lines starting with "CHECK <label> PASS|FAIL" in the log are the assertions the Mac runner grades.
# See README.md in this folder for the full op list.
$ErrorActionPreference = "Continue"
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint tid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string id, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MI m; [FieldOffset(0)] public KI k; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] i, int size);
  public static void Uni(string s) {
    foreach (char c in s) {
      INPUT[] a = new INPUT[2];
      a[0].type = 1; a[0].u.k.scan = c; a[0].u.k.flags = 4;
      a[1].type = 1; a[1].u.k.scan = c; a[1].u.k.flags = 4 | 2;
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(25);
    }
  }
}
"@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
[W]::SetProcessDPIAware() | Out-Null
[W]::ShowWindow([W]::GetConsoleWindow(), 0) | Out-Null
$V = $Vault
$log = New-Object System.Collections.Generic.List[string]
function L($m) { $log.Add("$(Get-Date -Format HH:mm:ss.fff) $m"); Set-Content -Path "$Out.partial" -Encoding UTF8 -Value ($log -join "`n") -EA SilentlyContinue }
function Check([string]$label, [bool]$ok, [string]$detail = '') { $s = if ($ok) { 'PASS' } else { 'FAIL' }; L "CHECK $label $s $detail" }
function Scan([byte]$vk) { return [byte]([W]::MapVirtualKey($vk, 0) -band 0xFF) }
$EXT = @(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x5B,0x5D)
function Key([byte]$vk, [int]$hold = 30) { $sc = Scan $vk; $e = if ($EXT -contains [int]$vk) { 1 } else { 0 }; [W]::keybd_event($vk, $sc, $e, [UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [W]::keybd_event($vk, $sc, (2 -bor $e), [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
$VK = @{ ctrl=0x11; shift=0x10; alt=0x12; win=0x5B; enter=0x0D; esc=0x1B; tab=0x09; home=0x24; end=0x23; up=0x26; down=0x28; left=0x25; right=0x27; pgup=0x21; pgdn=0x22;
  f1=0x70; f2=0x71; f3=0x72; f4=0x73; f5=0x74; f6=0x75; f7=0x76; f8=0x77; f9=0x78; f10=0x79; f11=0x7A; f12=0x7B; backspace=0x08; delete=0x2E; space=0x20;
  comma=0xBC; period=0xBE; slash=0xBF; backslash=0xDC; minus=0xBD; equal=0xBB; plus=0xBB; lbracket=0xDB; rbracket=0xDD; semicolon=0xBA; quote=0xDE; backtick=0xC0; apps=0x5D }
function VkOf([string]$k) { if ($VK.ContainsKey($k)) { return [byte]$VK[$k] }; return [byte][char]($k.ToUpper()) }
function Combo([string]$c) { $parts = $c.ToLower().Split('+'); $mods = @(); if ($parts.Count -gt 1) { $mods = @($parts[0..($parts.Count-2)] | ? { $_ }) }; $k = VkOf $parts[-1]
  foreach ($m in $mods) { [W]::keybd_event((VkOf $m), (Scan (VkOf $m)), 0, [UIntPtr]::Zero) }; Start-Sleep -Milliseconds 30; Key $k
  [array]::Reverse($mods); foreach ($m in $mods) { [W]::keybd_event((VkOf $m), (Scan (VkOf $m)), 2, [UIntPtr]::Zero) }; Start-Sleep -Milliseconds 80 }
# Physical-key typing (goes through the IME): letters, digits, space, comma, period, '\n' = Enter.
function TypeKeys([string]$s) { $s = $s.Replace('\n', "`n"); foreach ($c in $s.ToCharArray()) {
  if ($c -match '[a-zA-Z]') { Key ([byte][char]($c.ToString().ToUpper())) } elseif ($c -match '[0-9]') { Key ([byte][char]$c) }
  elseif ($c -eq ' ') { Key 0x20 } elseif ($c -eq ',') { Key 0xBC } elseif ($c -eq '.') { Key 0xBE } elseif ($c -eq "`n") { Key 0x0D } } }
# Unicode typing (SendInput KEYEVENTF_UNICODE); '\n' = real Enter key; '\t' = real Tab key.
function TypeUni([string]$t) { $t = $t.Replace('\n', "`n").Replace('\t', "`t"); $buf = ''
  foreach ($c in $t.ToCharArray()) { if ($c -eq "`n" -or $c -eq "`t") { if ($buf) { [W]::Uni($buf); $buf = '' }; if ($c -eq "`n") { Key 0x0D } else { Key 0x09 }; Start-Sleep -Milliseconds 150 } else { $buf += $c } }
  if ($buf) { [W]::Uni($buf) }; Start-Sleep -Milliseconds 250 }
function ShotRect([string]$name, $rect) { $bmp = New-Object Drawing.Bitmap ($rect.R - $rect.L), ($rect.B - $rect.T)
  $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($rect.L, $rect.T, 0, 0, $bmp.Size); $bmp.Save("$Out-$name.png"); $g.Dispose(); return $bmp }
function Shot([string]$name) { $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $r = New-Object W+RECT; $r.L = 0; $r.T = 0; $r.R = $b.Width; $r.B = $b.Height
  $bmp = ShotRect $name $r; $bmp.Dispose(); L "shot $name" }
$script:target = [IntPtr]::Zero; $script:main = [IntPtr]::Zero; $script:p = $null
function AppWins { $ids = @(Get-Process $ProcName -EA SilentlyContinue | % { $_.Id }); $res = New-Object System.Collections.Generic.List[IntPtr]
  [W]::EnumWindows({ param($h, $l) $pid2 = 0; [W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($ids -contains [int]$pid2 -and [W]::IsWindowVisible($h)) { $sb = New-Object Text.StringBuilder 256; [W]::GetClassName($h, $sb, 256) | Out-Null
      if ($sb.ToString() -eq $WinClass) { $res.Add($h) } }; return $true }, [IntPtr]::Zero) | Out-Null; return ,$res }
function FindWin { $w = AppWins; $script:target = if ($w.Count -gt 0) { $w[$w.Count - 1] } else { [IntPtr]::Zero } }
function FgH([IntPtr]$h) { for ($i = 0; $i -lt 20 -and [W]::GetForegroundWindow() -ne $h; $i++) {
    $fg = [W]::GetForegroundWindow(); $fgTid = [W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); $me = [W]::GetCurrentThreadId()
    [W]::AttachThreadInput($me, $fgTid, $true) | Out-Null; [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [W]::BringWindowToTop($h) | Out-Null; [W]::SetForegroundWindow($h) | Out-Null; [W]::AttachThreadInput($me, $fgTid, $false) | Out-Null
    Start-Sleep -Milliseconds 250 }
  $ok = ([W]::GetForegroundWindow() -eq $h); L "foreground ok=$ok"; return $ok }
function Fg { FgH $script:target | Out-Null }
function Wins { $ids = @(Get-Process $ProcName -EA SilentlyContinue | % { $_.Id }); $res = New-Object System.Collections.Generic.List[string]
  [W]::EnumWindows({ param($h, $l) $pid2 = 0; [W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ([W]::IsWindowVisible($h)) { $sb = New-Object Text.StringBuilder 256; [W]::GetClassName($h, $sb, 256) | Out-Null; $tb = New-Object Text.StringBuilder 512; [W]::GetWindowText($h, $tb, 512) | Out-Null
      $cls = $sb.ToString(); if ($ids -contains [int]$pid2 -or $cls -eq '#32770') { $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null; $res.Add("$h pid=$pid2 cls=$cls title=[$($tb.ToString())] rect=$($r.L),$($r.T),$($r.R),$($r.B)") } }; return $true }, [IntPtr]::Zero) | Out-Null
  return ,$res }
function Pin { $d = $Pin.Split(','); [W]::ShowWindow($script:target, 9) | Out-Null; Start-Sleep -Milliseconds 300
  [W]::MoveWindow($script:target, [int]$d[0], [int]$d[1], [int]$d[2], [int]$d[3], $true) | Out-Null; Start-Sleep -Milliseconds 500 }
function TitleOf([IntPtr]$h) { $sb = New-Object Text.StringBuilder 512; [W]::GetWindowText($h, $sb, 512) | Out-Null; return $sb.ToString() }
function Launch([string]$argline = '') {
  $script:p = if ($argline) { Start-Process $Exe -ArgumentList $argline -PassThru } else { Start-Process $Exe -PassThru }; L "launched pid=$($script:p.Id) args=[$argline]"
  $script:target = [IntPtr]::Zero
  for ($i = 0; $i -lt 60 -and $script:target -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 500; FindWin }
  $script:main = $script:target; L "window=$script:target"
  if ($script:target -eq [IntPtr]::Zero) { Check 'launch.window' $false 'no Tauri Window within 30s'; return }
  # the web UI needs a few seconds before shortcuts register; wait for a real title (the app sets "<file> — SoloMD")
  for ($i = 0; $i -lt 40 -and -not ((TitleOf $script:target) -match 'SoloMD'); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 2
  Pin; Fg
  # Chromium builds its accessibility tree lazily, on the first UIA query: prime it so uclick/uia work at once
  $n = 0; for ($i = 0; $i -lt 30 -and $n -lt 40; $i++) { $n = @(UiaAll $script:target).Count; if ($n -lt 40) { Start-Sleep -Milliseconds 500 } }
  L "title=[$(TitleOf $script:target)] uia=$n" }
function Rect { $r = New-Object W+RECT; [W]::GetWindowRect($script:target, [ref]$r) | Out-Null; return $r }
function MouseAt([string]$a) { $r = Rect; $xy = $a.Split(','); [W]::SetCursorPos($r.L + [int]$xy[0], $r.T + [int]$xy[1]) | Out-Null }
function ClickScreen([int]$x, [int]$y, [int]$n = 1, [uint32]$down = 2, [uint32]$up = 4) { [W]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 120
  for ($k = 0; $k -lt $n; $k++) { [W]::mouse_event($down,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [W]::mouse_event($up,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 70 } }
# ---------- UI Automation (WebView2 exposes its DOM accessibility tree through UIA) ----------
$TW = [System.Windows.Automation.TreeScope]::Descendants
function UiaRoot([IntPtr]$h) { if ($h -eq [IntPtr]::Zero) { return $null }; return [System.Windows.Automation.AutomationElement]::FromHandle($h) }
function UiaAll([IntPtr]$h) { $root = UiaRoot $h; if (-not $root) { return @() }
  try { return @($root.FindAll($TW, [System.Windows.Automation.Condition]::TrueCondition)) } catch { L "uia err $_"; return @() } }
# spec: "<text>" (exact Name, falls back to contains) or "~<text>" (contains) ; optional "@<ControlType>" suffix ; optional "#<n>" index
function UiaFind([string]$spec, [IntPtr]$h = $script:target, [int]$timeoutMs = 4000) {
  $idx = 0; if ($spec -match '^(.*)#(\d+)$') { $spec = $Matches[1]; $idx = [int]$Matches[2] }
  $ct = ''; if ($spec -match '^(.*)@(\w+)$') { $spec = $Matches[1]; $ct = $Matches[2] }
  $byValue = $spec.StartsWith('%'); if ($byValue) { $spec = $spec.Substring(1) }
  $contains = $spec.StartsWith('~'); if ($contains) { $spec = $spec.Substring(1) }
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  if ($byValue) { do { $all = UiaAll $h   # '%text' = an Edit whose VALUE contains text (native textareas have no Name)
      $c = @($all | ? { try { (-not $ct -or $_.Current.ControlType.ProgrammaticName -eq "ControlType.$ct") -and ([string](ValOf $_)).Contains($spec) -and -not $_.Current.IsOffscreen } catch { $false } })
      if ($c.Count -gt $idx) { return $c[$idx] }; Start-Sleep -Milliseconds 400 } while ((Get-Date) -lt $deadline); return $null }
  do { $all = UiaAll $h
    $c = @($all | ? { try { $n = $_.Current.Name; $okT = (-not $ct) -or ($_.Current.ControlType.ProgrammaticName -eq "ControlType.$ct"); $okT -and ($n -eq $spec) } catch { $false } })
    if ($c.Count -eq 0 -and -not $contains) { $contains = $true }
    if ($c.Count -eq 0 -and $contains) { $c = @($all | ? { try { $n = $_.Current.Name; $okT = (-not $ct) -or ($_.Current.ControlType.ProgrammaticName -eq "ControlType.$ct"); $okT -and $n -and $n.Contains($spec) } catch { $false } }) }
    # native textareas have no Name: a '~text' spec also matches an Edit whose value contains the text
    if ($c.Count -eq 0 -and $spec) { $c = @($all | ? { try { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and ((-not $ct) -or $ct -eq 'Edit') -and ([string](ValOf $_)).Contains($spec) } catch { $false } }) }
    $c = @($c | ? { try { -not $_.Current.IsOffscreen -and $_.Current.BoundingRectangle.Width -gt 0 } catch { $false } })
    # containers (Group/Pane/Document) share names with their first child — prefer the leaf control
    $c = @(@($c | ? { $_.Current.ControlType.ProgrammaticName -notmatch 'Group|Pane|Document|Window' }) + @($c | ? { $_.Current.ControlType.ProgrammaticName -match 'Group|Pane|Document|Window' }))
    if ($c.Count -gt $idx) { return $c[$idx] }
    Start-Sleep -Milliseconds 400 } while ((Get-Date) -lt $deadline)
  return $null }
function ValOf($e) { $vp = $null; if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return $vp.Current.Value }; return $null }
function UiaClick([string]$spec, [int]$n = 1, [IntPtr]$h = $script:target, [string]$btn = 'left') { $e = UiaFind $spec $h
  if (-not $e) { L "ERR uclick MISS [$spec]"; return $false }
  $b = $e.Current.BoundingRectangle; $x = [int]($b.X + $b.Width / 2); $y = [int]($b.Y + $b.Height / 2)
  if ($btn -eq 'right') { ClickScreen $x $y 1 8 0x10 } else { ClickScreen $x $y $n }
  L "uclick [$spec] -> $($e.Current.ControlType.ProgrammaticName) '$($e.Current.Name)' at $x,$y"; return $true }
function DlgHwnd([string]$titleRx = '') { $d = (Wins | ? { $_ -match 'cls=#32770' -and ((-not $titleRx) -or ($_ -match "title=\[[^\]]*($titleRx)")) } | select -First 1)
  if ($d) { return [IntPtr][int64]($d.Split(' ')[0]) }; return [IntPtr]::Zero }
function WaitDlg([int]$sec = 10, [string]$titleRx = '') { for ($i = 0; $i -lt $sec * 4; $i++) { $h = DlgHwnd $titleRx; if ($h -ne [IntPtr]::Zero) { return $h }; Start-Sleep -Milliseconds 250 }; return [IntPtr]::Zero }
function ReadV([string]$rel) { $p = if ($rel -match '^[A-Za-z]:') { $rel } else { Join-Path $Vault $rel }; if (Test-Path $p) { return [IO.File]::ReadAllText($p) } else { return $null } }
function Esc([string]$s) { if ($null -eq $s) { return '<null>' }; return $s.Replace("`r", '\r').Replace("`n", '\n') }
function Unesc([string]$s) { return $s.Replace('\r', "`r").Replace('\n', "`n").Replace('\t', "`t") }
# fraction of sampled pixels that differ from the median colour — ~0 means a blank (all-white) window
function Variance($bmp) { $cnt = @{}; $n = 0; for ($x = 5; $x -lt $bmp.Width; $x += 17) { for ($y = 5; $y -lt $bmp.Height; $y += 17) { $c = $bmp.GetPixel($x, $y).ToArgb(); $cnt[$c] = 1 + [int]$cnt[$c]; $n++ } }
  $top = ($cnt.Values | Measure-Object -Maximum).Maximum; return [double](1 - $top / [Math]::Max(1, $n)) }
function WebviewWs { $wv = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ? { $_.CommandLine -match 'solomd' }); $tot = 0
  foreach ($q in $wv) { $pp = Get-Process -Id $q.ProcessId -EA SilentlyContinue; if ($pp) { $tot += $pp.WorkingSet64 } }; return [int]($tot / 1MB) }
$vars = @{}
function UiaName([string]$rx) { foreach ($e in (UiaAll $script:target)) { try { if ($e.Current.Name -match $rx -and -not $e.Current.IsOffscreen) { return $e.Current.Name } } catch {} }; return $null }
function UiaRectS([string]$spec) { $e = UiaFind $spec $script:target 3000; if (-not $e) { return 'missing' }; $b = $e.Current.BoundingRectangle; return "$([int]$b.X),$([int]$b.Y),$([int]$b.Width),$([int]$b.Height)" }
function TaskbarClick([string]$name) { $tb = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')))
  if (-not $tb) { return $false }; $btn = @($tb.FindAll($TW, [System.Windows.Automation.Condition]::TrueCondition) | ? { try { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $_.Current.Name -match $name } catch { $false } }) | select -First 1
  if (-not $btn) { return $false }; $b = $btn.Current.BoundingRectangle; ClickScreen ([int]($b.X + $b.Width/2)) ([int]($b.Y + $b.Height/2)); L "taskbar click '$($btn.Current.Name)'"; return $true }

Get-Process $ProcName -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-Process msedgewebview2 -EA SilentlyContinue | ? { try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'solomd' } catch { $false } } | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 1
$lines = Get-Content -Path $StepsFile -Encoding UTF8
foreach ($st in $lines) { $st = $st.TrimEnd("`r"); if (-not $st.Trim() -or $st.TrimStart().StartsWith('#')) { continue }
  $st = $st.TrimStart(); if ($st -match '^\[(\w+)\]\s*(.*)$') { if ($Matches[1] -ne $Engine) { continue }; $st = $Matches[2] }   # "[cm] op:arg" / "[native] op:arg"
  $kv = $st.Split(':', 2); $op = $kv[0].Trim(); $arg = if ($kv.Count -gt 1) { $kv[1] } else { '' }
  $arg = $arg.Replace('$V', $V)
  try {
  switch ($op) {
    'launch' { Launch }
    'open'   { Launch ('"' + $arg + '"') }                 # launch with a file argument
    'run'    { Launch $arg }                               # launch with a raw argument line
    'open2'  { Start-Process $Exe -ArgumentList ('"' + $arg + '"'); L "open2 $arg" }   # hand a file to the running instance
    'kill'   { Get-Process $ProcName -EA SilentlyContinue | Stop-Process -Force; L "killed" }
    'find'   { FindWin; L "window=$script:target" }
    'win2'   { $w = AppWins; $o = @($w | ? { $_ -ne $script:main }); if ($o.Count) { $script:target = $o[-1]; L "win2=$script:target" } else { L "win2 none (n=$($w.Count))" } }
    'win1'   { $script:target = $script:main; L "win1=$script:target" }
    'pin'    { Pin; L "pinned $Pin" }
    'wait'   { Start-Sleep -Seconds ([int]$arg) }
    'ms'     { Start-Sleep -Milliseconds ([int]$arg) }
    'fg'     { Fg }
    'fgdlg'  { $h = WaitDlg 10 $arg; if ($h -ne [IntPtr]::Zero) { FgH $h | Out-Null; L "fgdlg $h [$(TitleOf $h)]" } else { L "fgdlg none" } }
    'key'    { Combo $arg; Start-Sleep -Milliseconds 150; L "key $arg" }
    'keys'   { TypeKeys $arg; L "keys $arg" }
    'type'   { TypeUni $arg; L "type $arg" }
    'click'  { MouseAt $arg; [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); L "click $arg" }
    'dbl'    { MouseAt $arg; for ($k=0;$k -lt 2;$k++) { [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }; L "dbl $arg" }
    'rclick' { MouseAt $arg; [W]::mouse_event(8,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(0x10,0,0,0,[UIntPtr]::Zero); L "rclick $arg" }
    'move'   { MouseAt $arg; [W]::mouse_event(1,0,0,0,[UIntPtr]::Zero); L "move $arg" }
    'uclick' { UiaClick $arg | Out-Null }                  # real mouse click at the centre of the UIA element
    'uclick?' { $e = UiaFind $arg $script:target 1500; if ($e) { UiaClick $arg | Out-Null } else { L "optional [$arg] not present" } }
    'waitexit' { for ($i = 0; $i -lt [int]$arg * 4 -and (Get-Process $ProcName -EA SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }; L ("exited=" + -not [bool](Get-Process $ProcName -EA SilentlyContinue)) }
    'udbl'   { UiaClick $arg 2 | Out-Null }
    'urclick' { UiaClick $arg 1 $script:target 'right' | Out-Null }
    'umove'  { $e = UiaFind $arg; if ($e) { $b = $e.Current.BoundingRectangle; [W]::SetCursorPos([int]($b.X + $b.Width/2), [int]($b.Y + $b.Height/2)) | Out-Null; [W]::mouse_event(1,0,0,0,[UIntPtr]::Zero); L "umove [$arg]" } else { L "umove MISS [$arg]" } }
    'dclick' { $h = WaitDlg 10; if ($h -ne [IntPtr]::Zero) { UiaClick $arg 1 $h | Out-Null } else { L "dclick no dialog" } }   # click in the native dialog
    # ---- assertions ----
    'uia'    { $p2 = $arg.Split('|', 2); $e = UiaFind $p2[1] $script:target 5000; Check $p2[0] ($null -ne $e) ("[$($p2[1])]" + $(if ($e) { " = '$($e.Current.Name)'" } else { ' not found' })) }
    'ucls'   { $p2 = $arg.Split('|', 2); $hit = @(UiaAll $script:target | ? { try { $_.Current.ClassName -match $p2[1] } catch { $false } }); Check $p2[0] ($hit.Count -gt 0) ("class /$($p2[1])/ n=$($hit.Count)") }
    'noucls' { $p2 = $arg.Split('|', 2); $hit = @(UiaAll $script:target | ? { try { $_.Current.ClassName -match $p2[1] } catch { $false } }); Check $p2[0] ($hit.Count -eq 0) ("class /$($p2[1])/ n=$($hit.Count)") }
    'ucount' { $p3 = $arg.Split('|', 3); $hit = @(UiaAll $script:target | ? { try { $_.Current.ClassName -match $p3[1] -and -not $_.Current.IsOffscreen } catch { $false } }); Check $p3[0] ($hit.Count -eq [int]$p3[2]) ("class /$($p3[1])/ count=$($hit.Count) want=$($p3[2])") }
    'urect'  { $p2 = $arg.Split('|', 2); $vars[$p2[0]] = UiaRectS $p2[1]; L "urect $($p2[0])=[$($vars[$p2[0]])] ($($p2[1]))" }
    'taskbar' { if (-not (TaskbarClick $arg)) { L "ERR taskbar button /$arg/ not found" } }
    'nouia'  { $p2 = $arg.Split('|', 2); $e = UiaFind $p2[1] $script:target 1500; Check $p2[0] ($null -eq $e) ("[$($p2[1])]" + $(if ($e) { " present '$($e.Current.Name)'" } else { ' absent' })) }
    'ddump'  { $h = WaitDlg 5; $all = UiaAll $h; $o = foreach ($e in $all) { try { $c = $e.Current; $b = $c.BoundingRectangle; "$($c.ControlType.ProgrammaticName -replace 'ControlType.','')`t[$($c.Name)]`t$([int]$b.X),$([int]$b.Y),$([int]$b.Width),$([int]$b.Height)" } catch {} }
               Set-Content -Path "$Out-uia-dlg-$arg.txt" -Encoding UTF8 -Value ($o -join "`n"); L "ddump $arg ($($all.Count) elements)" }
    'udump'  { $all = UiaAll $script:target; $o = foreach ($e in $all) { try { $c = $e.Current; if ($c.Name -or $c.ControlType.ProgrammaticName -match 'Edit|Document|ComboBox|List|CheckBox|Button|Menu') { $b = $c.BoundingRectangle; "$($c.ControlType.ProgrammaticName -replace 'ControlType.','')`t[$($c.Name)]`t$([int]$b.X),$([int]$b.Y),$([int]$b.Width),$([int]$b.Height)$(if ($c.IsOffscreen) {' off'})`t$($c.ClassName)$(if ($c.ControlType.ProgrammaticName -match 'Edit') { "`tvalue=" + (Esc ([string](ValOf $e))) })" } } catch {} }
               Set-Content -Path "$Out-uia-$arg.txt" -Encoding UTF8 -Value ($o -join "`n"); L "udump $arg ($($all.Count) elements)" }
    'fileeq' { $p3 = $arg.Split('|', 3); $exp = Unesc $p3[2]; for ($i = 0; $i -lt 8; $i++) { $t = ReadV $p3[1]; if ($t -ceq $exp) { break }; Start-Sleep -Milliseconds 500 }; Check $p3[0] ($t -ceq $exp) ("got=" + (Esc $t)) }
    'filehas' { $p3 = $arg.Split('|', 3); $exp = Unesc $p3[2]; for ($i = 0; $i -lt 8; $i++) { $t = ReadV $p3[1]; if (($null -ne $t) -and $t.Contains($exp)) { break }; if ($i -eq 0) { L ("filehas first read=" + (Esc $t)) }; Start-Sleep -Milliseconds 500 }; Check $p3[0] (($null -ne $t) -and $t.Contains($exp)) ("got=" + (Esc $t)) }
    'filelacks' { $p3 = $arg.Split('|', 3); $t = ReadV $p3[1]; $exp = Unesc $p3[2]; Check $p3[0] (($null -ne $t) -and -not $t.Contains($exp)) ("got=" + (Esc $t)) }
    'watchfile' { $p2 = $arg.Split('|', 2); $f = Join-Path $Vault $p2[0]; $last = ''; $t0 = Get-Date   # log every size/mtime change of a vault file for N s
               while (((Get-Date) - $t0).TotalSeconds -lt [double]$p2[1]) { $cur = if (Test-Path $f) { $i = Get-Item $f; "len=$($i.Length) mtime=$($i.LastWriteTime.ToString('HH:mm:ss.fff'))" } else { 'missing' }
                 if ($cur -ne $last) { L ("watch +" + [int]((Get-Date) - $t0).TotalMilliseconds + "ms $($p2[0]) $cur"); $last = $cur }; Start-Sleep -Milliseconds 50 } }
    'fileshow' { L ("file $arg = " + (Esc (ReadV $arg))) }
    'expect' { $p2 = $arg.Split('|', 2); $val = $null; try { $val = Invoke-Expression $p2[1] } catch { $val = "ERR $_" }; Check $p2[0] ([bool]$val -and -not ("$val".StartsWith('ERR '))) ("expr=[$($p2[1])] val=[$val]") }
    'set'    { $p2 = $arg.Split('|', 2); $vars[$p2[0]] = Invoke-Expression $p2[1]; L "set $($p2[0])=[$($vars[$p2[0]])]" }
    'title~' { $p2 = $arg.Split('|', 2); $t = TitleOf $script:target; Check $p2[0] ($t -match $p2[1]) "title=[$t]" }
    'dlg'    { $p2 = $arg.Split('|', 2); $h = WaitDlg 8 $p2[1]; Check $p2[0] ($h -ne [IntPtr]::Zero) ("dialog /$($p2[1])/ " + $(if ($h -ne [IntPtr]::Zero) { "[$(TitleOf $h)]" } else { 'none' })) }
    'nodlg'  { $p2 = $arg.Split('|', 2); Start-Sleep -Milliseconds 800; $h = DlgHwnd $p2[1]; Check $p2[0] ($h -eq [IntPtr]::Zero) ("dialog /$($p2[1])/ " + $(if ($h -ne [IntPtr]::Zero) { "[$(TitleOf $h)]" } else { 'none' })) }
    'alive'  { $p2 = $arg.Split('|', 2); $a = [bool](Get-Process $ProcName -EA SilentlyContinue); if ($p2[0]) { Check $p2[0] ($a -eq ($p2[1] -ne 'dead')) "alive=$a" } else { L "alive=$a" } }
    'nonblank' { $r = Rect; $bmp = ShotRect "nb-$arg" $r; $variance = Variance $bmp; $bmp.Dispose(); Check $arg ($variance -gt 0.03) ("variance=" + [Math]::Round($variance, 3)) }
    'nwin'   { $p2 = $arg.Split('|', 2); $n = (AppWins).Count; Check $p2[0] ($n -eq [int]$p2[1]) "windows=$n" }
    # ---- misc ----
    'shot'   { Shot $arg }
    'title'  { L "title=[$(TitleOf $script:target)]" }
    'rect'   { $r = Rect; L ("rect=$($r.L),$($r.T),$($r.R),$($r.B) zoomed=" + [W]::IsZoomed($script:target) + " iconic=" + [W]::IsIconic($script:target)) }
    'show'   { [W]::ShowWindow($script:target, [int]$arg) | Out-Null; L "showwindow $arg" }
    'wins'   { foreach ($w in (Wins)) { L "win $w" } }
    'mem'    { $vars['mem'] = WebviewWs; Get-Process $ProcName -EA SilentlyContinue | % { L ("mem pid=$($_.Id) ws=" + [int]($_.WorkingSet64/1MB) + "MB") }; L "mem webview2 ws=$($vars['mem'])MB" }
    'imeon'  { # make sure the foreground thread uses Microsoft Pinyin in Chinese conversion mode
               $tid = [W]::GetWindowThreadProcessId([W]::GetForegroundWindow(), [IntPtr]::Zero); L ("hkl=0x{0:X}" -f [int64][W]::GetKeyboardLayout($tid))
               $ime = [W]::ImmGetDefaultIMEWnd([W]::GetForegroundWindow()); $m = [int64][W]::SendMessage($ime, 0x283, [IntPtr]1, [IntPtr]::Zero); L "ime mode=$m"
               if (($m -band 1) -eq 0) { Key 0x10; Start-Sleep -Milliseconds 400; $m = [int64][W]::SendMessage($ime, 0x283, [IntPtr]1, [IntPtr]::Zero); L "tapped Shift, ime mode=$m" }
               Check 'ime.chinese-mode' (($m -band 1) -ne 0) "mode=$m" }
    'imeoff' { $ime = [W]::ImmGetDefaultIMEWnd([W]::GetForegroundWindow()); $m = [int64][W]::SendMessage($ime, 0x283, [IntPtr]1, [IntPtr]::Zero); if (($m -band 1) -ne 0) { Key 0x10; Start-Sleep -Milliseconds 400; L "tapped Shift->en" } }
    'ps'     { $r = Invoke-Expression $arg 2>&1 | Out-String; L "ps> $arg => $($r.Trim())" }
    default  { L "ERR unknown op '$op'" }
  }
  } catch { L "ERR $op : $_" }
}
L "done"
Set-Content -Path "$Out.txt" -Encoding UTF8 -Value ($log -join "`n")
