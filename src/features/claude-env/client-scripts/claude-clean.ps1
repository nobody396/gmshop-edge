# Claude 成品号 · 本机环境清理（Windows 10/11）
#
# 只清理本机残留，不碰代理软件、不退出任何已登录的账号：
#   ① 会让 Claude Code 走别处的环境变量（中转 API 地址/密钥、指向别处的代理）——删除并备份
#   ② Claude Code 本地的旧设备/统计/实验标识、旧配置备份、遥测缓存——挪到备份目录（会自动重新生成）
#   ③ Claude 桌面版的旧设备标识；「第三方 API 模式」改回官方登录
#   ④ 关闭 Claude Code 遥测和错误上报
#   ⑤ 可选：-TimeZone 时区（关自动时区并改成配套网络所在地）；-LangEn 系统语言英语优先
# 所有改动先备份到 %USERPROFILE%\.claude-clean-backup\<时间>
#
# 用法（PowerShell）：irm https://laoshirenvip.com/claude-clean.ps1 -OutFile $env:TEMP\claude-clean.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\claude-clean.ps1 -TimeZone America/Los_Angeles
#
# 测试用环境变量（客户不需要）：
#   CE_TEST_ROOT=路径 沙箱：系统级操作（环境变量、时区、语言、结束进程）只读写沙箱文件
param([string]$TimeZone = "", [switch]$LangEn)

$ErrorActionPreference = "Stop"
$TS = Get-Date -Format "yyyyMMdd-HHmmss"
$TR = $env:CE_TEST_ROOT
$UH = $env:USERPROFILE
$UTF8 = New-Object System.Text.UTF8Encoding($false)
$BK = Join-Path $UH ".claude-clean-backup\$TS"
$DONE = New-Object System.Collections.ArrayList

$BAD_ENV_NAMES = "ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_HTTP_PROXY CLAUDE_CODE_HTTPS_PROXY CLAUDE_CODE_PROXY_URL NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY" -split " "
$TELEMETRY_ENV = "DISABLE_TELEMETRY DISABLE_ERROR_REPORTING DO_NOT_TRACK CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" -split " "
$CC_ID_KEYS = "userID anonymousId machineID remoteControlMachineId cachedStatsigGates cachedGrowthBookFeatures cachedGrowthBookFeaturesAt cachedDynamicConfigs cachedExperimentData cachedExperimentFeatures metricsStatusCache metricsStatusCacheByPrincipal clientDataCache groveConfigCache passesEligibilityCache modelAccessCache firstStartTime numStartups" -split " "
$CS = Join-Path $UH ".claude\settings.json"
$CCJ = Join-Path $UH ".claude.json"
$DESKTOP_DIRS = @((Join-Path $env:APPDATA "Claude"), (Join-Path $env:LOCALAPPDATA "Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude"), (Join-Path $env:LOCALAPPDATA "Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude"))
$DESKTOP_MODE_FILES = @("Claude-3p", "Claude", "Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude-3p", "Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude") | ForEach-Object { Join-Path (Join-Path $env:LOCALAPPDATA $_) "claude_desktop_config.json" }
$DESKTOP_MODE_FILES += @($DESKTOP_DIRS | ForEach-Object { Join-Path $_ "claude_desktop_config.json" })
$DESKTOP_3P_RE = '("deploymentMode"\s*:\s*)"3p"'
# IANA 时区 → Windows 时区名
$TZ_MAP = @{
  "America/New_York"="Eastern Standard Time"; "America/Detroit"="Eastern Standard Time"; "America/Kentucky/Louisville"="Eastern Standard Time"
  "America/Indiana/Indianapolis"="US Eastern Standard Time"; "America/Chicago"="Central Standard Time"; "America/Indiana/Knox"="Central Standard Time"
  "America/Menominee"="Central Standard Time"; "America/North_Dakota/Center"="Central Standard Time"; "America/Denver"="Mountain Standard Time"
  "America/Boise"="Mountain Standard Time"; "America/Phoenix"="US Mountain Standard Time"; "America/Los_Angeles"="Pacific Standard Time"
  "America/Anchorage"="Alaskan Standard Time"; "Pacific/Honolulu"="Hawaiian Standard Time"; "Asia/Singapore"="Singapore Standard Time"
  "Asia/Tokyo"="Tokyo Standard Time"; "Europe/London"="GMT Standard Time"
  "America/Kentucky/Monticello"="Eastern Standard Time"; "America/Indiana/Vincennes"="Eastern Standard Time"; "America/Indiana/Winamac"="Eastern Standard Time"
  "America/Indiana/Marengo"="Eastern Standard Time"; "America/Indiana/Petersburg"="Eastern Standard Time"; "America/Indiana/Vevay"="Eastern Standard Time"
  "America/Indiana/Tell_City"="Central Standard Time"; "America/North_Dakota/New_Salem"="Central Standard Time"; "America/North_Dakota/Beulah"="Central Standard Time"
  "America/Juneau"="Alaskan Standard Time"; "America/Sitka"="Alaskan Standard Time"; "America/Nome"="Alaskan Standard Time"; "America/Adak"="Aleutian Standard Time"
}

