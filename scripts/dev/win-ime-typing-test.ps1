param([string]$Exe = "notepad.exe", [string]$Title = "", [switch]$NewTab, [string]$ExeArgs = "", [string]$WinText = "", [int]$AfterEnterMs = 300, [int]$BeforeEnterMs = 300, [string]$Out = "C:\Users\Public\ime-result.txt", [int]$Settle = 4, [switch]$MidInsert, [string]$MidClick = "", [switch]$Blocks)
$ErrorActionPreference = "Continue"
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
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
function Key([byte]$vk, [int]$hold = 30) { [W]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds $hold; [W]::keybd_event($vk, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
function Combo([byte[]]$mods, [byte]$vk) { foreach ($m in $mods) { [W]::keybd_event($m, 0, 0, [UIntPtr]::Zero) }; Start-Sleep -Milliseconds 30; Key $vk; foreach ($m in $mods) { [W]::keybd_event($m, 0, 2, [UIntPtr]::Zero) }; Start-Sleep -Milliseconds 80 }
function TypeAscii([string]$s) { foreach ($c in $s.ToCharArray()) {
  if ($c -match '[a-z]') { Key ([byte][char]($c.ToString().ToUpper())) }
  elseif ($c -match '[0-9]') { Key ([byte][char]$c) }
  elseif ($c -eq ' ') { Key 0x20 }
  elseif ($c -eq ',') { Key 0xBC } elseif ($c -eq '.') { Key 0xBE }
  elseif ($c -eq "`n") { Key 0x0D }
} }
Get-Process msedge, Notepad -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-Process SoloMD -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep 1
if ($ExeArgs) { $p = Start-Process $Exe -ArgumentList $ExeArgs -PassThru } else { $p = Start-Process $Exe -PassThru }
Start-Sleep -Seconds $Settle
# find a visible top-level window of the process
$target = [IntPtr]::Zero
$procIds = @($p.Id) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | % { [int]$_.ProcessId })
[W]::EnumWindows({ param($h, $l) $pid2 = 0; [W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($procIds -contains [int]$pid2 -and [W]::IsWindowVisible($h)) { $sb = New-Object Text.StringBuilder 256; [W]::GetClassName($h, $sb, 256) | Out-Null
    if ($Title -eq "" -or $sb.ToString() -eq $Title) { $script:target = $h; return $false } }; return $true }, [IntPtr]::Zero) | Out-Null
if ($target -eq [IntPtr]::Zero -and $WinText) {
  [W]::EnumWindows({ param($h, $l) if ([W]::IsWindowVisible($h)) { $sb = New-Object Text.StringBuilder 512; [W]::GetWindowText($h, $sb, 512) | Out-Null
    if ($sb.ToString() -like "*$WinText*") { $script:target = $h; return $false } }; return $true }, [IntPtr]::Zero) | Out-Null }
if ($target -eq [IntPtr]::Zero) { $target = $p.MainWindowHandle }
L "target=$target pid=$($p.Id)"
[W]::ShowWindow($target, 3) | Out-Null
for ($i = 0; $i -lt 20 -and [W]::GetForegroundWindow() -ne $target; $i++) {
  $fg = [W]::GetForegroundWindow(); $fgTid = [W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); $me = [W]::GetCurrentThreadId()
  [W]::AttachThreadInput($me, $fgTid, $true) | Out-Null
  [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [W]::BringWindowToTop($target) | Out-Null; [W]::SetForegroundWindow($target) | Out-Null
  [W]::AttachThreadInput($me, $fgTid, $false) | Out-Null
  Start-Sleep -Milliseconds 250 }
$ok = [W]::GetForegroundWindow() -eq $target
L "foreground ok=$ok"
if (-not $ok) { Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b0 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bm0 = New-Object Drawing.Bitmap $b0.Width, $b0.Height; $g0 = [Drawing.Graphics]::FromImage($bm0); $g0.CopyFromScreen($b0.Location, [Drawing.Point]::Empty, $b0.Size); $bm0.Save($Out + ".png"); $sbf = New-Object Text.StringBuilder 512; [W]::GetWindowText([W]::GetForegroundWindow(), $sbf, 512) | Out-Null; L ("fg window: " + $sbf.ToString()); Set-Content -Path $Out -Encoding UTF8 -Value (($log -join "`n") + "`n----TEXT----`nABORTED: target not foreground"); exit 1 }
Start-Sleep -Milliseconds 800
if ($NewTab) { Combo @(0x11) 0x4E; Start-Sleep -Seconds 2; L "new tab" }
$r = New-Object W+RECT; [W]::GetWindowRect($target, [ref]$r) | Out-Null
$cx = [int](($r.L + $r.R) / 2); $cy = [int]($r.T + 220)
[W]::SetCursorPos($cx, $cy) | Out-Null; [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 700; L "clicked editor at $cx,$cy"
function ImeMode { $ime = [W]::ImmGetDefaultIMEWnd([W]::GetForegroundWindow()); return [int64][W]::SendMessage($ime, 0x283, [IntPtr]1, [IntPtr]::Zero) }
$m = ImeMode; L "ime conversion mode before=$m"
if (($m -band 1) -eq 0) { Key 0x10; Start-Sleep -Milliseconds 400; $m = ImeMode; L "tapped Shift, mode now=$m" }
$tid = [W]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
L ("hkl=0x{0:X}" -f [int64][W]::GetKeyboardLayout($tid))
# the test text: each line = pinyin + space (pick first candidate), punctuation via , and .
$lines = @("zheshi diyihang ", "nihao shijie ", "women shi pengyou ", "zhege zi bu neng diu ", "jintian tianqi henhao ,", "zaijian ", "shuru fa ceshi ", "zuihou yihang ,,, ..")
foreach ($ln in $lines) { $parts = $ln -split "~"; for ($pi = 0; $pi -lt $parts.Count; $pi++) { if ($pi % 2 -eq 1) { Set-Clipboard -Value $parts[$pi]; Start-Sleep -Milliseconds 150; Combo @(0x11) 0x56; Start-Sleep -Milliseconds 300 } else { TypeAscii $parts[$pi] } }; Start-Sleep -Milliseconds $BeforeEnterMs; Key 0x0D; if ($Blocks) { Start-Sleep -Milliseconds 200; Key 0x0D }; Start-Sleep -Milliseconds $AfterEnterMs }
# 张工 4.14.8 report #1: typing Chinese in the middle of a paragraph must
# land at the caret, not at the end of the document. Go to the start of line 3
# ("我们是朋友") and commit 插入 there — expected "插入我们是朋友".
if ($MidInsert) {
  Start-Sleep -Milliseconds 600
  Combo @(0x11) 0x24; Start-Sleep -Milliseconds 300
  Key 0x28; Start-Sleep -Milliseconds 200; Key 0x28; Start-Sleep -Milliseconds 200
  Key 0x24; Start-Sleep -Milliseconds 300
  L "mid-insert at line 3"
  TypeAscii "charu "; Start-Sleep -Milliseconds 400
  TypeAscii "ceshi "; Start-Sleep -Milliseconds 400
}
# 张工's exact steps: place the caret with the MOUSE inside a paragraph (no
# selection), then type Chinese. -MidClick "x,y" are screen coordinates.
if ($MidClick) {
  Start-Sleep -Milliseconds 600
  $xy = $MidClick.Split(','); [W]::SetCursorPos([int]$xy[0], [int]$xy[1]) | Out-Null
  [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500; L "mid-click at $MidClick"
  TypeAscii "charu "; Start-Sleep -Milliseconds 500
  TypeAscii "ceshi "; Start-Sleep -Milliseconds 500
}
Start-Sleep -Milliseconds 800
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
$g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size); $bmp.Save($Out + ".png"); $g.Dispose(); $bmp.Dispose()
Set-Clipboard -Value "__EMPTY__"
Combo @(0x11) 0x41; Combo @(0x11) 0x43; Start-Sleep -Milliseconds 500
$txt = Get-Clipboard -Raw
L "done"
Set-Content -Path $Out -Encoding UTF8 -Value (($log -join "`n") + "`n----TEXT----`n" + $txt)
