param([string]$Exe, [string]$Steps, [string]$Out = "C:\Users\Public\ui-steps", [string]$WinClass = "Tauri Window", [string]$ProcName = "SoloMD")
# Drive SoloMD in the Windows VM through a list of steps, with real input:
#   launch | open:<file> | open2:<file> | kill | wait:<s> | ms:<ms> | key:<combo> (ctrl+b, alt+f4, ctrl+shift+b, enter, esc…)
#   type:<ascii> | wheel:<x>,<y>,<notches down> | click:<x>,<y> (window-relative CSS-ish px) | shot:<name> | fg
# Steps are ';'-separated. Screenshots land at <Out>-<name>.png, the log at <Out>.txt.
$ErrorActionPreference = "Continue"
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
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
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint tid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
[W]::ShowWindow([W]::GetConsoleWindow(), 0) | Out-Null
$log = New-Object System.Collections.Generic.List[string]
function L($m) { $log.Add("$(Get-Date -Format HH:mm:ss.fff) $m") }
# Real hardware scan codes: with scan 0, WebView2 reports KeyboardEvent.code as
# "" — a keyboard never does that, and code-based shortcuts (Ctrl+,) then miss.
function Scan([byte]$vk) { return [byte]([W]::MapVirtualKey($vk, 0) -band 0xFF) }
function Key([byte]$vk, [int]$hold = 30) { $sc = Scan $vk; [W]::keybd_event($vk, $sc, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [W]::keybd_event($vk, $sc, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
$VK = @{ ctrl=0x11; shift=0x10; alt=0x12; enter=0x0D; esc=0x1B; tab=0x09; home=0x24; end=0x23; up=0x26; down=0x28; left=0x25; right=0x27; f4=0x73; backspace=0x08; delete=0x2E; space=0x20; comma=0xBC; period=0xBE }
function VkOf([string]$k) { if ($VK.ContainsKey($k)) { return [byte]$VK[$k] }; return [byte][char]($k.ToUpper()) }
function Combo([string]$c) { $parts = $c.ToLower().Split('+'); $mods = @($parts[0..($parts.Count-2)] | ? { $_ }); $k = VkOf $parts[-1]
  foreach ($m in $mods) { [W]::keybd_event((VkOf $m), (Scan (VkOf $m)), 0, [UIntPtr]::Zero) }; Start-Sleep -Milliseconds 30; Key $k
  [array]::Reverse($mods); foreach ($m in $mods) { [W]::keybd_event((VkOf $m), (Scan (VkOf $m)), 2, [UIntPtr]::Zero) }; Start-Sleep -Milliseconds 80 }
function TypeAscii([string]$s) { foreach ($c in $s.ToCharArray()) {
  if ($c -match '[a-z]') { Key ([byte][char]($c.ToString().ToUpper())) } elseif ($c -match '[0-9]') { Key ([byte][char]$c) }
  elseif ($c -eq ' ') { Key 0x20 } elseif ($c -eq ',') { Key 0xBC } elseif ($c -eq '.') { Key 0xBE } } }
function Shot([string]$name) { Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size); $bmp.Save("$Out-$name.png"); $g.Dispose(); $bmp.Dispose(); L "shot $name" }
$script:target = [IntPtr]::Zero; $script:p = $null
function FindWin { $script:target = [IntPtr]::Zero; $ids = @(Get-Process $ProcName -EA SilentlyContinue | % { $_.Id })
  [W]::EnumWindows({ param($h, $l) $pid2 = 0; [W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($ids -contains [int]$pid2 -and [W]::IsWindowVisible($h)) { $sb = New-Object Text.StringBuilder 256; [W]::GetClassName($h, $sb, 256) | Out-Null
      if ($sb.ToString() -eq $WinClass) { $script:target = $h; return $false } }; return $true }, [IntPtr]::Zero) | Out-Null }
function Fg { for ($i = 0; $i -lt 20 -and [W]::GetForegroundWindow() -ne $script:target; $i++) {
    $fg = [W]::GetForegroundWindow(); $fgTid = [W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); $me = [W]::GetCurrentThreadId()
    [W]::AttachThreadInput($me, $fgTid, $true) | Out-Null; [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [W]::BringWindowToTop($script:target) | Out-Null; [W]::SetForegroundWindow($script:target) | Out-Null; [W]::AttachThreadInput($me, $fgTid, $false) | Out-Null
    Start-Sleep -Milliseconds 250 }
  L ("foreground ok=" + ([W]::GetForegroundWindow() -eq $script:target)) }
function Launch([string]$fileArg = '', [string]$raw = '') { $script:p = if ($raw) { Start-Process $Exe -ArgumentList $raw -PassThru } elseif ($fileArg) { Start-Process $Exe -ArgumentList ('"' + $fileArg + '"') -PassThru } else { Start-Process $Exe -PassThru }; L "launched pid=$($script:p.Id)"
  for ($i = 0; $i -lt 60 -and $script:target -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 500; FindWin }
  L "window=$script:target"; [W]::ShowWindow($script:target, 3) | Out-Null; Start-Sleep -Milliseconds 300; Fg }
Get-Process $ProcName -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue; Start-Sleep 1
foreach ($st in $Steps.Split(';')) { $st = $st.Trim(); if (-not $st) { continue }
  $kv = $st.Split(':', 2); $op = $kv[0]; $arg = if ($kv.Count -gt 1) { $kv[1] } else { '' }
  switch ($op) {
    'launch' { $script:target = [IntPtr]::Zero; Launch }
    'open'   { $script:target = [IntPtr]::Zero; Launch $arg }
    'run'    { $script:target = [IntPtr]::Zero; Launch '' $arg }            # raw argument string          # like double-clicking a file
    'open2'  { Start-Process $Exe -ArgumentList ('"' + $arg + '"'); L "open2 $arg" }  # second file while running
    'kill'   { Get-Process $ProcName -EA SilentlyContinue | Stop-Process -Force; L "killed" }
    'ime'    { $ime = [W]::ImmGetDefaultIMEWnd([W]::GetForegroundWindow()); $m = [int64][W]::SendMessage($ime, 0x283, [IntPtr]1, [IntPtr]::Zero); L "ime mode=$m"; if (($m -band 1) -eq 0) { Key 0x10; Start-Sleep -Milliseconds 400; L "tapped Shift" } }
    'wait'   { Start-Sleep -Seconds ([int]$arg) }
    'ms'     { Start-Sleep -Milliseconds ([int]$arg) }
    'fg'     { Fg }
    'key'    { Combo $arg; L "key $arg" }
    'type'   { TypeAscii $arg; L "type $arg" }
    'click'  { $r = New-Object W+RECT; [W]::GetWindowRect($script:target, [ref]$r) | Out-Null; $xy = $arg.Split(',')
               [W]::SetCursorPos($r.L + [int]$xy[0], $r.T + [int]$xy[1]) | Out-Null; [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); L "click $arg" }
    'wheel'  { $r = New-Object W+RECT; [W]::GetWindowRect($script:target, [ref]$r) | Out-Null; $w = $arg.Split(',')
               [W]::SetCursorPos($r.L + [int]$w[0], $r.T + [int]$w[1]) | Out-Null
               for ($k = 0; $k -lt [Math]::Abs([int]$w[2]); $k++) { [W]::mouse_event(0x0800, 0, 0, [uint32]([int][Math]::Sign(-[int]$w[2]) * 120 -band 0xFFFFFFFF), [UIntPtr]::Zero); Start-Sleep -Milliseconds 80 }; L "wheel $arg" }
    'shot'   { Shot $arg }
    'alive'  { L ("alive=" + [bool](Get-Process $ProcName -EA SilentlyContinue)) }
  } }
L "done"
Set-Content -Path "$Out.txt" -Encoding UTF8 -Value ($log -join "`n")
