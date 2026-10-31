# Claude 稳定使用环境 · 一键部署（Windows 10/11 + Clash Verge Rev）
#
# 客户前提：① 自己有能用的代理订阅（没装 Clash Verge Rev 的，脚本自动安装并把原软件里的订阅导入）
#           ② 有我们发的开通码（CE1- 开头）
# 链路：客户电脑 → 客户的梯子（自动挑能通的节点）→ 我们的中转 → 客户专属静态 IP → Claude
# 需要管理员权限（改时区服务、定位、系统环境变量、网卡 IPv6、安装 Clash Verge Rev）；
# 不是管理员时什么都不改，提示客户用「终端（管理员）」重新运行，退出码 5。
# 没装 Clash Verge Rev 时：自动下载官方固定版本（SHA-256 校验）静默安装，把原来代理软件（FlClash、Clash for Windows、
# Clash Party / Mihomo Party、Clash Nyanpasu、v2rayN）里正在用的订阅导入进去，再关掉原来的软件和它设的系统代理。
#
# 测试用环境变量（客户不需要）：
#   CE_CODE=CE1-...    不交互，直接用这个开通码
#   CE_TEST_ROOT=/path 压测沙箱：系统级读写全部改为沙箱文件，控制接口走 $CE_TEST_ROOT/verge-mihomo.sock
#   CE_CURL=/path      测试用的 curl 替身
#   CE_TEST_HOOK=/path 沙箱里代替「下载 / 安装 / 启动 Clash Verge」的测试脚本（只在 CE_TEST_ROOT 下生效）
#   CE_SQLITE=/path    沙箱里读 SQLite 用的 sqlite3（真机用系统自带的 winsqlite3.dll）
#   CE_TEST_NOT_ADMIN=1 模拟不是管理员
param([string]$Code = "")
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# ===== 0. 管理员权限：第一件事。不是管理员就什么都不改，告诉客户怎么做（不再自动提权：新窗口一闪就关，客户看不到报错）=====
# CE_TEST_NOT_ADMIN=1 只给测试用：在本来就是管理员的测试机上模拟「不是管理员」。
$isAdmin = $false
if ($env:CE_TEST_NOT_ADMIN -ne "1") {
  if ($env:CE_TEST_ROOT) { $isAdmin = $true }
  else { try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch {} }
}
if (-not $isAdmin) {
  Write-Host ""
  Write-Host "✘ 需要用管理员身份运行。请按下面做：" -ForegroundColor Red
  Write-Host "  1. 先关掉这个窗口"
  Write-Host "  2. 右键点屏幕左下角的「开始」按钮"
  Write-Host "  3. 选「终端（管理员）」；没有这一项就选「Windows PowerShell（管理员）」"
  Write-Host "  4. 弹出「是否允许此应用对你的设备进行更改」时点「是」"
  Write-Host "  5. 在新打开的窗口里重新粘贴那一行命令，回车"
  Write-Host ""
  $canWait = $false; try { $canWait = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not $env:CI -and -not $env:GITHUB_ACTIONS } catch {}
  if ($canWait) { try { [void](Read-Host "看完后按回车关闭") } catch {} }
  exit 5
}

$GROUP_NAME = "Claude静态IP"
$NODE_NAME = "Claude静态IP-节点"
$FRONT_NAME = "Claude静态IP-前置"
$CLAUDE_SUFFIXES = "claude.ai claude.com clau.de anthropic.com claudeusercontent.com claudemcpclient.com claudemcpcontent.com modelcontextprotocol.io servd-anthropic-website.b-cdn.net sentry.io datadoghq.com growthbook.io usefathom.com segment.io siftscience.com statsig.com statsigapi.net hcaptcha.com challenges.cloudflare.com recaptcha.net stripe.com stripe.network stripecdn.com withpersona.com intercom.io intercomcdn.com"
$CLAUDE_KEYWORDS = "claude anthropic browser-intake"
$ANTHROPIC_CIDR = "160.79.104.0/21"
$ANTHROPIC_CIDR6 = "2607:6bc0::/48 2607:6bc0:11::/48"
$MIN_VERGE = [version]"2.4.0"
$MARK_BEGIN = "// >>> claude-env BEGIN"
$MARK_END = "// <<< claude-env END"
$BAD_ENV_NAMES = "ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_HTTP_PROXY CLAUDE_CODE_HTTPS_PROXY CLAUDE_CODE_PROXY_URL NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY" -split " "
$TELEMETRY_ENV = "DISABLE_TELEMETRY DISABLE_ERROR_REPORTING DO_NOT_TRACK CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" -split " "
$CC_ID_KEYS = "userID anonymousId machineID remoteControlMachineId cachedStatsigGates cachedGrowthBookFeatures cachedGrowthBookFeaturesAt cachedDynamicConfigs cachedExperimentData cachedExperimentFeatures metricsStatusCache metricsStatusCacheByPrincipal clientDataCache groveConfigCache passesEligibilityCache modelAccessCache firstStartTime numStartups" -split " "
# IP 时区（IANA）→ Windows 时区名
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
# 其他代理软件：显示名、进程名、它带的内核进程（退出时一起关，免得内核还占着网卡）
$OTHER_CLIENTS = @(
  @("Clash for Windows","Clash for Windows","clash-win64 clash-core-service"), @("Clash Party","Clash Party","mihomo mihomo-alpha mihomo-smart"),
  @("Mihomo Party","Mihomo Party","mihomo mihomo-alpha mihomo-smart"), @("FlClash","FlClash","FlClashCore"),
  @("Clash Nyanpasu","clash-nyanpasu","mihomo mihomo-alpha clash-rs"), @("GUI.for.Clash","GUI.for.Clash","mihomo mihomo-alpha"),
  @("v2rayN","v2rayN","xray v2ray sing-box mihomo"), @("NekoRay","nekoray","nekobox_core nekoray_core"), @("Hiddify","Hiddify","HiddifyCli hiddify-core"),
  @("Karing","karing",""), @("sing-box","sing-box",""), @("Shadowsocks","Shadowsocks",""), @("ShadowsocksR","ShadowsocksR",""), @("Clash.Meta","clash-meta","")
)
# 自动安装的 Clash Verge Rev：官方 GitHub 固定版本 + SHA-256（发布满两周的稳定版）
$VERGE_VER = "2.5.8"
$VERGE_UA = "clash-verge/v$VERGE_VER"
$VERGE_URL = "https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v$VERGE_VER/"
$VERGE_X64 = @("Clash.Verge_2.5.8_x64-setup.exe", "821c0f5957f84c8f7d14532044840e8280d708af24a6a143db360b49bd1e7302")
$VERGE_ARM64 = @("Clash.Verge_2.5.8_arm64-setup.exe", "077efab7874a6be7c48630d19c941ef679fa265f79c243f9d20ce5878eb5a943")
$TS = Get-Date -Format "yyyyMMdd-HHmmss"
$TR = $env:CE_TEST_ROOT
$CURL = if ($env:CE_CURL) { $env:CE_CURL } else { "curl.exe" }
$UH = $env:USERPROFILE
$CV_DIR = Join-Path $env:APPDATA "io.github.clash-verge-rev.clash-verge-rev"
$CV_CFG = Join-Path $CV_DIR "clash-verge.yaml"
$CV_CLASH = Join-Path $CV_DIR "config.yaml"
$VERGE_YAML = Join-Path $CV_DIR "verge.yaml"
$CS = Join-Path $UH ".claude\settings.json"
$CCJ = Join-Path $UH ".claude.json"
$DESKTOP_DIRS = @((Join-Path $env:APPDATA "Claude"), (Join-Path $env:LOCALAPPDATA "Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude"), (Join-Path $env:LOCALAPPDATA "Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude"))
$UTF8 = New-Object System.Text.UTF8Encoding($false)

function OK($m)   { Write-Host "✔ $m" -ForegroundColor Green }
function WARN($m) { Write-Host "! $m" -ForegroundColor Yellow }
function ERR($m)  { Write-Host "✘ $m" -ForegroundColor Red }
function STEP($n, $m) { Write-Host ""; Write-Host "[$n] $m" }
function DIE($m)  { ERR $m; Write-Host ""; Write-Host "请把这个窗口截图发给客服。"; exit 1 }
function ReadText($p) { if (Test-Path -LiteralPath $p) { [IO.File]::ReadAllText($p) } else { "" } }
function WriteText($p, $s) { $d = Split-Path -Parent $p; if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }; [IO.File]::WriteAllText($p, $s, $UTF8) }
function SysLog($m) { if ($TR) { Add-Content -LiteralPath (Join-Path $TR "sys.log") -Value $m -Encoding UTF8 } }
function Ask($m) { Read-Host $m }
function JsonRead($p) { $t = ReadText $p; if ($t.Trim()) { $t | ConvertFrom-Json } else { New-Object PSObject } }
function JsonWrite($p, $o) { WriteText $p ($o | ConvertTo-Json -Depth 100) }
function Has($o, $k) { $null -ne $o -and ($o.PSObject.Properties.Name -contains $k) }
function SetProp($o, $k, $v) { if (Has $o $k) { $o.$k = $v } else { $o | Add-Member -NotePropertyName $k -NotePropertyValue $v } }
function DelProp($o, $k) { if (Has $o $k) { $o.PSObject.Properties.Remove($k) } }

