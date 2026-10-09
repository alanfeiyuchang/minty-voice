# 语音助手一键安装（Windows）：起名字 → 选形象 → 选快捷键和声音 → 装依赖 → 接进 Claude Code
#
#   setup.cmd                    一问一答地装（再跑一次就是改设置）
#   setup.cmd -Yes               全用默认值，不问
#   setup.cmd -Name 小橘 -Command xiaoju -Avatar cat -Key right-option -Model turbo -Yes
#   setup.cmd -Uninstall         从 Claude Code 里卸掉（设置和自己做的形象留在 %USERPROFILE%\.claude\minty）
#
# 用 winget 装 SoX、FFmpeg、uv；whisper.cpp 用 GitHub 上官方的预编译包。
# 设置写在 %USERPROFILE%\.claude\minty\config.json，之后在面板的“⚙ 设置”里改也是改它。
param(
  [switch]$Yes,
  [switch]$Uninstall,
  [string]$Name = '',
  [string]$Command = '',
  [string]$Avatar = '',
  [string]$Key = '',
  [string]$Model = '',
  [string]$Voice = '',
  [string]$Language = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

$Root = $PSScriptRoot
$DataDir = Join-Path $HOME '.claude\minty'
$Config = Join-Path $DataDir 'config.json'
$ModelDir = Join-Path $HOME '.whisper'
$Settings = Join-Path $HOME '.claude\settings.json'
$Marketplace = 'minty'
$PluginId = 'minty'
$Utf8 = New-Object Text.UTF8Encoding $false

function Step($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  √ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Die($t) { Write-Host ''; Write-Host "× $t" -ForegroundColor Red; exit 1 }

function Ask($prompt, $default) {
  if ($Yes) { return $default }
  $r = Read-Host "$prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($r)) { return $default } else { return $r.Trim() }
}
function Choose($prompt, [int]$default, [string[]]$options) {
  if ($Yes) { return $default }
  Write-Host $prompt
  for ($i = 0; $i -lt $options.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $options[$i]) }
  while ($true) {
    $r = Read-Host "选哪个？ [$default]"
    if ([string]::IsNullOrWhiteSpace($r)) { return $default }
    $n = 0
    if ([int]::TryParse($r, [ref]$n) -and $n -ge 1 -and $n -le $options.Count) { return $n }
    Write-Host "  输入 1 到 $($options.Count) 之间的数字"
  }
}

function Read-Json($path) {
  if (Test-Path $path) { try { return Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json } catch {} }
  return New-Object PSObject
}
function Write-Json($path, $obj) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 10), $Utf8)
}
function Set-Prop($obj, $name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
function Cfg($name) { $c = Read-Json $Config; if ($c.PSObject.Properties[$name]) { return [string]$c.$name } else { return '' } }

# winget 装完的程序，这个窗口里的 PATH 还没更新：从注册表重新读一遍
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $HOME '.local\bin')
}
function Has($exe) { return [bool](Get-Command $exe -ErrorAction SilentlyContinue) }
function Winget($id, $what) {
  if (-not (Has 'winget')) { Die "需要 winget 来装 $what（Windows 10 / 11 的“应用安装程序”，在 Microsoft Store 里更新它），或者自己装好 $what 再运行一次" }
  Write-Host "  用 winget 安装 $what …"
  winget install -e --id $id --accept-package-agreements --accept-source-agreements --silent | Out-Null
  Refresh-Path
}

# ---------- 卸载 ----------
if ($Uninstall) {
  Step '从 Claude Code 里卸载'
  if (Has 'claude') {
    try { claude plugin uninstall "$PluginId@$Marketplace" | Out-Null; Ok '卸掉了插件' } catch {}
    try { claude plugin marketplace remove $Marketplace | Out-Null; Ok '移除了 marketplace' } catch {}
  }
  if (Test-Path $Settings) {
    $s = Read-Json $Settings
    if ($s.PSObject.Properties['env'] -and $s.env.PSObject.Properties['CLAUDE_CODE_PLUGIN_DIRS']) {
      $dirs = @($s.env.CLAUDE_CODE_PLUGIN_DIRS -split ';' | Where-Object { $_ -and $_ -ne $Root })
      if ($dirs.Count) { $s.env.CLAUDE_CODE_PLUGIN_DIRS = $dirs -join ';' } else { $s.env.PSObject.Properties.Remove('CLAUDE_CODE_PLUGIN_DIRS') }
      Write-Json $Settings $s
      Ok '从 settings.json 的 CLAUDE_CODE_PLUGIN_DIRS 里去掉了'
    }
  }
  Write-Host "设置和自己做的形象还在 $DataDir，不要了就删掉这个文件夹。重启 Claude Code 生效。"
  exit 0
}

