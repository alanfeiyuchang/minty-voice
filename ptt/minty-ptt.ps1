# Push-to-talk hotkey listener (Windows): polls GetAsyncKeyState, no permissions needed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File minty-ptt.ps1 [right-option|right-command|right-control] [tag]
#
# Prints one word per line, same protocol as the macOS / Linux listeners:
#   ready / down / up / cancel (another key pressed while holding) / unsupported
# Listens only; the key still reaches the foreground app. Exits when the parent (the plugin) is gone.
param([string]$Key = 'right-option', [string]$Tag = '')

function Say([string]$word) { [Console]::Out.WriteLine($word); [Console]::Out.Flush() }

# Key names follow the macOS wording: option = Alt, command = Win
$codes = @{ 'right-option' = 0xA5; 'right-command' = 0x5C; 'right-control' = 0xA3 }  # VK_RMENU / VK_RWIN / VK_RCONTROL
if (-not $codes.ContainsKey($Key)) { Say 'unsupported'; exit 2 }
$target = $codes[$Key]

Add-Type -Namespace Minty -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);'

# Codes that are down together with the target and must not count as "another key":
# the generic Shift/Ctrl/Alt codes, and Left Ctrl, which Windows reports with Right Alt on AltGr layouts.
$ignore = @(0x10, 0x11, 0x12, $target)
if ($target -eq 0xA5) { $ignore += 0xA2 }

function IsDown([int]$vk) { return ([Minty.Keys]::GetAsyncKeyState($vk) -band 0x8000) -ne 0 }

$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
Say 'ready'
$held = $false
$spoiled = $false
$tick = 0
while ($true) {
  $down = IsDown $target
  if ($down -and -not $held) {
    $held = $true; $spoiled = $false; Say 'down'
  } elseif (-not $down -and $held) {
    $held = $false
    if (-not $spoiled) { Say 'up' }
  } elseif ($held -and -not $spoiled) {
    for ($vk = 0x08; $vk -le 0xFE; $vk++) {
      if ($ignore -contains $vk) { continue }
      if (IsDown $vk) { $spoiled = $true; Say 'cancel'; break }
    }
  }
  Start-Sleep -Milliseconds 25
  $tick++
  if ($tick % 80 -eq 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit 0 }
}
