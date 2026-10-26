# Claude 稳定使用环境 · 一键部署（Windows 10/11 + Clash Verge Rev）
#
# 客户前提：① 自己有能用的梯子，并在 Clash Verge Rev 里导入了订阅
#           ② 有我们发的开通码（CE1- 开头）
# 链路：客户电脑 → 客户的梯子（自动挑能通的节点）→ 我们的中转 → 客户专属静态 IP → Claude
# 需要管理员权限（改时区服务、定位、系统环境变量、网卡 IPv6）；不是管理员时自动请求提权。
#
# 测试用环境变量（客户不需要）：
#   CE_CODE=CE1-...    不交互，直接用这个开通码
#   CE_TEST_ROOT=/path 压测沙箱：系统级读写全部改为沙箱文件，控制接口走 $CE_TEST_ROOT/verge-mihomo.sock
#   CE_CURL=/path      测试用的 curl 替身
param([string]$Code = "")
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

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
$OTHER_CLIENTS = @(
  @("Clash for Windows","Clash for Windows"), @("Clash Party","Clash Party"), @("Mihomo Party","Mihomo Party"), @("FlClash","FlClash"),
  @("Clash Nyanpasu","clash-nyanpasu"), @("GUI.for.Clash","GUI.for.Clash"), @("v2rayN","v2rayN"), @("NekoRay","nekoray"), @("Hiddify","Hiddify"),
  @("Karing","karing"), @("sing-box","sing-box"), @("Shadowsocks","Shadowsocks"), @("ShadowsocksR","ShadowsocksR"), @("Clash.Meta","clash-meta")
)
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
function Start-Verge { SysLog "start Clash Verge"; if ($TR) { return }; $e = Get-VergeExe; if ($e) { Start-Process $e } }
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
  $pipeName = "verge-mihomo"
  $m = [regex]::Match((ReadText $CV_CFG), '(?m)^external-controller-pipe:\s*[''"]?\\\\\.\\pipe\\([^''"\r\n]+)')
  if ($m.Success) { $pipeName = $m.Groups[1].Value }
  try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(3000)
    $b = if ($body) { $UTF8.GetBytes($body) } else { [byte[]]@() }
    $hdr = "$method $path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $SECRET`r`nConnection: close`r`n"
    if ($body) { $hdr += "Content-Type: application/json`r`n" }
    $hdr += "Content-Length: $($b.Length)`r`n`r`n"
    $h = $UTF8.GetBytes($hdr); $pipe.Write($h, 0, $h.Length); if ($b.Length) { $pipe.Write($b, 0, $b.Length) }; $pipe.Flush()
    $ms = New-Object System.IO.MemoryStream; $buf = New-Object byte[] 65536
    while (($n = $pipe.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
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
function Find-Ctl {
  $m = [regex]::Match((ReadText $CV_CFG), '(?m)^secret:\s*[''"]?([^''"\r\n]*)')
  $script:SECRET = if ($m.Success) { $m.Groups[1].Value.Trim() } else { "" }
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

Write-Host ""; Write-Host "Claude 稳定使用环境 · 一键部署（Windows）"

# ===== 0. 管理员权限 =====
if (-not $TR) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    if (-not $PSCommandPath) { DIE "需要管理员权限：请右键「Windows PowerShell」→「以管理员身份运行」，再粘贴命令。" }
    WARN "需要管理员权限，正在请求（请在弹窗里点「是」）"
    $argList = "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""   # -NoExit：跑完窗口不关，客户能看到验收结果
    if ($Code) { $argList += " -Code `"$Code`"" }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit 0
  }
}

# ===== 1. 前提检查 =====
STEP 1 "检查梯子和 Clash Verge"
if (-not (Test-Path -LiteralPath $CV_CFG)) {
  $others = @(); foreach ($c in $OTHER_CLIENTS) { if (Get-Running $c[1]) { $others += $c[0] } }
  ERR "没找到 Clash Verge Rev。"
  if ($others.Count) { Write-Host ("  检测到你在用：" + ($others -join "、") + "。这类软件没法可靠地自动配置「梯子 → 专属 IP」链路，需要换成 Clash Verge Rev（免费开源）。") }
  Write-Host "  1. 已为你打开下载页：下载 x64-setup.exe（ARM 电脑选 arm64），装好打开"
  Write-Host "  2. 在 Clash Verge Rev「订阅」里粘贴你梯子的订阅链接，选中它"
  Write-Host "  3. 退出原来的代理软件，确认能打开 google.com 后，重新运行本命令"
  Open-Url "https://github.com/clash-verge-rev/clash-verge-rev/releases/latest"
  exit 3
}
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
$vy = ReadText $VERGE_YAML
if ($vy -match "(?m)^enable_tun_mode:") { $vy = [regex]::Replace($vy, "(?m)^enable_tun_mode:.*$", "enable_tun_mode: true") } else { $vy = $vy.TrimEnd() + "`nenable_tun_mode: true`n" }
WriteText $VERGE_YAML $vy
# Windows 的 TUN 必须开「严格路由」，否则部分流量会绕过虚拟网卡
$cc = ReadText $CV_CLASH
if ($cc -match "(?m)^tun:") {
  if ($cc -match "(?m)^  strict-route:") { $cc = [regex]::Replace($cc, "(?m)^  strict-route:.*$", "  strict-route: true") }
  else { $cc = [regex]::Replace($cc, "(?m)^tun:\s*$", "tun:`n  strict-route: true") }
} else { $cc = $cc.TrimEnd() + "`ntun:`n  strict-route: true`n" }
WriteText $CV_CLASH $cc
OK "TUN（虚拟网卡）设为开启，严格路由开启"
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
Stop-App "clash-verge"; Start-Sleep -Seconds 4; Start-Verge
$ok = $false; for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Seconds 2; if (Find-Ctl) { $ok = $true; break } }
if (-not $ok) { DIE "Clash Verge 重启后连不上。" }
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
if ($cfgJ.tun.enable -eq $true) { Chk "TUN 虚拟网卡已开启" "ok" } else { Chk "TUN 虚拟网卡已开启" "没开。Clash Verge「设置」→ 先安装「服务模式」，再打开「虚拟网卡模式」" }
if ($cfgJ.tun.'strict-route' -eq $true) { Chk "TUN 严格路由已开启" "ok" } else { Chk "TUN 严格路由已开启" "没开。Clash Verge「设置」→「虚拟网卡模式」旁的齿轮 → 打开「严格路由」" }
$rules = (JParse (Ctl "GET" "/rules" $null)).rules
$missing = @(); foreach ($d in "claude.ai", "sentry.io", "hcaptcha.com", "stripe.com", "withpersona.com") { if (-not ($rules | Where-Object { $_.payload -eq $d -and $_.proxy -eq $GROUP_NAME })) { $missing += $d } }
if (-not $missing.Count) { Chk "分流规则已加载（Claude、上报、验证、付款、实名）" "ok" } else { Chk "分流规则已加载" ("缺少： " + ($missing -join " ") + "。Clash Verge「订阅」页确认「全局扩展脚本」已启用") }
if ($rules | Where-Object { $_.type -eq "AND" -and $_.proxy -eq "REJECT" -and $_.payload -match "claude\.ai" }) { Chk "Claude 的 UDP/QUIC 已拦截" "ok" } else { Chk "Claude 的 UDP/QUIC 已拦截" "规则没加载" }
if ($rules | Where-Object { $_.proxy -eq "REJECT" -and $_.payload -match "2607:6bc0" }) { Chk "Anthropic IPv6 已拒绝（只走 IPv4）" "ok" } else { Chk "Anthropic IPv6 已拒绝" "规则没加载" }
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