Write-Host ''
Write-Host '给 Claude Code 装一个会听会说的语音助手' -ForegroundColor White
Write-Host '点它的形象、或者在任何程序里按住一个键说话（中英混说都行），它在本地听写；要干活就整理成指令发给'
Write-Host 'Claude Code，聊天就自己用语音答。下面先给它起个名字、挑个样子。'

# ---------- 1. 名字和命令 ----------
Step '1/5 起个名字'
if (-not $Name) { $d = Cfg 'name'; if (-not $d) { $d = 'MINTY' }; $Name = Ask '它叫什么？（中文英文都行）' $d }
$Name = $Name.Trim(); if (-not $Name) { $Name = 'MINTY' }
if ($Name.Length -gt 24) { Die '名字太长了（最多 24 个字）' }
$guess = (($Name.ToLower() -replace '[^a-z0-9-]+', '-') -replace '-+', '-').Trim('-')
if ($guess.Length -gt 24) { $guess = $guess.Substring(0, 24) }
if ($guess -notmatch '^[a-z]') { $guess = Cfg 'command'; if (-not $guess) { $guess = 'minty' } }
while ($Command -notmatch '^[a-z][a-z0-9-]{0,23}$') {
  if ($Command) { if ($Yes) { Die "-Command 不合法：$Command" }; Warn '命令只能用小写英文、数字和 -，而且以字母开头' }
  $Command = Ask '斜杠命令叫什么？（输入 /名字 来召唤它）' $guess
}
Ok "名字 $Name，命令 /$Command"

# ---------- 2. 形象 ----------
Step '2/5 选个形象'
$ids = @(); $labels = @()
foreach ($base in @((Join-Path $Root 'avatars'), (Join-Path $DataDir 'avatars'))) {
  if (-not (Test-Path $base)) { continue }
  foreach ($d in Get-ChildItem -Directory $base) {
    if (-not (Get-ChildItem $d.FullName -Filter 'idle.*' -ErrorAction SilentlyContinue)) { continue }
    $label = $d.Name
    $pj = Join-Path $d.FullName 'pack.json'
    if (Test-Path $pj) { try { $n = (Get-Content -Raw -Encoding UTF8 $pj | ConvertFrom-Json).name; if ($n) { $label = $n } } catch {} }
    $ids += $d.Name; $labels += "$label（$($d.Name)）"
  }
}
$ids += 'orb'; $labels += '光球（会转的发光小球，不用图片）'
$ids += '__make__'; $labels += '用我自己的动画做一个（给一个放视频/GIF 的文件夹）'
if (-not $Avatar) {
  $cur = Cfg 'avatar'; if (-not $cur) { $cur = 'cat' }
  $def = [Math]::Max(1, [Array]::IndexOf($ids, $cur) + 1)
  $Avatar = $ids[(Choose '面板里画什么？' $def $labels) - 1]
}
if ($Avatar -eq '__make__') {
  Write-Host '  准备一个文件夹，每个状态放一段动画（视频、GIF 都行），只有 idle 是必须的：'
  Write-Host '    idle 待命   listen 在听   think 在想   wait 等你确认   speak 在说话'
  Write-Host '  纯色背景（绿幕、蓝幕、白底）会自动抠掉；本来就透明的直接用。'
  do { $src = Ask '素材文件夹在哪？' ''; if (-not (Test-Path $src -PathType Container)) { Warn "找不到文件夹：$src" } } until (Test-Path $src -PathType Container)
  $packName = Ask '这个形象叫什么？' (Split-Path $src -Leaf)
  if (-not (Has 'ffmpeg')) { Winget 'Gyan.FFmpeg' 'FFmpeg' }
  if (-not (Has 'uv')) { Winget 'astral-sh.uv' 'uv' }
  $out = & uv run --quiet --with 'pillow>=11.3' --with numpy --with opencv-python-headless (Join-Path $Root 'tools\make-avatar.py') $src --name $packName
  $out | ForEach-Object { Write-Host $_ }
  $made = ($out | Where-Object { $_ -like '好了：*' }) -replace '^好了：', ''
  if (-not $made) { Die '形象没做出来，看上面的报错' }
  $Avatar = Split-Path $made -Leaf
}
Ok "形象 $Avatar"

# ---------- 3. 快捷键 ----------
Step '3/5 按住说话的键'
$keys = @('right-option', 'right-command', 'right-control', 'off')
if (-not $Key) {
  $def = [Math]::Max(1, [Array]::IndexOf($keys, (Cfg 'pttKey')) + 1)
  $Key = $keys[(Choose '在任何程序里按住它就开始录音，松开发出（只监听不拦截，键照常能用）：' $def @('右 Alt（推荐）', '右 Win', '右 Ctrl', '不要快捷键，只点形象')) - 1]
}
if ($keys -notcontains $Key) { Die "-Key 只能是 $($keys -join ' / ')" }
Ok "快捷键 $Key"