function OK($m)   { Write-Host "✔ $m" -ForegroundColor Green }
function WARN($m) { Write-Host "! $m" -ForegroundColor Yellow }
function STEP($n, $m) { Write-Host ""; Write-Host "[$n] $m" }
function Note($m) { [void]$DONE.Add($m) }
function ReadText($p) { if (Test-Path -LiteralPath $p) { [IO.File]::ReadAllText($p) } else { "" } }
function WriteText($p, $s) { $d = Split-Path -Parent $p; if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }; [IO.File]::WriteAllText($p, $s, $UTF8) }
function JsonRead($p) { $t = ReadText $p; if ($t.Trim()) { $t | ConvertFrom-Json } else { New-Object PSObject } }
function JsonWrite($p, $o) { WriteText $p ($o | ConvertTo-Json -Depth 100) }
function Has($o, $k) { $null -ne $o -and ($o.PSObject.Properties.Name -contains $k) }
function SetProp($o, $k, $v) { if (Has $o $k) { $o.$k = $v } else { $o | Add-Member -NotePropertyName $k -NotePropertyValue $v } }
function DelProp($o, $k) { if (Has $o $k) { $o.PSObject.Properties.Remove($k) } }
function SysLog($m) { if ($TR) { Add-Content -LiteralPath (Join-Path $TR "sys.log") -Value $m -Encoding UTF8 } }
function TFile($n) { Join-Path $TR $n }
function TGet($n, $def) { $p = TFile $n; if (Test-Path -LiteralPath $p) { (ReadText $p).Trim() } else { $def } }
function Backup($p, $name) { if (Test-Path -LiteralPath $p) { New-Item -ItemType Directory -Force -Path $BK | Out-Null; $dst = Join-Path $BK $name; if (-not (Test-Path -LiteralPath $dst)) { Copy-Item -LiteralPath $p $dst -Force } } }