# ---- 系统级操作统一入口（沙箱里读写文件） ----
function TFile($n) { Join-Path $TR $n }
function TGet($n, $def) { $p = TFile $n; if (Test-Path -LiteralPath $p) { (ReadText $p).Trim() } else { $def } }
function Get-SysTz { if ($TR) { TGet "localtime" "" } else { (& tzutil /g).Trim() } }
function Set-SysTz($w) { SysLog "set timezone $w"; if ($TR) { WriteText (TFile "localtime") $w } else { & tzutil /s "$w" | Out-Null } }
function Get-TzAuto { if ($TR) { return (TGet "tzauto" "3") }
  try { [string](Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate" -ErrorAction Stop).Start } catch { "3" } }
function Set-TzAutoOff { SysLog "disable auto timezone"; if ($TR) { if (-not (Test-Path (TFile "tzauto_stuck"))) { WriteText (TFile "tzauto") "4" }; return }
  Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate" -Name Start -Value 4 -Type DWord
  Stop-Service tzautoupdate -ErrorAction SilentlyContinue }
function Get-LangFirst { if ($TR) { return ((ReadText (TFile "lang")) -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() }
  (Get-WinUserLanguageList)[0].LanguageTag }
function Get-Culture2 { if ($TR) { TGet "culture" "" } else { (Get-ItemProperty "HKCU:\Control Panel\International").LocaleName } }
function Get-Geo { if ($TR) { TGet "geo" "" } else { [string](Get-WinHomeLocation).GeoId } }
function Set-LangUS {
  SysLog "set language en-US"
  if ($TR) {
    $rest = (ReadText (TFile "lang")) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne "en-US" -and $_ -ne "en" }
    WriteText (TFile "lang") ((@("en-US") + $rest) -join "`n"); WriteText (TFile "culture") "en-US"; WriteText (TFile "geo") "244"; return
  }
  $old = Get-WinUserLanguageList
  $new = New-WinUserLanguageList "en-US"
  foreach ($l in $old) { if ($l.LanguageTag -ne "en-US" -and $l.LanguageTag -ne "en") { $new.Add($l) } }   # 原来的中文和输入法保留在后面
  Set-WinUserLanguageList $new -Force
  Set-WinUILanguageOverride -Language en-US
  Set-Culture en-US
  Set-WinHomeLocation -GeoId 244
}
$LOC_KEY = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location"
function Get-Loc { if ($TR) { TGet "location" "Allow" } else { try { (Get-ItemProperty $LOC_KEY -ErrorAction Stop).Value } catch { "Allow" } } }
function Set-LocDeny { SysLog "deny location"; if ($TR) { if (-not (Test-Path (TFile "location_stuck"))) { WriteText (TFile "location") "Deny" }; return }
  if (-not (Test-Path $LOC_KEY)) { New-Item -Path $LOC_KEY -Force | Out-Null }
  Set-ItemProperty $LOC_KEY -Name Value -Value "Deny" -Type String }
function Get-EnvVar($n, $scope) { if ($TR) { $o = JsonRead (TFile "env_$scope.json"); if (Has $o $n) { $o.$n } else { $null } } else { [Environment]::GetEnvironmentVariable($n, $scope) } }
function Set-EnvVar($n, $v, $scope) { SysLog "env $scope $n"; if ($TR) { $p = TFile "env_$scope.json"; $o = JsonRead $p; if ($null -eq $v) { DelProp $o $n } else { SetProp $o $n $v }; JsonWrite $p $o } else { [Environment]::SetEnvironmentVariable($n, $v, $scope) } }
function Get-VergeExe { foreach ($p in @("$env:ProgramFiles\Clash Verge\clash-verge.exe", "$env:LOCALAPPDATA\Programs\Clash Verge\clash-verge.exe", "$env:LOCALAPPDATA\Clash Verge\clash-verge.exe")) { if (Test-Path -LiteralPath $p) { return $p } }; $null }
function Get-VergeVersion { if ($TR) { return (TGet "verge_version" "") }; $e = Get-VergeExe; if ($e) { (Get-Item $e).VersionInfo.ProductVersion } else { "" } }
function Get-Running($name) { if ($TR) { return (((ReadText (TFile "procs")) -split "`n") -contains $name) }; [bool](Get-Process -Name $name -ErrorAction SilentlyContinue) }
function Stop-App($name) { SysLog "stop $name"; if ($TR) { $p = TFile "procs"; WriteText $p ((((ReadText $p) -split "`n") | Where-Object { $_ -and $_ -ne $name }) -join "`n"); return }; Stop-Process -Name $name -Force -ErrorAction SilentlyContinue }
function Start-Verge { SysLog "start Clash Verge"; if ($TR) { $null = THook "verge-start"; return }; $e = Get-VergeExe; if ($e) { Start-Process $e } }
function Disable-V6 { SysLog "disable ipv6"; if ($TR) { return }; Disable-NetAdapterBinding -Name "*" -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue }
function Open-Url($u) { SysLog "open $u"; if (-not $TR) { Start-Process $u } }

# Clash 控制接口：Windows 版 Clash Verge 走命名管道 \\.\pipe\verge-mihomo，原样发 HTTP 请求
$SECRET = ""
function Ctl($method, $path, $body) {
  if ($TR) {
    $a = @("-s", "-m", "10", "--unix-socket", (TFile "verge-mihomo.sock"), "-X", $method)
    if ($body) { $a += @("-d", $body) }
    return ((& $CURL @a "http://localhost$path") -join "`n")
  }
  # 管道名以 Clash Verge 写在配置里的为准（2.5 起每个用户不同：verge-mihomo-sidecar-release-…）；YAML 里可能带引号、双引号里反斜杠会转义
  $pipeName = "verge-mihomo"
  $m = [regex]::Match((ReadText $CV_CFG), '(?m)^external-controller-pipe:[ \t]*([^\r\n]+?)[ \t]*\r?$')
  if ($script:PIPE) { $pipeName = $script:PIPE }
  elseif ($m.Success) {
    $v = $m.Groups[1].Value
    if ($v.StartsWith('"')) { $v = $v.Trim('"').Replace('\\', '\') } elseif ($v.StartsWith("'")) { $v = $v.Trim("'") }
    $pm = [regex]::Match($v, '^\\\\\.\\pipe\\(.+)$'); if ($pm.Success) { $pipeName = $pm.Groups[1].Value }
  }
  try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(3000)
    $b = if ($body) { $UTF8.GetBytes($body) } else { [byte[]]@() }
    $hdr = "$method $path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $SECRET`r`nConnection: close`r`n"
    if ($body) { $hdr += "Content-Type: application/json`r`n" }
    $hdr += "Content-Length: $($b.Length)`r`n`r`n"
    $h = $UTF8.GetBytes($hdr); $pipe.Write($h, 0, $h.Length); if ($b.Length) { $pipe.Write($b, 0, $b.Length) }; $pipe.Flush()
    $ms = New-Object System.IO.MemoryStream; $buf = New-Object byte[] 65536
    # 读的时候设上限：对方不回话也不会卡死
    while ($true) { $t = $pipe.ReadAsync($buf, 0, $buf.Length); if (-not $t.Wait(10000)) { break }; $n = $t.Result; if ($n -le 0) { break }; $ms.Write($buf, 0, $n) }
    $pipe.Dispose()
    $raw = $ms.ToArray(); $sep = -1
    for ($i = 0; $i -lt $raw.Length - 3; $i++) { if ($raw[$i] -eq 13 -and $raw[$i+1] -eq 10 -and $raw[$i+2] -eq 13 -and $raw[$i+3] -eq 10) { $sep = $i; break } }
    if ($sep -lt 0) { return "" }
    $head = [Text.Encoding]::ASCII.GetString($raw, 0, $sep); $pos = $sep + 4
    if ($head -notmatch "(?i)transfer-encoding:\s*chunked") { return $UTF8.GetString($raw, $pos, $raw.Length - $pos) }
    # 解开 chunked：长度按字节算（中文分组名是多字节），所以在字节上切
    $bodyMs = New-Object System.IO.MemoryStream
    while ($pos -lt $raw.Length) {
      $eol = $pos; while ($eol -lt $raw.Length - 1 -and -not ($raw[$eol] -eq 13 -and $raw[$eol+1] -eq 10)) { $eol++ }
      $len = [Convert]::ToInt32(([Text.Encoding]::ASCII.GetString($raw, $pos, $eol - $pos).Split(";")[0].Trim()), 16)
      if ($len -eq 0) { break }
      $bodyMs.Write($raw, $eol + 2, $len); $pos = $eol + 2 + $len + 2
    }
    return $UTF8.GetString($bodyMs.ToArray())
  } catch { return "" }
}
$script:PIPE = ""
# 服务模式下内核由 Clash Verge 的服务启动，控制管道是 verge-mihomo-production-<当前用户 SID 的 SHA-256>（2.5.8 的 mihomo_ipc_path）
function Service-PipeName {
  try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $h = [Security.Cryptography.SHA256]::Create().ComputeHash($UTF8.GetBytes($sid))
    "verge-mihomo-production-" + (-join ($h | ForEach-Object { $_.ToString("x2") }))
  } catch { "" }
}
function Find-Ctl {
  $m = [regex]::Match((ReadText $CV_CFG), '(?m)^secret:\s*[''"]?([^''"\r\n]*)')
  $script:SECRET = if ($m.Success) { $m.Groups[1].Value.Trim() } else { "" }
  $script:PIPE = ""
  if ($TR) { return ((Ctl "GET" "/version" $null) -match "version") }
  # 先试服务模式的管道（只试已经存在的，免得每个都等超时），再试配置里写的（普通模式）
  $have = @(); try { $have = @([IO.Directory]::GetFiles("\\.\pipe\") | ForEach-Object { $_ -replace '^.*\\', '' }) } catch {}
  $svcPipe = Service-PipeName
  if ($svcPipe -and (-not $have.Count -or $have -contains $svcPipe)) { $script:PIPE = $svcPipe; if ((Ctl "GET" "/version" $null) -match "version") { return $true } }
  $script:PIPE = ""
  return ((Ctl "GET" "/version" $null) -match "version")
}
function JParse($s) { try { $s | ConvertFrom-Json } catch { $null } }
function TraceIp($s) { $m = [regex]::Match([string]$s, '(?m)^ip=(\S+)'); if ($m.Success) { $m.Groups[1].Value } else { "" } }
function CurlX() { (& $CURL @args 2>$null) -join "`n" }
# 不经过任何代理设置直接请求：只有 TUN 接管了系统流量，才会从专属 IP 出去
function DTrace($u) { $saved = @{}; foreach ($n in "HTTP_PROXY","HTTPS_PROXY","ALL_PROXY") { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $null) }
  try { CurlX -s -m 15 --noproxy "*" $u } finally { foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } } }
function Env-IsBad($name, $val) {
  if ($name -eq "NO_PROXY") { return ($val -match "(?i)claude|anthropic") }
  if ($name -match "^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|CLAUDE_CODE_HTTP_PROXY|CLAUDE_CODE_HTTPS_PROXY|CLAUDE_CODE_PROXY_URL)$") {
    return -not ($val -match "^(https?|socks5h?)://(127\.0\.0\.1|localhost):$MIXED_PORT/?$") }
  return $true
}
function JsArr($s) { '[' + ((($s -split " ") | ForEach-Object { '"' + $_ + '"' }) -join ",") + ']' }

# ===== 迁移：没装 Clash Verge Rev → 自动安装 + 搬订阅 + 关旧软件 =====
function THook { if ($TR -and $env:CE_TEST_HOOK) { & $env:CE_PYTHON $env:CE_TEST_HOOK @args | Out-Null; return ($LASTEXITCODE -eq 0) }; $true }
# ===== 虚拟网卡（TUN）要用 Clash Verge 的「服务模式」：没装就用 Clash Verge 自带的安装程序装上 =====
# 和 Clash Verge 2.5.8 设置里点「安装服务模式」完全一样：安装目录 resources\clash-verge-service-install.exe --prepare-install，
# 带上自带的两个内核；脚本本来就是管理员身份，所以不会再弹「是否允许更改」。服务名 clash_verge_service（开机自动启动）。
$SVC_NAME = "clash_verge_service"
$SVC_MIN = [version]"2.5.8"   # 自动安装只用在我们验证过的版本上
$script:SVC_LOG = ""
function Get-SvcState { if ($TR) { return (TGet "service" "none") }
  $s = Get-Service -Name $SVC_NAME -ErrorAction SilentlyContinue
  if (-not $s) { "none" } elseif ($s.Status -eq "Running") { "running" } else { "stopped" } }
function Install-VergeService {
  SysLog "install clash verge service"
  if ($TR) { return (THook "service-install") }
  $e = Get-VergeExe; if (-not $e) { return $false }
  $dir = Split-Path -Parent $e
  $inst = Join-Path $dir "resources\clash-verge-service-install.exe"
  if (-not (Test-Path -LiteralPath $inst) -or -not (Test-Path -LiteralPath (Join-Path $dir "resources\clash-verge-service.exe"))) { return $false }
  $argv = '--prepare-install --ensure --prompt "Clash Verge"'
  $n = 0; foreach ($c in "verge-mihomo.exe", "verge-mihomo-alpha.exe") { $p = Join-Path $dir $c; if (Test-Path -LiteralPath $p) { $argv += " --core $c `"$p`""; $n++ } }
  if (-not $n) { return $false }
  $bk = Join-Path $UH ".claude-env-backup"; New-Item -ItemType Directory -Force -Path $bk | Out-Null
  $script:SVC_LOG = Join-Path $bk "service-install-$TS.log"
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $inst; $psi.Arguments = $argv; $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.WorkingDirectory = $dir
    $pr = [Diagnostics.Process]::Start($psi)
    $o = $pr.StandardOutput.ReadToEndAsync(); $er = $pr.StandardError.ReadToEndAsync()
    if (-not $pr.WaitForExit(180000)) { try { $pr.Kill() } catch {}; WriteText $script:SVC_LOG "timeout"; return $false }
    WriteText $script:SVC_LOG ("exit " + $pr.ExitCode + "`n" + $o.Result + "`n" + $er.Result)
    if ($pr.ExitCode -ne 0) { return $false }
  } catch { WriteText $script:SVC_LOG ([string]$_); return $false }
  for ($i = 0; $i -lt 15; $i++) { if ((Get-SvcState) -eq "running") { return $true }; Start-Sleep -Seconds 1 }
  $false
}
function Ensure-Service {
  if ((Get-SvcState) -eq "running") { OK "Clash Verge 服务模式已在运行（虚拟网卡要用它）"; return $true }
  $vv = Get-VergeVersion; $okv = $false; try { $okv = [version]($vv -replace '[^0-9.].*$','') -ge $SVC_MIN } catch {}
  if (-not $okv) { WARN ("Clash Verge " + $(if ($vv) { $vv } else { "版本未知" }) + " 不能自动安装「服务模式」（需要 $SVC_MIN 及以上），先不开虚拟网卡（TUN），网络照常可用"); return $false }
  Write-Host "  正在安装 Clash Verge 的「服务模式」（虚拟网卡要用它；和在 Clash Verge 设置里点「安装服务模式」一样，大约半分钟）…"
  if (Install-VergeService) { OK "Clash Verge 服务模式已安装并在运行"; return $true }
  WARN ("Clash Verge 服务模式没装上，先不开虚拟网卡（TUN），网络照常可用" + $(if ($script:SVC_LOG) { "（安装记录：$($script:SVC_LOG)）" } else { "" }))
  $false
}
function Test-VergeInstalled { if ($TR) { return ((Test-Path -LiteralPath $CV_CFG) -or (Test-Path -LiteralPath (TFile "verge_installed"))) }; [bool](Get-VergeExe) -or (Test-Path -LiteralPath $CV_CFG) }
# 订阅链接只显示到域名，后面的路径和参数（含令牌）一律打码
function MaskUrl($u) { $m = [regex]::Match([string]$u, '^(https?://)(?:[^@/?#]*@)?([^/?#]+)'); if ($m.Success) { $m.Groups[1].Value + $m.Groups[2].Value + "/***" } else { "***" } }
function YUnq($s) {
  $s = ([string]$s).Trim()
  if ($s.Length -ge 2 -and $s.StartsWith("'") -and $s.EndsWith("'")) { return $s.Substring(1, $s.Length - 2).Replace("''", "'") }
  if ($s.Length -ge 2 -and $s.StartsWith('"') -and $s.EndsWith('"')) { return $s.Substring(1, $s.Length - 2) }
  [regex]::Replace($s, '\s+#.*$', '')
}
# 读 YAML 列表（items: / files:）：每项取同一层的简单字段；顶层的简单字段（current / index）放在 top 里
function YamlList($text, $listKey) {
  $items = New-Object System.Collections.ArrayList; $top = @{}; $cur = $null; $ind = -1; $inList = $false; $pend = $false; $lastK = ""
  foreach ($line in ([string]$text -split "`r?`n")) {
    if ($line -match '^\s*(#|$)') { continue }
    $t = [regex]::Match($line, '^([A-Za-z_][\w-]*):(.*)$')
    if ($t.Success) {
      if ($cur) { [void]$items.Add($cur); $cur = $null }
      $k = $t.Groups[1].Value; $v = YUnq $t.Groups[2].Value
      $inList = ($k -eq $listKey); $lastK = $k; $pend = ($v -eq "")
      if (-not $inList -and $v -ne "") { $top[$k] = $v }
      continue
    }
    if (-not $inList) { $d = [regex]::Match($line, '^\s*-\s+(.*)$'); if ($pend -and $d.Success) { $top[$lastK] = YUnq $d.Groups[1].Value; $pend = $false }; continue }
    $d = [regex]::Match($line, '^( *)-\s+(.*)$')
    if ($d.Success -and ($ind -lt 0 -or $d.Groups[1].Value.Length -eq $ind)) {
      if ($ind -lt 0) { $ind = $d.Groups[1].Value.Length }
      if ($cur) { [void]$items.Add($cur) }
      $cur = @{}; $kv = [regex]::Match($d.Groups[2].Value, '^([\w-]+):(.*)$'); if ($kv.Success) { $cur[$kv.Groups[1].Value] = YUnq $kv.Groups[2].Value }
      continue
    }
    $kv = [regex]::Match($line, '^( *)([\w-]+):(.*)$')
    if ($cur -and $kv.Success -and $kv.Groups[1].Value.Length -eq $ind + 2) { $cur[$kv.Groups[2].Value] = YUnq $kv.Groups[3].Value }
  }
  if ($cur) { [void]$items.Add($cur) }
  @{ items = $items; top = $top }
}
# 只读查询 SQLite：先复制到临时目录再读，原文件不动。返回每行一个字符串，列之间用 Tab 分隔
function SqlRows($db, $sql) {
  if (-not (Test-Path -LiteralPath $db)) { return @() }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ce-db-" + [guid]::NewGuid().ToString("N"))
  try {
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $f = Join-Path $tmp "db.sqlite"; Copy-Item -LiteralPath $db $f -ErrorAction Stop
    foreach ($x in "-wal", "-shm") { if (Test-Path -LiteralPath "$db$x") { Copy-Item -LiteralPath "$db$x" "$f$x" -ErrorAction SilentlyContinue } }
    if ($env:CE_SQLITE) { return @(& $env:CE_SQLITE -separator "`t" $f $sql 2>$null) }
    if (-not ("CeSql" -as [type])) {
      Add-Type -ErrorAction Stop -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class CeSql {
  const string D = "winsqlite3.dll";
  [DllImport(D, EntryPoint="sqlite3_open_v2", CallingConvention=CallingConvention.StdCall)] static extern int Open(byte[] f, out IntPtr db, int flags, IntPtr vfs);
  [DllImport(D, EntryPoint="sqlite3_prepare_v2", CallingConvention=CallingConvention.StdCall)] static extern int Prepare(IntPtr db, byte[] sql, int n, out IntPtr st, IntPtr tail);
  [DllImport(D, EntryPoint="sqlite3_step", CallingConvention=CallingConvention.StdCall)] static extern int Step(IntPtr st);
  [DllImport(D, EntryPoint="sqlite3_column_count", CallingConvention=CallingConvention.StdCall)] static extern int Cols(IntPtr st);
  [DllImport(D, EntryPoint="sqlite3_column_text", CallingConvention=CallingConvention.StdCall)] static extern IntPtr Text(IntPtr st, int i);
  [DllImport(D, EntryPoint="sqlite3_column_bytes", CallingConvention=CallingConvention.StdCall)] static extern int Bytes(IntPtr st, int i);
  [DllImport(D, EntryPoint="sqlite3_finalize", CallingConvention=CallingConvention.StdCall)] static extern int Fin(IntPtr st);
  [DllImport(D, EntryPoint="sqlite3_close", CallingConvention=CallingConvention.StdCall)] static extern int Close(IntPtr db);
  static byte[] Z(string s) { return Encoding.UTF8.GetBytes(s + "\0"); }
  public static string[] Query(string path, string sql) {
    var rows = new List<string>(); IntPtr db, st;
    if (Open(Z(path), out db, 2, IntPtr.Zero) != 0) { Close(db); return rows.ToArray(); }
    try {
      if (Prepare(db, Z(sql), -1, out st, IntPtr.Zero) != 0) return rows.ToArray();
      try {
        while (Step(st) == 100) {
          int n = Cols(st); var cells = new string[n];
          for (int i = 0; i < n; i++) { IntPtr p = Text(st, i); int b = Bytes(st, i); var buf = new byte[b > 0 ? b : 0]; if (p != IntPtr.Zero && b > 0) Marshal.Copy(p, buf, 0, b); cells[i] = Encoding.UTF8.GetString(buf).Replace("\t", " ").Replace("\r", " ").Replace("\n", " "); }
          rows.Add(string.Join("\t", cells));
        }
      } finally { Fin(st); }
    } finally { Close(db); }
    return rows.ToArray();
  }
}
'@
    }
    return @([CeSql]::Query($f, $sql))
  } catch { return @() } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---- 从其他代理软件的本地配置里找订阅（只读）----
$script:SUBS = New-Object System.Collections.ArrayList
function AddSub($client, $url, $isCur) {
  $u = ([string]$url).Trim()
  if ($u -notmatch '^https?://\S+$') { return }
  foreach ($x in $script:SUBS) { if ($x.Url -eq $u) { return } }
  $run = $false; foreach ($c in $OTHER_CLIENTS) { if ($c[0] -eq $client -and (Get-Running $c[1])) { $run = $true } }
  $rank = $(if ($run) { 0 } else { 2 }) + $(if ($isCur) { 0 } else { 1 })
  [void]$script:SUBS.Add([pscustomobject]@{ Client = $client; Url = $u; Current = [bool]$isCur; Rank = $rank; Idx = $script:SUBS.Count })
}
function Read-FlClash {
  # FlClash：%APPDATA%\com.follow\clash。新版订阅在 database.sqlite 的 profiles 表，旧版在 shared_preferences.json 的 config 里；
  # 正在用的是 config 里的 currentProfileId
  $d = Join-Path $env:APPDATA "com.follow\clash"
  $cfg = ""; $sp = JParse (ReadText (Join-Path $d "shared_preferences.json")); if ($sp -and (Has $sp "flutter.config")) { $cfg = [string]$sp.'flutter.config' }
  $curId = [regex]::Match($cfg, '"currentProfileId"\s*:\s*"?([^",}\s]+)').Groups[1].Value
  $cj = JParse $cfg
  if ($cj -and (Has $cj "profiles")) { foreach ($p in @($cj.profiles)) { if ($p.url) { AddSub "FlClash" $p.url ($curId -and [string]$p.id -eq $curId) } } }
  $db = Join-Path $d "database.sqlite"
  $rows = @(SqlRows $db "SELECT id, url FROM profiles WHERE type = 'url' ORDER BY ""order""")
  if (-not $rows.Count) { $rows = @(SqlRows $db "SELECT id, url FROM profiles WHERE type = 'url'") }
  foreach ($r in $rows) { $c = ([string]$r) -split "`t"; if ($c.Count -ge 2) { AddSub "FlClash" $c[1] ($curId -and $c[0] -eq $curId) } }
}
function Read-YamlClient($client, $path, $listKey, $curKey) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $y = YamlList (ReadText $path) $listKey; $cur = [string]$y.top[$curKey]; $i = 0
  foreach ($it in $y.items) {
    $id = if ($it.ContainsKey("uid")) { $it["uid"] } else { $it["id"] }
    $isCur = if ($curKey -eq "index") { $cur -ne "" -and [string]$i -eq $cur } else { $cur -ne "" -and $id -eq $cur }
    if ($it["url"] -and ((-not $it.ContainsKey("type")) -or $it["type"] -eq "remote")) { AddSub $client $it["url"] $isCur }
    $i++
  }
}
function Read-V2rayN {
  $dirs = @(); foreach ($p in @(Get-Process -Name v2rayN -ErrorAction SilentlyContinue)) { try { if ($p.Path) { $dirs += (Split-Path -Parent $p.Path) } } catch {} }
  if ($TR) { $dirs = @() }
  $dirs += @((Join-Path $env:LOCALAPPDATA "v2rayN"), (Join-Path $UH "v2rayN"))
  foreach ($b in @("Desktop", "Downloads", "Documents")) { $bd = Join-Path $UH $b; if (Test-Path -LiteralPath $bd) { $dirs += @(Get-ChildItem -LiteralPath $bd -Filter "guiConfigs" -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object { Split-Path -Parent $_.FullName }) } }
  foreach ($d in ($dirs | Select-Object -Unique)) {
    $g = Join-Path $d "guiConfigs"; if (-not (Test-Path -LiteralPath $g)) { continue }
    $conf = JParse (ReadText (Join-Path $g "guiNConfig.json")); $curId = if ($conf -and (Has $conf "SubIndexId")) { [string]$conf.SubIndexId } else { "" }
    foreach ($r in @(SqlRows (Join-Path $g "guiNDB.db") "SELECT Id, Url FROM SubItem WHERE Enabled = 1 ORDER BY Sort")) { $c = ([string]$r) -split "`t"; if ($c.Count -ge 2) { AddSub "v2rayN" $c[1] ($curId -and $c[0] -eq $curId) } }
    if ($conf -and (Has $conf "subItem")) { foreach ($s in @($conf.subItem)) { if ($s.enabled -ne $false) { AddSub "v2rayN" $s.url ($curId -and [string]$s.id -eq $curId) } } }
  }
}
function Find-Subs {
  Read-FlClash
  Read-YamlClient "Clash for Windows" (Join-Path $UH ".config\clash\profiles\list.yml") "files" "index"
  Read-YamlClient "Clash Party" (Join-Path $env:APPDATA "mihomo-party\profile.yaml") "items" "current"
  foreach ($p in @((Join-Path $UH ".config\clash-nyanpasu\profiles.yaml"), (Join-Path $env:APPDATA "clash-nyanpasu\profiles.yaml"), (Join-Path $env:LOCALAPPDATA "clash-nyanpasu\profiles.yaml"))) { Read-YamlClient "Clash Nyanpasu" $p "items" "current" }
  Read-V2rayN
  @($script:SUBS | Sort-Object Rank, Idx)
}

# 原来的代理软件开着的本机端口：优先看系统代理设置，再试常见端口。下载订阅和安装包时先走它（国内直连 GitHub 常常很慢）
function Get-WinProxy { if ($TR) { return (JsonRead (TFile "winproxy.json")) }; Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue }
function Find-OldProxy {
  $ports = @(); $wp = Get-WinProxy
  if ($wp -and $wp.ProxyEnable -eq 1) { $m = [regex]::Match([string]$wp.ProxyServer, '(?:^|[=;])(?:127\.0\.0\.1|localhost):(\d+)'); if ($m.Success) { $ports += [int]$m.Groups[1].Value } }
  $ports += 7890, 7891, 10809, 7897, 1080
  foreach ($p in ($ports | Select-Object -Unique)) { $null = CurlX -s -m 5 -o NUL -x "http://127.0.0.1:$p" "https://www.google.com/generate_204"; if ($LASTEXITCODE -eq 0) { return "http://127.0.0.1:$p" } }
  ""
}
function Routes { $r = @(); if ($script:OLDPX) { $r += $script:OLDPX }; $r += "direct"; $r }
# 用 Clash Verge 的身份下载订阅（机场按这个返回 Clash 格式）；链接写进临时的 curl 配置文件交给 curl，不出现在命令行里
function Fetch-Sub($url) {
  $tmp = [IO.Path]::GetTempFileName(); $kf = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($kf, 'url = "' + $url.Replace('\', '\\').Replace('"', '\"') + '"' + "`n", $UTF8)
    foreach ($r in (Routes)) {
      $a = @("-s", "-L", "-m", "30", "-A", $VERGE_UA, "-o", $tmp, "-w", "%{http_code}", "-K", $kf)
      if ($r -eq "direct") { $a += @("--noproxy", "*") } else { $a += @("-x", $r) }
      $code = & $CURL @a 2>$null
      if ($LASTEXITCODE -eq 0 -and ([string]$code) -match '^2') {
        $t = ([IO.File]::ReadAllText($tmp, $UTF8)).TrimStart([char]0xFEFF)
        if ($t -match '(?m)^(proxies|proxy-providers):') { return $t }
      }
    }
    ""
  } finally { Remove-Item -LiteralPath $tmp, $kf -Force -ErrorAction SilentlyContinue }
}
function Manual-Fallback($why) {
  ERR $why
  $others = @(); foreach ($c in $OTHER_CLIENTS) { if (Get-Running $c[1]) { $others += $c[0] } }
  if ($others.Count) { Write-Host ("  检测到你在用：" + ($others -join "、") + "。需要换成 Clash Verge Rev（免费开源），请按下面手动装一下：") }
  Write-Host "  1. 已为你打开下载页：下载 x64-setup.exe（ARM 电脑选 arm64），装好打开"
  Write-Host "  2. 在 Clash Verge Rev「订阅」里粘贴你的订阅链接（机场官网或原来软件的订阅设置里能找到），选中它"
  Write-Host "  3. 退出原来的代理软件，确认能打开 google.com 后，重新运行本命令"
  Open-Url "https://github.com/clash-verge-rev/clash-verge-rev/releases/latest"
  exit 3
}
function Install-Verge {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $a = if ($arch -eq "ARM64") { $VERGE_ARM64 } else { $VERGE_X64 }
  Write-Host "  正在下载 Clash Verge Rev $VERGE_VER（约 60MB，来自官方 GitHub；网络慢的话要几分钟，请稍等）…"
  if ($TR) { SysLog "download $($a[0])"; if (-not (THook "download")) { return $false }; SysLog "install $($a[0]) /S"; return (THook "install") }
  $f = Join-Path $env:TEMP $a[0]; $ok = $false
  foreach ($r in @((Routes) + (Routes))) {   # 每条路各试两轮（GitHub 偶尔会临时出错）
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    $x = if ($r -eq "direct") { @("--noproxy", "*") } else { @("-x", $r) }
    $null = CurlX -f -s -S -L --retry 2 -m 900 @x -o $f ($VERGE_URL + $a[0])
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $f) -and (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() -eq $a[1]) { $ok = $true; break }
    Start-Sleep -Seconds 3
  }
  if (-not $ok) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; return $false }
  OK "下载完成，文件校验通过（SHA-256 与官方发布一致）"
  Write-Host "  正在安装（不用点任何按钮，大约半分钟）…"
  # 只等安装程序本身（-Wait 会连它拉起的子进程一起等）
  $ip = Start-Process -FilePath $f -ArgumentList "/S" -PassThru
  if (-not $ip.WaitForExit(600000)) { try { $ip.Kill() } catch {} }
  Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  [bool](Get-VergeExe)
}
function Stop-VergeAll { Stop-App "clash-verge"; if (-not $TR) { foreach ($n in "verge-mihomo", "verge-mihomo-alpha") { Stop-Process -Name $n -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Seconds 3 }
function Wait-Ctl($secs) { $sw = [Diagnostics.Stopwatch]::StartNew(); while ($sw.Elapsed.TotalSeconds -lt $secs) { if ((Test-Path -LiteralPath $CV_CFG) -and (Find-Ctl)) { return $true }; Start-Sleep -Seconds 2 }; $false }
# 关掉原来的代理软件：先正常关窗口，再结束进程（连同它的内核）
function Quit-Old($c) {
  if ($TR) { SysLog "quit $($c[0])"; Stop-App $c[1]; return }
  foreach ($p in @(Get-Process -Name $c[1] -ErrorAction SilentlyContinue)) { try { [void]$p.CloseMainWindow() } catch {} }
  Start-Sleep -Seconds 3
  Stop-Process -Name $c[1] -Force -ErrorAction SilentlyContinue
  foreach ($n in ($c[2] -split " ")) { if ($n) { Stop-Process -Name $n -Force -ErrorAction SilentlyContinue } }
}
# 系统代理还指向本机别的端口（原来的软件），就关掉，不然它退出后浏览器上不了网
function Reset-WinProxy($keepPort) {
  $wp = Get-WinProxy
  if (-not ($wp -and $wp.ProxyEnable -eq 1)) { return "" }
  $m = [regex]::Match([string]$wp.ProxyServer, '(?:^|[=;])(?:127\.0\.0\.1|localhost):(\d+)')
  if (-not $m.Success -or [int]$m.Groups[1].Value -eq [int]$keepPort) { return "" }
  SysLog "disable system proxy $($wp.ProxyServer)"
  if ($TR) { $p = TFile "winproxy.json"; $o = JsonRead $p; SetProp $o "ProxyEnable" 0; JsonWrite $p $o; return [string]$wp.ProxyServer }
  Set-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 0 -Type DWord
  try {
    if (-not ("CeNet.WinInet" -as [type])) { Add-Type -Namespace CeNet -Name WinInet -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);' }
    [void][CeNet.WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0); [void][CeNet.WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
  } catch {}
  [string]$wp.ProxyServer
}
function New-Uid($p) { $cs = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".ToCharArray(); $p + (-join (1..11 | ForEach-Object { $cs[(Get-Random -Maximum 62)] })) }
function YQ($s) { "'" + ([string]$s).Replace("'", "''") + "'" }
function Has-CurrentProfile { $y = YamlList (ReadText (Join-Path $CV_DIR "profiles.yaml")) "items"; $c = [string]$y.top["current"]; $c -and $c -ne "null" -and $c -ne "~" }
# 按 Clash Verge 自己导入订阅的方式写入：订阅文件 + 它配套的 5 个增强项，加进 profiles.yaml 并设为当前订阅
function Import-Sub($url, $content, $name) {
  $pd = Join-Path $CV_DIR "profiles"; New-Item -ItemType Directory -Force -Path $pd | Out-Null
  $uid = New-Uid "R"; $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $sub = [ordered]@{ merge = (New-Uid "m"); script = (New-Uid "s"); rules = (New-Uid "r"); proxies = (New-Uid "p"); groups = (New-Uid "g") }
  WriteText (Join-Path $pd "$uid.yaml") $content
  WriteText (Join-Path $pd "$($sub.merge).yaml") "# Profile Enhancement Merge Template for Clash Verge`n`n"
  WriteText (Join-Path $pd "$($sub.script).js") "// Define main function (script entry)`n`nfunction main(config, profileName) {`n  return config;`n}`n"
  foreach ($k in "rules", "proxies", "groups") { $T = $k.Substring(0,1).ToUpper() + $k.Substring(1); WriteText (Join-Path $pd "$($sub[$k]).yaml") "# Profile Enhancement $T Template for Clash Verge`n`nprepend: []`n`nappend: []`n`ndelete: []`n" }
  $e = @("- uid: $uid", "  type: remote", "  name: $(YQ $name)", "  file: $uid.yaml", "  url: $(YQ $url)", "  updated: $now", "  option:", "    update_interval: 1440", "    allow_auto_update: true")
  foreach ($k in $sub.Keys) { $e += "    ${k}: $($sub[$k])" }
  foreach ($k in $sub.Keys) { $ext = if ($k -eq "script") { "js" } else { "yaml" }; $e += @("- uid: $($sub[$k])", "  type: $k", "  file: $($sub[$k]).$ext", "  updated: $now") }
  $pf = Join-Path $CV_DIR "profiles.yaml"; $old = ReadText $pf
  if ($old) { Copy-Item -LiteralPath $pf "$pf.backup-claude-env-$TS" }
  # 全局的 Merge / Script 两项：Clash Verge 第一次启动时 profiles.yaml 还是空的就不会补上，没有它们全局扩展脚本（Script.js）不生效
  foreach ($g in @(@("Merge", "merge", "Merge.yaml", "# Profile Enhancement Merge Template for Clash Verge`n`nprofile:`n  store-selected: true`n"), @("Script", "script", "Script.js", "// Define main function (script entry)`n`nfunction main(config, profileName) {`n  return config;`n}`n"))) {
    if ($old -notmatch ("(?m)^\s*- uid: " + $g[0] + "\s*$")) {
      $e += @("- uid: $($g[0])", "  type: $($g[1])", "  file: $($g[2])", "  updated: $now")
      if (-not (Test-Path -LiteralPath (Join-Path $pd $g[2]))) { WriteText (Join-Path $pd $g[2]) $g[3] }
    }
  }
  $out = New-Object System.Collections.ArrayList; $inItems = $false; $done = $false; $pre = $null; $hasCur = $false; $skipCur = $false
  foreach ($l in ($old -split "`r?`n")) {
    if ($inItems -and -not $done -and $l -match '^[^\s#-]') { foreach ($x in $e) { [void]$out.Add("$pre$x") }; $done = $true; $inItems = $false }
    if ($l -match '^current:') { [void]$out.Add("current: $uid"); $hasCur = $true; $skipCur = $true; continue }
    if ($skipCur -and $l -match '^- ') { continue }; $skipCur = $false
    if ($l -match '^items:') { [void]$out.Add("items:"); $inItems = $true; continue }
    if ($inItems -and $null -eq $pre) { $pm = [regex]::Match($l, '^( *)- '); if ($pm.Success) { $pre = $pm.Groups[1].Value } }
    [void]$out.Add($l)
  }
  while ($out.Count -and -not $out[$out.Count - 1].Trim()) { $out.RemoveAt($out.Count - 1) }
  if (-not $done) { if (-not $inItems) { [void]$out.Add("items:") }; foreach ($x in $e) { [void]$out.Add("$pre$x") } }
  if (-not $hasCur) { [void]$out.Add("current: $uid") }
  WriteText $pf (($out -join "`n") + "`n")
  $uid
}
# 订阅里的节点名（proxies: 下面每项的 name）
function Sub-Names($content) {
  $pb = [regex]::Match([string]$content, '(?ms)^proxies:[ \t]*\r?\n(.*?)(?=^[^\s-]|\z)'); if (-not $pb.Success) { return @() }
  @([regex]::Matches($pb.Groups[1].Value, '(?m)^\s*-\s*\{?\s*name:\s*(?:"([^"]*)"|''([^'']*)''|([^,}\r\n]*))') | ForEach-Object { ($_.Groups[1].Value + $_.Groups[2].Value + $_.Groups[3].Value).Trim() } | Where-Object { $_ })
}
# Clash Verge 内核里实际加载到的、订阅里的节点数
function Count-Nodes($names) {
  $j = JParse (Ctl "GET" "/proxies" $null); if (-not ($j -and (Has $j "proxies"))) { return 0 }
  $have = @($j.proxies.PSObject.Properties | ForEach-Object { $_.Name })
  if (@($names).Count) { return @($names | Where-Object { $have -contains $_ }).Count }
  @($j.proxies.PSObject.Properties | Where-Object { [string]$_.Value.type -notmatch '^(Direct|Reject|RejectDrop|Compatible|Pass|Selector|URLTest|Fallback|LoadBalance|Relay|Dns)$' }).Count
}
function Migrate($needInstall) {
  if ($needInstall) {
    WARN "这台电脑还没装 Clash Verge Rev（这套设置要用它）。接下来自动帮你："
    Write-Host "  ① 从官方下载并安装 Clash Verge Rev  ② 把你原来代理软件里的订阅搬进去  ③ 关掉原来的代理软件（只是退出，不卸载）"
  } else {
    WARN "Clash Verge Rev 里还没有订阅。接下来把你原来代理软件里的订阅导进去，再关掉原来的代理软件（只是退出，不卸载）"
  }
  $script:OLDPX = Find-OldProxy
  if ($script:OLDPX) { OK "原来的代理软件能用（本机端口 $(([uri]$script:OLDPX).Port)），下载时先借它的网络" }
  $subs = @(Find-Subs); $content = ""; $chosen = $null
  if (-not $subs.Count) { WARN "没在电脑上的代理软件里找到订阅" }
  foreach ($s in ($subs | Select-Object -First 6)) {
    Write-Host ("  找到 " + $s.Client + " 的订阅：" + (MaskUrl $s.Url) + $(if ($s.Current) { "（正在使用）" } else { "" }) + "，正在下载…")
    $content = Fetch-Sub $s.Url
    if ($content) { $chosen = $s; break }
    WARN "这个订阅下载不下来，或者不是 Clash 格式，换下一个"
  }
  for ($try = 0; -not $chosen -and $try -lt 3; $try++) {
    $u = ""; try { $u = ([string](Ask "请粘贴你的订阅链接（http 开头，在机场官网或原来软件的订阅设置里复制），回车")).Trim() } catch {}
    if (-not $u) { break }
    if ($u -notmatch '^https?://\S+$') { WARN "这不像订阅链接（应该以 http:// 或 https:// 开头），请再试一次"; continue }
    Write-Host ("  正在下载订阅 " + (MaskUrl $u) + " …")
    $content = Fetch-Sub $u
    if ($content) { $chosen = [pscustomobject]@{ Client = "手动粘贴"; Url = $u } } else { WARN "这个链接下载不到 Clash 格式的订阅。请在机场官网找「Clash」订阅链接再粘贴" }
  }
  if (-not $chosen) { Manual-Fallback "没拿到能用的订阅，没法自动配置。" }
  $names = @(Sub-Names $content); $nn = $names.Count
  OK ("订阅下载成功：" + (MaskUrl $chosen.Url) + $(if ($nn) { "（约 $nn 个节点）" } else { "" }))
  if ($needInstall) {
    if (-not (Install-Verge)) { Manual-Fallback "自动下载或安装 Clash Verge Rev 没成功（多半是网络问题）。" }
    OK "Clash Verge Rev $VERGE_VER 已安装"
    Write-Host "  正在第一次打开 Clash Verge Rev…"
    Start-Verge
    if (-not (Wait-Ctl 90)) { DIE "Clash Verge Rev 装好了，但第一次打开没成功。请手动打开一次 Clash Verge Rev，再重新运行本命令。" }
  }
  Stop-VergeAll
  $host0 = ([uri]$chosen.Url).Host
  $null = Import-Sub $chosen.Url $content $host0
  OK "订阅已导入 Clash Verge Rev，并设为当前使用的订阅"
  $runOld = @(); foreach ($c in $OTHER_CLIENTS) { if (Get-Running $c[1]) { $runOld += ,$c } }
  if ($runOld.Count) {
    Write-Host ("  正在关闭原来的代理软件：" + (($runOld | ForEach-Object { $_[0] }) -join "、") + "（两个代理软件同时开会抢网络；以后只用 Clash Verge Rev）")
    foreach ($c in $runOld) { Quit-Old $c }
    OK "原来的代理软件已关闭（没有卸载，想用时还能打开，但别和 Clash Verge Rev 同时开）"
  }
  $vp = [regex]::Match((ReadText $CV_CFG), '(?m)^mixed-port:\s*(\d+)'); $vport = if ($vp.Success) { [int]$vp.Groups[1].Value } else { 7897 }
  $was = Reset-WinProxy $vport
  if ($was) { OK "已关掉原来软件留下的系统代理（$was）" }
  Write-Host "  正在打开 Clash Verge Rev 并加载订阅…"
  Start-Verge
  # 刚关掉的 Clash Verge 偶尔还没完全退出，这次打开会落空：再打开一次
  if (-not (Wait-Ctl 60)) { Start-Verge; if (-not (Wait-Ctl 60)) { DIE "Clash Verge Rev 打开后连不上控制接口。" } }
  $n = 0; for ($i = 0; $i -lt 15; $i++) { $n = Count-Nodes $names; if ($n -gt 0) { break }; Start-Sleep -Seconds 2 }
  if ($n -le 0) { DIE "订阅导入后 Clash Verge Rev 里没有读到节点。请打开 Clash Verge Rev「订阅」页看一下是否有报错，截图发给客服。" }
  OK "Clash Verge Rev 已读到订阅里的 $n 个节点"
}

Write-Host ""; Write-Host "Claude 稳定使用环境 · 一键部署（Windows）"

# ===== 1. 前提检查 =====
STEP 1 "检查梯子和 Clash Verge"
if (-not (Test-VergeInstalled)) { Migrate $true }
elseif ((Test-Path -LiteralPath (Join-Path $CV_DIR "profiles.yaml")) -and -not (Has-CurrentProfile)) { Migrate $false }
if (-not (Test-Path -LiteralPath $CV_CFG)) { Start-Verge; if (-not (Wait-Ctl 60)) { DIE "Clash Verge 启动失败或控制接口连不上。" } }
$VV = Get-VergeVersion
if ($VV) { try { if ([version]($VV -replace '[^0-9.].*$','') -lt $MIN_VERGE) { WARN "Clash Verge 版本 $VV 偏旧（我们测过 $MIN_VERGE 及以上），建议在「设置 → 检查更新」升级后再运行" } } catch {} }
if (-not (Find-Ctl)) {
  Start-Verge; for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 2; if (Find-Ctl) { break } }
  if (-not (Find-Ctl)) { DIE "Clash Verge 启动失败或控制接口连不上。" }
}
OK ("Clash Verge 正在运行" + $(if ($VV) { "（$VV）" } else { "" }))
$runOthers = @(); foreach ($c in $OTHER_CLIENTS) { if (Get-Running $c[1]) { $runOthers += ,$c } }
if ($runOthers.Count) {
  WARN ("这些代理软件也在运行，会和 Clash Verge 抢网络、让 Claude 流量漏出去：" + (($runOthers | ForEach-Object { $_[0] }) -join "、"))
  if ((Ask "帮你退出它们？（y/n，默认 y）") -ne "n") { foreach ($c in $runOthers) { Stop-App $c[1] }; OK "已退出（以后别和 Clash Verge 同时开）" }
}
$cfgJ = JParse (Ctl "GET" "/configs" $null)
$MIXED_PORT = if ($cfgJ -and $cfgJ.'mixed-port') { $cfgJ.'mixed-port' } else { 7897 }
$null = CurlX -s -m 10 -o NUL -x "http://127.0.0.1:$MIXED_PORT" "https://www.google.com/generate_204"
if ($LASTEXITCODE -ne 0) { DIE "梯子不通：通过 Clash 打不开 Google。请先确认你的梯子能正常使用。" }
OK "梯子可用"

# ===== 2. 开通码 =====
STEP 2 "读取开通码"
if (-not $Code) { $Code = $env:CE_CODE }
if (-not $Code) { $sec = Read-Host "请粘贴开通码（CE1- 开头，粘贴后不显示），回车" -AsSecureString; $Code = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
$Code = ($Code -replace '\s', '')
if (-not $Code.StartsWith("CE1-")) { DIE "开通码格式不对：应以 CE1- 开头。" }
$b64 = $Code.Substring(4).Replace('-', '+').Replace('_', '/'); switch ($b64.Length % 4) { 2 { $b64 += "==" } 3 { $b64 += "=" } }
$cj = $null; try { $cj = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json } catch {}
$SAFE = '^[A-Za-z0-9._-]+$'
$PX_HOST = [string]$cj.host; $PX_PORT = [string]$cj.port; $PX_USER = [string]$cj.user; $PX_PASS = [string]$cj.pass; $PX_IP = [string]$cj.ip; $TZNAME = [string]$cj.tz
if (-not ($cj -and $PX_HOST -match $SAFE -and $PX_PORT -match '^\d{1,5}$' -and $PX_USER -match $SAFE -and $PX_PASS -match $SAFE -and $PX_IP -match '^\d{1,3}(\.\d{1,3}){3}$' -and $TZNAME -match '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$')) { DIE "开通码无效或不完整，请向客服重新获取。" }
$WINTZ = $TZ_MAP[$TZNAME]
if (-not $WINTZ) { DIE "暂不支持这个时区（$TZNAME），请截图发给客服。" }
OK "你的专属 IP：$PX_IP（时区 $TZNAME）"

# ===== 3. 写入 Clash（全局扩展脚本，不动原订阅） =====
STEP 3 "写入 Clash Verge 分流规则"
$SCRIPT_JS = Join-Path $CV_DIR "profiles\Script.js"
if (-not (Test-Path -LiteralPath $SCRIPT_JS)) { WriteText $SCRIPT_JS "function main(config, profileName) {`n  return config;`n}`n" }
Copy-Item -LiteralPath $SCRIPT_JS "$SCRIPT_JS.backup-claude-env-$TS"
$js = ReadText $SCRIPT_JS
$js = [regex]::Replace($js, "(?ms)^" + [regex]::Escape($MARK_BEGIN) + ".*?^" + [regex]::Escape($MARK_END) + "\r?\n?", "")
if ($js -notmatch "__ceUserMain") { $js = [regex]::Replace($js, "function\s+main\s*\(", "function __ceUserMain(") }
# 与 claude-env.sh 中的脚本块逐字一致（测试会比对）
$block = @'
// >>> claude-env BEGIN
function main(config, profileName) {
  if (typeof __ceUserMain === "function") config = __ceUserMain(config, profileName) || config;
  var G = "@G@", N = "@N@", F = "@F@";
  var SUFFIX = @SUFFIX@, KEYWORD = @KEYWORD@;
  var CIDR = @CIDR@, CIDR6 = @CIDR6@;
  var rules = config.rules || [], groups = (config["proxy-groups"] || []).filter(function (g) { return g.name !== G && g.name !== F; });
  config.proxies = (config.proxies || []).filter(function (p) { return p.name !== N; });
  // 前置：默认是梯子原来的默认出口（MATCH 指向的分组或节点）
  var front = null, m = rules.filter(function (r) { return /^MATCH,/i.test(r); })[0];
  if (m) front = m.split(",")[1].trim();
  if (!front || front === G || front === N || front === F || /^(DIRECT|REJECT)/i.test(front)) {
    var s = groups.filter(function (g) { return g.type === "select"; })[0] || config.proxies[0];
    front = s ? s.name : null;
  }
  // 有两个以上真实节点时，前置改为自动测速组：某个节点挂了自动换，最终出口 IP 不变
  var INFO = /(剩余|到期|过期|流量|官网|套餐|重置|expire|traffic|website)/i;
  var cands = config.proxies.filter(function (p) { return !INFO.test(p.name) && !/^(direct|reject|dns)$/i.test(p.type || ""); }).map(function (p) { return p.name; });
  var mine = [{ name: G, type: "select", proxies: [N] }];
  if (cands.length >= 2) {
    mine.push({ name: F, type: "url-test", hidden: true, url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 50, lazy: false, proxies: cands });
    front = F;
  }
  var node = { name: N, type: "http", server: "@HOST@", port: @PORT@, username: "@USER@", password: "@PASS@", udp: false };
  if (front) node["dialer-proxy"] = front;
  config.proxies.push(node);
  config["proxy-groups"] = mine.concat(groups);
  var pre = [];
  CIDR6.forEach(function (c) { pre.push("IP-CIDR6," + c + ",REJECT,no-resolve"); });
  if (front) pre.push("DOMAIN,downloads.claude.ai," + front);
  SUFFIX.forEach(function (d) { pre.push("AND,((NETWORK,UDP),(DOMAIN-SUFFIX," + d + ")),REJECT"); });
  KEYWORD.forEach(function (k) { pre.push("AND,((NETWORK,UDP),(DOMAIN-KEYWORD," + k + ")),REJECT"); });
  SUFFIX.forEach(function (d) { pre.push("DOMAIN-SUFFIX," + d + "," + G); });
  KEYWORD.forEach(function (k) { pre.push("DOMAIN-KEYWORD," + k + "," + G); });
  CIDR.forEach(function (c) { pre.push("IP-CIDR," + c + "," + G + ",no-resolve"); });
  config.rules = pre.concat(rules.filter(function (r) { return pre.indexOf(r) < 0; }));
  // 这些域名用海外加密 DNS，经专属 IP 解析，不经过国内 DNS
  if (config.dns && typeof config.dns === "object") {
    var pol = config.dns["nameserver-policy"] || {};
    SUFFIX.forEach(function (d) { pol["+." + d] = ["https://1.1.1.1/dns-query#" + G, "https://8.8.8.8/dns-query#" + G]; });
    config.dns["nameserver-policy"] = pol;
  }
  return config;
}
// <<< claude-env END
'@
$block = $block.Replace("@G@", $GROUP_NAME).Replace("@N@", $NODE_NAME).Replace("@F@", $FRONT_NAME).Replace("@SUFFIX@", (JsArr $CLAUDE_SUFFIXES)).Replace("@KEYWORD@", (JsArr $CLAUDE_KEYWORDS)).Replace("@CIDR@", (JsArr $ANTHROPIC_CIDR)).Replace("@CIDR6@", (JsArr $ANTHROPIC_CIDR6)).Replace("@HOST@", $PX_HOST).Replace("@PORT@", $PX_PORT).Replace("@USER@", $PX_USER).Replace("@PASS@", $PX_PASS)
$js = $js.TrimEnd() + "`n" + ($block -replace "`r`n", "`n")
if (-not $js.EndsWith("`n")) { $js += "`n" }
WriteText $SCRIPT_JS $js
OK "已写入全局扩展脚本：Claude、后台上报、人机验证、付款、实名都走专属 IP；你原来的订阅和节点不变"

# ===== 4. 清理环境变量 =====
STEP 4 "清理环境变量（中转地址、指向别处的代理等）"
$found = $false
foreach ($scope in "User", "Machine") {
  foreach ($n in $BAD_ENV_NAMES) {
    $v = Get-EnvVar $n $scope
    if ($v -and (Env-IsBad $n $v)) { $found = $true; Write-Host "  系统环境变量（$scope）：$n"; Set-EnvVar $n $null $scope }
  }
}
$profiles = @("Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1", "Documents\WindowsPowerShell\profile.ps1", "Documents\PowerShell\Microsoft.PowerShell_profile.ps1", "Documents\PowerShell\profile.ps1") | ForEach-Object { Join-Path $UH $_ }
$envRe = '^\s*\$env:(' + ($BAD_ENV_NAMES -join "|") + ')\s*=\s*[''"]?([^''"#]*)'
foreach ($pf in $profiles) {
  if (-not (Test-Path -LiteralPath $pf)) { continue }
  $lines = (ReadText $pf) -split "`n"; $changed = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $mm = [regex]::Match($lines[$i], $envRe, "IgnoreCase")
    if ($mm.Success -and (Env-IsBad $mm.Groups[1].Value.ToUpper() $mm.Groups[2].Value.Trim())) { Write-Host "  $pf 第 $($i+1) 行：$($mm.Groups[1].Value)=…"; $lines[$i] = "# [claude-env 已停用 $TS] " + $lines[$i]; $changed = $true }
  }
  if ($changed) { $found = $true; Copy-Item -LiteralPath $pf "$pf.backup-claude-env-$TS"; WriteText $pf ($lines -join "`n") }
}
if (Test-Path -LiteralPath $CS) {
  $s = JsonRead $CS; $bad = @()
  if (Has $s "env") { foreach ($n in $BAD_ENV_NAMES) { if ((Has $s.env $n) -and (Env-IsBad $n ([string]$s.env.$n))) { $bad += $n } } }
  if (Has $s "apiKeyHelper") { $bad += "apiKeyHelper" }
  if ($bad.Count) { $found = $true; Write-Host ("  .claude\settings.json：" + ($bad -join " ")); Copy-Item -LiteralPath $CS "$CS.backup-claude-env-$TS"
    foreach ($k in $bad) { if ($k -eq "apiKeyHelper") { DelProp $s $k } else { DelProp $s.env $k } }; JsonWrite $CS $s }
}
if ($found) { OK "以上项目已停用（原文件都有 .backup-claude-env-$TS 备份）" } else { OK "没有发现会干扰的环境变量" }

# ===== 5. 本机设置 =====
STEP 5 "本机设置：TUN / 时区 / 语言 / 定位 / 遥测 / 旧标识"
function Set-Tun($on) {
  $v = if ($on) { "true" } else { "false" }; $vy = ReadText $VERGE_YAML
  if ($vy -match "(?m)^enable_tun_mode:") { $vy = [regex]::Replace($vy, "(?m)^enable_tun_mode:.*$", "enable_tun_mode: $v") } else { $vy = $vy.TrimEnd() + "`nenable_tun_mode: $v`n" }
  WriteText $VERGE_YAML $vy
}
$TUN_ON = $false
if (Ensure-Service) { Set-Tun $true; $TUN_ON = $true }
elseif ((JParse (Ctl "GET" "/configs" $null)).tun.enable -eq $true) { OK "TUN（虚拟网卡）现在就开着，保持不动"; $TUN_ON = $true }
else { Set-Tun $false }   # 没有服务模式时开着 TUN 内核起不来；先关掉，验收里会告诉客户怎么打开
# Windows 的 TUN 必须开「严格路由」，否则部分流量会绕过虚拟网卡
$cc = ReadText $CV_CLASH
if ($cc -match "(?m)^tun:") {
  if ($cc -match "(?m)^  strict-route:") { $cc = [regex]::Replace($cc, "(?m)^  strict-route:.*$", "  strict-route: true") }
  else { $cc = [regex]::Replace($cc, "(?m)^tun:\s*$", "tun:`n  strict-route: true") }
} else { $cc = $cc.TrimEnd() + "`ntun:`n  strict-route: true`n" }
WriteText $CV_CLASH $cc
if ($TUN_ON) { OK "TUN（虚拟网卡）设为开启，严格路由开启" } else { OK "TUN 严格路由已设好（虚拟网卡打开后生效）" }
if ((Get-TzAuto) -ne "4") { Set-TzAutoOff }
if ((Get-SysTz) -ne $WINTZ) { Set-SysTz $WINTZ }
OK "已关闭「自动设置时区」，电脑时区：$(Get-SysTz)"
if ((Get-LangFirst) -ne "en-US" -or (Get-Culture2) -ne "en-US" -or (Get-Geo) -ne "244") { Set-LangUS }
OK "系统语言：英语排第一（原来的中文和输入法保留），区域格式和国家/地区：美国。重启电脑后生效"
if ((Get-Loc) -ne "Deny") { Set-LocDeny }
if ((Get-Loc) -eq "Deny") { OK "定位服务已关闭" } else { WARN "定位服务仍开着（验收会标出）" }
foreach ($n in $TELEMETRY_ENV) { if ((Get-EnvVar $n "User") -ne "1") { Set-EnvVar $n "1" "User" } }
if (Test-Path -LiteralPath $CS) { if (-not (Test-Path -LiteralPath "$CS.backup-claude-env-$TS")) { Copy-Item -LiteralPath $CS "$CS.backup-claude-env-$TS" } }
$s = JsonRead $CS; if (-not (Has $s "env")) { SetProp $s "env" (New-Object PSObject) }
foreach ($n in $TELEMETRY_ENV) { SetProp $s.env $n "1" }; JsonWrite $CS $s
OK "Claude Code：遥测和错误上报已关闭"
$BK = Join-Path $UH ".claude-env-backup\$TS"; New-Item -ItemType Directory -Force -Path (Join-Path $BK "old") | Out-Null
if (Test-Path -LiteralPath $CCJ) {
  Copy-Item -LiteralPath $CCJ (Join-Path $BK "claude.json")
  $o = JsonRead $CCJ; foreach ($k in $CC_ID_KEYS) { DelProp $o $k }; JsonWrite $CCJ $o
}
# 旧备份里也存着旧设备标识；遥测、统计、实验缓存整个目录挪走
$old = @(Get-ChildItem -Path $UH -Filter ".claude.json.backup*" -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$old += @(".claude\backups", ".claude\statsig", ".claude\telemetry", ".claude\stats-cache.json", ".claude\usage-data", ".claude\usage.jsonl") | ForEach-Object { Join-Path $UH $_ }
$old += (Join-Path $env:LOCALAPPDATA "claude-cli-nodejs")
foreach ($p in $old) { if (Test-Path -LiteralPath $p) { Move-Item -LiteralPath $p (Join-Path $BK "old") -Force } }
OK "Claude Code：设备/实验/统计标识、旧配置备份、遥测缓存已清理，不会退出登录"
$deskSeen = $false
foreach ($d in $DESKTOP_DIRS) {
  if (-not (Test-Path -LiteralPath $d)) { continue }
  if (-not $deskSeen) { Stop-App "Claude"; Start-Sleep -Seconds 2; $deskSeen = $true }
  $dst = Join-Path $BK ("desktop-" + [Math]::Abs($d.GetHashCode())); New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($n in "ant-did", "ant-device-registry.json", "sentry", "Crashpad", "machine-id", ".machine-id") { $p = Join-Path $d $n; if (Test-Path -LiteralPath $p) { Move-Item -LiteralPath $p $dst -Force } }
}
if ($deskSeen) { OK "Claude 桌面版：设备标识和本机配置快照已清理（登录状态保留）" }
OK "以上都已备份到 $BK"

STEP 6 "重启 Clash Verge 使配置生效（断网几秒）"
# Clash Verge 2.5 起：只结束界面进程的话，内核还占着端口和管道，新开的 Clash Verge 会拒绝再起一个内核；所以连内核一起关
Stop-VergeAll; Start-Sleep -Seconds 1; Start-Verge
$ok = Wait-Ctl 60
if (-not $ok -and $TUN_ON) {
  # 开着虚拟网卡（TUN）内核没起来：先关掉虚拟网卡让 Clash Verge 正常运行（客户不能断网），验收里会提示怎么打开
  WARN "Clash Verge 开着虚拟网卡（TUN）没能启动，先关掉虚拟网卡让它正常运行"
  Set-Tun $false; $TUN_ON = $false
  Stop-VergeAll; Start-Sleep -Seconds 1; Start-Verge
  $ok = Wait-Ctl 60
}
if (-not $ok) { DIE "Clash Verge 重启后连不上。" }
if ($TUN_ON) {
  # 服务模式下内核由服务启动，虚拟网卡要等几秒
  $tunUp = $false; for ($i = 0; $i -lt 10; $i++) { if ((JParse (Ctl "GET" "/configs" $null)).tun.enable -eq $true) { $tunUp = $true; break }; Start-Sleep -Seconds 2 }
  if ($tunUp) { OK "虚拟网卡（TUN）已在运行" } else { WARN "虚拟网卡（TUN）设了开启，但内核没打开它（验收会标出）" }
}
$cfgJ = JParse (Ctl "GET" "/configs" $null)
if ($cfgJ.mode -ne "rule") { $null = Ctl "PATCH" "/configs" '{"mode":"rule"}' }
for ($i = 0; $i -lt 15; $i++) { $null = CurlX -s -m 3 -o NUL -x "http://127.0.0.1:$MIXED_PORT" "https://www.google.com/generate_204"; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 2 }
$v6 = TraceIp (CurlX -6 -s -m 6 "https://claude.ai/cdn-cgi/trace")
if ($v6 -and $v6 -ne $PX_IP) { Write-Host "  发现 IPv6 绕过 Clash（$v6），关闭网卡 IPv6"; Disable-V6 }

# ===== 7. 严格验收 =====
STEP 7 "严格验收"
$script:PASS = 0; $script:FAILN = 0
function Chk($name, $res) { if ($res -eq "ok") { OK $name; $script:PASS++ } else { ERR "$name —— $res"; $script:FAILN++ } }
$cfgJ = JParse (Ctl "GET" "/configs" $null)
if ($cfgJ.mode -eq "rule") { Chk "Clash 规则模式" "ok" } else { Chk "Clash 规则模式" "当前是 $($cfgJ.mode)，请在首页切到「规则」" }
if ($cfgJ.tun.enable -eq $true) { Chk "TUN 虚拟网卡已开启" "ok" }
elseif ((Get-SvcState) -eq "running") { Chk "TUN 虚拟网卡已开启" "没开。服务模式已装好：Clash Verge「设置」→ 打开「虚拟网卡模式」，然后重新运行本命令" }
else { Chk "TUN 虚拟网卡已开启" "没开（服务模式没能自动装上）。Clash Verge「设置」→ 点「安装服务模式」，再打开「虚拟网卡模式」，然后重新运行本命令" }
if ($cfgJ.tun.'strict-route' -eq $true) { Chk "TUN 严格路由已开启" "ok" } else { Chk "TUN 严格路由已开启" "没开。Clash Verge「设置」→「虚拟网卡模式」旁的齿轮 → 打开「严格路由」" }
$rules = (JParse (Ctl "GET" "/rules" $null)).rules
$missing = @(); foreach ($d in "claude.ai", "sentry.io", "hcaptcha.com", "stripe.com", "withpersona.com") { if (-not ($rules | Where-Object { $_.payload -eq $d -and $_.proxy -eq $GROUP_NAME })) { $missing += $d } }
if (-not $missing.Count) { Chk "分流规则已加载（Claude、上报、验证、付款、实名）" "ok" } else { Chk "分流规则已加载" ("缺少： " + ($missing -join " ") + "。Clash Verge「订阅」页确认「全局扩展脚本」已启用") }
if ($rules | Where-Object { $_.type -eq "AND" -and $_.proxy -eq "REJECT" -and $_.payload -match "claude\.ai" }) { Chk "Claude 的 UDP/QUIC 已拦截" "ok" } else { Chk "Claude 的 UDP/QUIC 已拦截" "规则没加载" }
if ($rules | Where-Object { $_.proxy -eq "REJECT" -and $_.payload -match "2607:6bc0" }) { Chk "Anthropic IPv6 已拒绝（只走 IPv4）" "ok" } else { Chk "Anthropic IPv6 已拒绝" "规则没加载" }
# 以 Clash Verge 实际生效的配置为准：「DNS 覆写」开着时会盖掉扩展脚本写的 nameserver-policy
$rt = if (Test-Path -LiteralPath $CV_CFG) { ReadText $CV_CFG } else { "" }
if ($rt.Contains("dns-query#$GROUP_NAME")) { Chk "Claude 域名走海外加密 DNS（不经过国内 DNS）" "ok" }
elseif ($rt -match '(?m)^\s*enhanced-mode:\s*fake-ip') { Chk "Claude 域名不在本机解析（Fake-IP，交给专属 IP 远端解析）" "ok" }
else { Chk "Claude 域名走海外加密 DNS" "没生效，多半是 Clash Verge「设置」里开了「DNS 覆写」：关掉后重新运行本命令" }
$delay = (JParse (Ctl "GET" ("/proxies/" + [uri]::EscapeDataString($NODE_NAME) + "/delay?timeout=8000&url=" + [uri]::EscapeDataString("https://claude.ai/cdn-cgi/trace")) $null)).delay
if ($delay) { Chk "链路 梯子→中转→专属IP 连通（${delay}ms）" "ok" } else { Chk "链路 梯子→中转→专属IP 连通" "不通，请截图发给客服" }
foreach ($d in "claude.ai", "claude.com", "anthropic.com", "challenges.cloudflare.com") {
  $ip = TraceIp (DTrace "https://$d/cdn-cgi/trace")
  if ($ip -eq $PX_IP) { Chk "$d 看到的出口 = $PX_IP（不设代理直连，证明 TUN 接管）" "ok" } else { Chk "$d 看到的出口" ("看到的是 " + $(if ($ip) { $ip } else { "连不上" })) }
}
$ipP = TraceIp (CurlX -s -m 15 -x "http://127.0.0.1:$MIXED_PORT" "https://api.anthropic.com/cdn-cgi/trace")
if ($ipP -eq $PX_IP) { Chk "Claude Code 通道出口 = $PX_IP" "ok" } else { Chk "Claude Code 通道出口" ("看到的是 " + $(if ($ipP) { $ipP } else { "连不上" })) }
$v6 = TraceIp (CurlX -6 -s -m 6 "https://claude.ai/cdn-cgi/trace")
if (-not $v6 -or $v6 -eq $PX_IP) { Chk "无 IPv6 绕过" "ok" } else { Chk "无 IPv6 绕过" "IPv6 直连看到 $v6" }
$other = TraceIp (DTrace "https://www.cloudflare.com/cdn-cgi/trace")
if ($other -and $other -ne $PX_IP) { Chk "其他网站仍走你的梯子（不浪费专属 IP 流量）" "ok" } else { Chk "其他网站仍走你的梯子" ("其他网站出口是 " + $(if ($other) { $other } else { "连不上" })) }
$tm = [regex]::Match((CurlX -s -m 15 "https://ip.net.coffee/api/iprisk/$PX_IP"), '"trust_score":\s*(\d+)')
if (-not $tm.Success) { WARN "Claude 信任评分暂时查不到（第三方服务），不影响使用"; $script:PASS++ }
elseif ([int]$tm.Groups[1].Value -ge 80) { Chk "Claude 信任评分 $($tm.Groups[1].Value)（≥80）" "ok" } else { Chk "Claude 信任评分" "只有 $($tm.Groups[1].Value)，请截图发给客服" }
if ((Get-SysTz) -eq $WINTZ) { Chk "电脑时区 = IP 时区（$WINTZ）" "ok" } else { Chk "电脑时区 = IP 时区" "电脑是 $(Get-SysTz)，IP 是 $WINTZ" }
if ((Get-TzAuto) -eq "4") { Chk "「自动设置时区」已关闭" "ok" } else { Chk "「自动设置时区」已关闭" "还开着，换网络后时区可能被改回去" }
if ((Get-LangFirst) -eq "en-US" -and (Get-Culture2) -eq "en-US" -and (Get-Geo) -eq "244") { Chk "系统语言英语、区域和国家美国" "ok" } else { Chk "系统语言英语、区域和国家美国" "当前是 $(Get-LangFirst) / $(Get-Culture2) / $(Get-Geo)" }
if ((Get-Loc) -eq "Deny") { Chk "定位服务已关闭" "ok" } else { Chk "定位服务已关闭" "还开着：设置 → 隐私和安全性 → 位置，关掉「定位服务」" }
$left = @()
foreach ($scope in "User", "Machine") { foreach ($n in $BAD_ENV_NAMES) { $v = Get-EnvVar $n $scope; if ($v -and (Env-IsBad $n $v)) { $left += "$n($scope)" } } }
foreach ($pf in $profiles) { if (Test-Path -LiteralPath $pf) { foreach ($l in ((ReadText $pf) -split "`n")) { $mm = [regex]::Match($l, $envRe, "IgnoreCase"); if ($mm.Success -and (Env-IsBad $mm.Groups[1].Value.ToUpper() $mm.Groups[2].Value.Trim())) { $left += $mm.Groups[1].Value } } } }
if (-not $left.Count) { Chk "没有干扰的环境变量" "ok" } else { Chk "没有干扰的环境变量" ("还有：" + ($left -join " ")) }
$s = JsonRead $CS; $tel = @(); foreach ($n in $TELEMETRY_ENV) { if (-not ((Has $s "env") -and $s.env.$n -eq "1" -and (Get-EnvVar $n "User") -eq "1")) { $tel += $n } }
if (-not $tel.Count) { Chk "Claude Code 遥测已关闭" "ok" } else { Chk "Claude Code 遥测已关闭" ("缺少：" + ($tel -join " ")) }
$o = JsonRead $CCJ; $lk = @(); foreach ($k in $CC_ID_KEYS) { if (Has $o $k) { $lk += $k } }
if (-not $lk.Count) { Chk "Claude Code 旧设备标识已清除" "ok" } else { Chk "Claude Code 旧设备标识已清除" ("还在：" + ($lk -join " ")) }
$res = @(); foreach ($p in $old) { if (Test-Path -LiteralPath $p) { $res += $p } }
if (-not $res.Count) { Chk "旧配置备份和遥测缓存已清除" "ok" } else { Chk "旧配置备份和遥测缓存已清除" ("还在：" + ($res -join " ")) }
$dleft = @(); foreach ($d in $DESKTOP_DIRS) { foreach ($n in "ant-did", "sentry", "machine-id") { if (Test-Path -LiteralPath (Join-Path $d $n)) { $dleft += $n } } }
if (-not $dleft.Count) { Chk "Claude 桌面版设备标识已清除" "ok" } else { Chk "Claude 桌面版设备标识已清除" "还在" }
$still = @(); foreach ($c in $OTHER_CLIENTS) { if (Get-Running $c[1]) { $still += $c[0] } }
if (-not $still.Count) { Chk "没有其他代理软件同时运行" "ok" } else { Chk "没有其他代理软件同时运行" ("还在运行：" + ($still -join "、") + "，请退出") }

Write-Host ""
if ($script:FAILN -eq 0) {
  Write-Host "全部 $($script:PASS) 项验收通过 ✅" -ForegroundColor Green
  Write-Host "  专属 IP：$PX_IP（$TZNAME）"
  Write-Host "  最后一步：重启电脑一次（让英文语言生效），重启后再打开浏览器、Claude 桌面版和终端"
  Write-Host "  再用浏览器打开 https://laoshirenvip.com/ip-check ，确认浏览器这一侧的时区、语言也一致"
  Write-Host "  提醒：这些 Claude 号不要在插着国内 SIM 卡的安卓手机上登录；Windows 上优先用 Claude Code 和网页版"
  exit 0
} else {
  Write-Host "$($script:PASS) 项通过，$($script:FAILN) 项没通过 ✘" -ForegroundColor Red
  Write-Host "请把这个窗口截图发给客服。"
  exit 4
}