# ---------- 4. 声音和听写 ----------
Step '4/5 声音和听写'
$voices = @('zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunyangNeural', 'say')
if (-not $Voice) {
  $cur = Cfg 'edgeVoice'; if ((Cfg 'ttsEngine') -eq 'say') { $cur = 'say' }
  $def = [Math]::Max(1, [Array]::IndexOf($voices, $cur) + 1)
  $Voice = $voices[(Choose '它用什么声音说话？（前四个是微软的神经网络声音，需联网，念的话会发到微软语音服务）' $def @('晓晓 · 女声温和', '云希 · 男声阳光', '晓伊 · 女声活泼', '云扬 · 男声播音腔', 'Windows 自带的朗读（离线，比较机械）')) - 1]
}
$langs = @('zh', 'auto', 'en')
if (-not $Language) { $Language = $langs[(Choose '你平时怎么说？' 1 @('中文为主，夹英文技术词（最稳）', '中英都有，让它自己判断', '英文')) - 1] }
$models = @{ turbo = 'ggml-large-v3-turbo.bin'; small = 'ggml-small.bin'; base = 'ggml-base.bin' }
if (-not $Model) { $Model = @('turbo', 'small', 'base')[(Choose '听写模型（在你电脑上跑，不上传录音）：' 1 @('large-v3-turbo · 1.6 GB · 最准，中英混说推荐', 'small · 470 MB · 快一些，混说时英文词容易听错', 'base · 140 MB · 最快最小，准确度一般')) - 1] }
if (-not $models.ContainsKey($Model)) { Die '-Model 只能是 turbo / small / base' }
$ModelFile = $models[$Model]
Ok "声音 $Voice，语言 $Language，模型 $ModelFile"

# ---------- 5. 安装 ----------
Step '5/5 安装'
Refresh-Path
$soxDirs = @("${env:ProgramFiles(x86)}\sox-14-4-2", "$env:ProgramFiles\sox-14-4-2")
if ((Has 'sox') -or ($soxDirs | Where-Object { Test-Path (Join-Path $_ 'sox.exe') })) { Ok 'SoX 已安装' } else { Winget 'ChrisBagwell.SoX' 'SoX（录音）' }
if (Has 'ffplay') { Ok 'FFmpeg 已安装' } else { Winget 'Gyan.FFmpeg' 'FFmpeg（放语音）' }
if ($Voice -ne 'say') {
  if ((Has 'edge-tts') -or (Test-Path (Join-Path $HOME '.local\bin\edge-tts.exe'))) { Ok 'edge-tts 已安装' }
  else {
    if (-not (Has 'uv')) { Winget 'astral-sh.uv' 'uv' }
    uv tool install edge-tts | Out-Null
    Ok 'edge-tts 装好了'
  }
}

# whisper.cpp：GitHub 上官方的预编译包，解压到 %USERPROFILE%\.claude\minty\whisper
$whisperDir = Join-Path $DataDir 'whisper'
if (Test-Path (Join-Path $whisperDir 'whisper-cli.exe')) { Ok "whisper.cpp 已在 $whisperDir" }
else {
  $asset = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'whisper-bin-win-cpu-arm64.zip' } else { 'whisper-bin-x64.zip' }
  Write-Host "  下载 whisper.cpp 预编译包（$asset）…"
  $releases = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20' -Headers @{ 'User-Agent' = 'minty-setup' }
  $url = $null
  foreach ($r in $releases) { foreach ($a in $r.assets) { if (-not $url -and $a.name -eq $asset) { $url = $a.browser_download_url } } }
  if (-not $url) { Die "GitHub 上没找到 whisper.cpp 的 $asset，过会儿再试" }
  $tmp = Join-Path $env:TEMP "minty-whisper-$PID"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Invoke-WebRequest $url -OutFile (Join-Path $tmp 'w.zip') -UseBasicParsing
  Expand-Archive (Join-Path $tmp 'w.zip') -DestinationPath $tmp -Force
  $cli = Get-ChildItem $tmp -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
  if (-not $cli) { Die 'whisper.cpp 的包里没有 whisper-cli.exe' }
  if (Test-Path $whisperDir) { Remove-Item -Recurse -Force $whisperDir }
  New-Item -ItemType Directory -Force -Path $whisperDir | Out-Null
  Copy-Item (Join-Path $cli.DirectoryName '*') $whisperDir -Recurse -Force
  Remove-Item -Recurse -Force $tmp
  Ok "whisper.cpp 装在了 $whisperDir"
}