# ---- 系统级操作统一入口（沙箱里读写文件） ----
function Get-EnvVar($n, $scope) { if ($TR) { $o = JsonRead (TFile "env_$scope.json"); if (Has $o $n) { $o.$n } else { $null } } else { [Environment]::GetEnvironmentVariable($n, $scope) } }
function Set-EnvVar($n, $v, $scope) { SysLog "env $scope $n"; if ($TR) { $p = TFile "env_$scope.json"; $o = JsonRead $p; if ($null -eq $v) { DelProp $o $n } else { SetProp $o $n $v }; JsonWrite $p $o } else { [Environment]::SetEnvironmentVariable($n, $v, $scope) } }
function Get-SysTz { if ($TR) { TGet "localtime" "" } else { (& tzutil /g).Trim() } }
function Set-SysTz($w) { SysLog "set timezone $w"; if ($TR) { WriteText (TFile "localtime") $w } else { & tzutil /s "$w" | Out-Null } }
function Get-TzAuto { if ($TR) { return (TGet "tzauto" "3") }
  try { [string](Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate" -ErrorAction Stop).Start } catch { "3" } }
function Set-TzAutoOff { SysLog "disable auto timezone"; if ($TR) { WriteText (TFile "tzauto") "4"; return }
  Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate" -Name Start -Value 4 -Type DWord
  Stop-Service tzautoupdate -ErrorAction SilentlyContinue }
function Get-LangFirst { if ($TR) { return ((ReadText (TFile "lang")) -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1) }
  (Get-WinUserLanguageList)[0].LanguageTag }
function Set-LangUS {
  SysLog "set language en-US"
  if ($TR) { $rest = (ReadText (TFile "lang")) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne "en-US" -and $_ -ne "en" }; WriteText (TFile "lang") ((@("en-US") + $rest) -join "`n"); return }
  $old = Get-WinUserLanguageList; $new = New-WinUserLanguageList "en-US"
  foreach ($l in $old) { if ($l.LanguageTag -ne "en-US" -and $l.LanguageTag -ne "en") { $new.Add($l) } }
  Set-WinUserLanguageList $new -Force
}
function Stop-Claude { SysLog "stop Claude"; if (-not $TR) { Stop-Process -Name "Claude" -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 } }
function Test-Admin { if ($TR) { return (Test-Path (TFile "admin")) }; ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
# 代理类变量只有指向本机（127.0.0.1 / localhost，通常是你的代理软件）才保留；中转/证书类一律停用
function Env-IsBad($name, $val) {
  if ($name -eq "NO_PROXY") { return ($val -match "(?i)claude|anthropic") }
  if ($name -match "^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|CLAUDE_CODE_HTTP_PROXY|CLAUDE_CODE_HTTPS_PROXY|CLAUDE_CODE_PROXY_URL)$") {
    return -not ($val -match "^(https?|socks5h?)://(127\.0\.0\.1|localhost):\d+/?$") }
  return $true
}

if ($TimeZone -and $TimeZone -notmatch '^[A-Za-z_]+(/[A-Za-z_+-]+){1,2}$') { Write-Host "时区格式不对：$TimeZone" -ForegroundColor Red; exit 2 }
$ADMIN = Test-Admin
Write-Host "Claude 本机环境清理（所有改动先备份到 $BK）"
New-Item -ItemType Directory -Force -Path $BK | Out-Null

# ===== 1. 环境变量 =====
STEP 1 "清理会干扰 Claude 的环境变量（中转地址、密钥、指向别处的代理）"
$found = $false; $skipped = @()
foreach ($scope in "User", "Machine") {
  foreach ($n in $BAD_ENV_NAMES) {
    $v = Get-EnvVar $n $scope
    if ($v -and (Env-IsBad $n $v)) {
      if ($scope -eq "Machine" -and -not $ADMIN) { $skipped += $n; continue }
      $found = $true; Write-Host "  系统环境变量（$scope）：$n"
      Add-Content -LiteralPath (Join-Path $BK "env-$scope.txt") -Value "$n=$v" -Encoding UTF8
      Set-EnvVar $n $null $scope
    }
  }
}
$profiles = @("Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1", "Documents\WindowsPowerShell\profile.ps1", "Documents\PowerShell\Microsoft.PowerShell_profile.ps1", "Documents\PowerShell\profile.ps1") | ForEach-Object { Join-Path $UH $_ }
$envRe = '^\s*\$env:(' + ($BAD_ENV_NAMES -join "|") + ')\s*=\s*[''"]?([^''"#]*)'
$pi = 0
foreach ($pf in $profiles) {
  if (-not (Test-Path -LiteralPath $pf)) { continue }
  $lines = (ReadText $pf) -split "`n"; $changed = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $mm = [regex]::Match($lines[$i], $envRe, "IgnoreCase")
    if ($mm.Success -and (Env-IsBad $mm.Groups[1].Value.ToUpper() $mm.Groups[2].Value.Trim())) { Write-Host "  $pf 第 $($i+1) 行：$($mm.Groups[1].Value)=…"; $lines[$i] = "# [claude-clean 已停用 $TS] " + $lines[$i]; $changed = $true }
  }
  if ($changed) { $found = $true; $pi++; Backup $pf "profile-$pi.ps1"; WriteText $pf ($lines -join "`n") }
}
if (Test-Path -LiteralPath $CS) {
  $s = JsonRead $CS; $bad = @()
  if (Has $s "env") { foreach ($n in $BAD_ENV_NAMES) { if ((Has $s.env $n) -and (Env-IsBad $n ([string]$s.env.$n))) { $bad += $n } } }
  if (Has $s "apiKeyHelper") { $bad += "apiKeyHelper" }
  if ($bad.Count) { $found = $true; Write-Host ("  .claude\settings.json：" + ($bad -join " ")); Backup $CS "claude-settings.json"
    foreach ($k in $bad) { if ($k -eq "apiKeyHelper") { DelProp $s $k } else { DelProp $s.env $k } }; JsonWrite $CS $s }
}
if ($found) { OK "以上项目已停用（原值已备份）"; Note "停用了会干扰 Claude 的环境变量" } else { OK "没有发现会干扰的环境变量" }
if ($skipped.Count) { WARN ("这些是整机级变量，需要「以管理员身份运行」PowerShell 再跑一次才能清掉：" + ($skipped -join " ")) }

# ===== 2. Claude Code =====
STEP 2 "Claude Code：清理旧设备标识、旧配置备份和遥测缓存（不会退出登录）"
foreach ($n in $TELEMETRY_ENV) { if ((Get-EnvVar $n "User") -ne "1") { Set-EnvVar $n "1" "User" } }
Backup $CS "claude-settings.json"
$s = JsonRead $CS; if (-not (Has $s "env")) { SetProp $s "env" (New-Object PSObject) }
foreach ($n in $TELEMETRY_ENV) { SetProp $s.env $n "1" }; JsonWrite $CS $s
OK "已关闭 Claude Code 遥测和错误上报"; Note "关闭了 Claude Code 遥测"
$cc = $false
if (Test-Path -LiteralPath $CCJ) { Backup $CCJ "claude.json"; $o = JsonRead $CCJ; foreach ($k in $CC_ID_KEYS) { DelProp $o $k }; JsonWrite $CCJ $o; $cc = $true }
$oldDir = Join-Path $BK "old"; New-Item -ItemType Directory -Force -Path $oldDir | Out-Null
$old = @(Get-ChildItem -Path $UH -Filter ".claude.json.backup*" -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$old += @(".claude\backups", ".claude\statsig", ".claude\telemetry", ".claude\stats-cache.json", ".claude\usage-data", ".claude\usage.jsonl") | ForEach-Object { Join-Path $UH $_ }
$old += (Join-Path $env:LOCALAPPDATA "claude-cli-nodejs")
foreach ($p in $old) { if (Test-Path -LiteralPath $p) { Move-Item -LiteralPath $p $oldDir -Force; $cc = $true } }
if ($cc) { OK "设备/统计/实验标识、旧配置备份、遥测缓存已清理"; Note "清理了 Claude Code 旧设备标识" } else { OK "这台电脑还没用过 Claude Code，不需要清理" }

# ===== 3. 桌面版 =====
STEP 3 "Claude 桌面版：清理旧设备标识，改回官方登录"
$desk = 0; $stopped = $false
foreach ($d in $DESKTOP_DIRS) {
  if (-not (Test-Path -LiteralPath $d)) { continue }
  if (-not $stopped) { Stop-Claude; $stopped = $true }
  $dst = Join-Path $BK ("desktop-" + [Math]::Abs($d.GetHashCode())); New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($n in "ant-did", "ant-device-registry.json", "sentry", "Crashpad", "machine-id", ".machine-id") { $p = Join-Path $d $n; if (Test-Path -LiteralPath $p) { Move-Item -LiteralPath $p $dst -Force; $desk = [Math]::Max($desk, 1) } }
}
$mode3p = @($DESKTOP_MODE_FILES | Select-Object -Unique | Where-Object { (ReadText $_) -match $DESKTOP_3P_RE })
if ($mode3p.Count) {
  if (-not $stopped) { Stop-Claude; $stopped = $true }
  $dst = Join-Path $BK "desktop-mode"; New-Item -ItemType Directory -Force -Path $dst | Out-Null
  $i = 0; foreach ($f in $mode3p) { $i++; Copy-Item -LiteralPath $f (Join-Path $dst "$i-claude_desktop_config.json"); WriteText $f ([regex]::Replace((ReadText $f), $DESKTOP_3P_RE, '$1"1p"')) }
  $desk = 2
}
if ($desk -eq 2) { OK "桌面版已从「第三方 API 模式」改回官方登录，设备标识已清理"; Note "桌面版改回官方登录" }
elseif ($desk -eq 1) { OK "桌面版设备标识已清理（登录状态保留）"; Note "清理了桌面版旧设备标识" }
else { OK "没有需要清理的桌面版数据" }

# ===== 4. 时区 / 语言（可选） =====
if ($TimeZone -or $LangEn) {
  STEP 4 "时区和语言"
  if ($TimeZone) {
    $w = $TZ_MAP[$TimeZone]
    if (-not $w) { WARN "不认识的时区 $TimeZone，请在「设置 → 时间和语言」手动改成配套网络所在地的时区" }
    else {
      if ((Get-TzAuto) -ne "4") { if ($ADMIN) { Set-TzAutoOff } else { WARN "关闭「自动设置时区」需要管理员窗口；请在「设置 → 时间和语言 → 日期和时间」手动关掉「自动设置时区」" } }
      if ((Get-SysTz) -ne $w) { try { Set-SysTz $w } catch { } }
      if ((Get-SysTz) -eq $w) { OK "电脑时区：$w"; Note "时区改成 $w" } else { WARN "时区没改成功，请在「设置 → 时间和语言」手动改成 $w" }
    }
  }
  if ($LangEn) {
    if ((Get-LangFirst) -ne "en-US") { Set-LangUS }
    OK "系统语言：英语排第一（原来的中文和输入法保留），重启电脑后生效"; Note "系统语言英语优先"
  }
}

Write-Host ""
Write-Host "清理完成 ✅" -ForegroundColor Green
foreach ($d in $DONE) { Write-Host "  · $d" }
Write-Host "  备份位置：$BK"
Write-Host "  请关闭并重新打开 PowerShell、浏览器和 Claude 桌面版，再继续下一步。"