New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
$modelPath = Join-Path $ModelDir $ModelFile
if ((Test-Path $modelPath) -and (Get-Item $modelPath).Length -gt 0) { Ok "模型已在 $modelPath" }
else {
  Write-Host "  下载 $ModelFile …"
  # curl.exe 有进度条，Windows 10 1803 起自带
  curl.exe -L --fail --progress-bar -o "$modelPath.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$ModelFile"
  if ($LASTEXITCODE -ne 0) { Die '模型没下载下来，检查网络后再运行一次' }
  Move-Item -Force "$modelPath.part" $modelPath
}

# 写设置：只改这次问到的项，别的（面板里改过的）留着
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'avatars') | Out-Null
$cfg = Read-Json $Config
Set-Prop $cfg 'name' $Name; Set-Prop $cfg 'command' $Command; Set-Prop $cfg 'avatar' $Avatar
Set-Prop $cfg 'pttKey' $Key; Set-Prop $cfg 'language' $Language; Set-Prop $cfg 'whisperModel' ('~/.whisper/' + $ModelFile)
if ($Voice -eq 'say') { Set-Prop $cfg 'ttsEngine' 'say' } else { Set-Prop $cfg 'ttsEngine' 'edge'; Set-Prop $cfg 'edgeVoice' $Voice }
Write-Json $Config $cfg
Ok "设置写进了 $Config"

# 接进 Claude Code：有 claude 命令就装成插件（读的就是这个文件夹）；只用桌面版时写进 settings.json
$s = Read-Json $Settings
$dirs = @()
if ($s.PSObject.Properties['env'] -and $s.env.PSObject.Properties['CLAUDE_CODE_PLUGIN_DIRS']) { $dirs = @($s.env.CLAUDE_CODE_PLUGIN_DIRS -split ';' | Where-Object { $_ }) }
if ($dirs -contains $Root) { Ok "Claude Code 已经从 $Root 加载它（settings.json 的 CLAUDE_CODE_PLUGIN_DIRS）" }
elseif (Has 'claude') {
  if (-not ((claude plugin marketplace list 2>$null) -match $Marketplace)) { claude plugin marketplace add $Root | Out-Null }
  if ((claude plugin list 2>$null) -match "$PluginId@$Marketplace") { Ok "插件已安装（$PluginId@$Marketplace）" }
  else { claude plugin install "$PluginId@$Marketplace" --scope user -y | Out-Null; Ok "装成了 Claude Code 插件（$PluginId@$Marketplace）" }
}
else {
  if (Test-Path $Settings) { Copy-Item $Settings "$Settings.bak-voice" -Force }
  if (-not $s.PSObject.Properties['env']) { Set-Prop $s 'env' (New-Object PSObject) }
  Set-Prop $s.env 'CLAUDE_CODE_PLUGIN_DIRS' ((@($dirs) + $Root) -join ';')
  Write-Json $Settings $s
  Ok "写进了 $Settings（CLAUDE_CODE_PLUGIN_DIRS），桌面版会加载"
}

# 打个招呼
if (-not $Yes) {
  $hello = "你好，我是 $Name，装好了。按住快捷键或者点我，就可以跟我说话。"
  Refresh-Path
  $mp3 = Join-Path $env:TEMP "voice-setup-$PID.mp3"
  $spoke = $false
  if ($Voice -ne 'say' -and (Has 'edge-tts') -and (Has 'ffplay')) {
    edge-tts --voice=$Voice --text=$hello --write-media=$mp3 2>$null | Out-Null
    if (Test-Path $mp3) { ffplay -nodisp -autoexit -loglevel quiet $mp3; Remove-Item $mp3 -Force; $spoke = $true }
  }
  if (-not $spoke) { Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($hello) }
}

Write-Host ''
Write-Host '√ 装好了。' -ForegroundColor Green
Write-Host '  1. 重启 Claude Code（重新运行 claude，或者重开桌面版的 Code 标签页）。'
Write-Host "     对话旁边会出现 $Name 的面板。放不下时输入 /$Command panel 打开。"
Write-Host "  2. 输入 /$Command check 确认依赖都是 √。"
Write-Host '  3. 录不到声音：设置 → 隐私和安全性 → 麦克风，打开“允许桌面应用访问麦克风”。'
Write-Host ''
Write-Host '  想换名字、形象、声音：再运行一次 setup.cmd，或者在面板里点“⚙ 设置”。'
Write-Host '  做自己的形象：tools\make-avatar.cmd <素材文件夹> --name "名字"（说明见 README）。'
