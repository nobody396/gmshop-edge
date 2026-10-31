#!/bin/bash
# Claude 稳定使用环境 · 一键部署（macOS + Clash Verge Rev）
#
# 客户前提：① 自己有能用的代理订阅（没装 Clash Verge Rev 的，脚本自动安装并把原软件里的订阅导入）
#             梯子装在路由器上（软路由）、电脑上没有代理软件的：找不到订阅时输入 R，脚本只装 Clash Verge Rev，
#             不要订阅，到中转的那一跳由路由器代理出国
#           ② 有我们发的开通码（CE1- 开头）
# 链路：客户电脑 → 客户的梯子（自动挑能通的节点）→ 我们的中转 → 客户专属静态 IP → Claude
# 脚本完成：写入 Clash 分流（Claude、上报、验证、付款、实名全部走专属 IP）→ 关自动时区并改时区
#           → 系统语言英语/地区美国 → 关定位 → 清理环境变量 → 关遥测 → 清理 Claude Code 与桌面版旧标识
#           → 严格验收
#
# 测试用环境变量（客户不需要）：
#   CE_CODE=CE1-...   不交互，直接用这个开通码
#   CE_DRY_RUN=1      不改本机任何东西：配置只写到临时目录，其余只读检查
#   CE_TEST_ROOT=/path 压测沙箱：所有系统级命令（退出/打开 App、sudo、launchctl、networksetup、defaults 写入）只记日志不执行，
#                     控制接口只找 $CE_TEST_ROOT/verge-mihomo.sock，时区/语言/定位/launchctl 读写沙箱里的文件
#   CE_TEST_HOOK=/path 沙箱里代替「下载 / 安装 / 启动 Clash Verge」的测试脚本（只在 CE_TEST_ROOT 下生效）
#   CE_TEST_TTY=1     沙箱里允许从终端提问（粘贴订阅链接）
#   CE_ROUTER=1       梯子在路由器上（软路由）：需要导入订阅时不找订阅也不问，直接按软路由配置（客服可让客户这样运行）
# 没装 Clash Verge Rev 时：自动下载官方固定版本（SHA-256 校验）装到「应用程序」，把原来代理软件（FlClash、Clash for Windows、
# Clash Party / Mihomo Party、Clash Nyanpasu、v2rayN）里正在用的订阅导入进去，再关掉原来的软件和它设的系统代理。
set -uo pipefail

GROUP_NAME="Claude静态IP"
NODE_NAME="Claude静态IP-节点"
FRONT_NAME="Claude静态IP-前置"
# 走专属 IP 的域名（含子域名）：Claude 本体、后台上报、人机验证、付款、实名、客服
CLAUDE_SUFFIXES="claude.ai claude.com clau.de anthropic.com claudeusercontent.com claudemcpclient.com claudemcpcontent.com modelcontextprotocol.io servd-anthropic-website.b-cdn.net sentry.io datadoghq.com growthbook.io usefathom.com segment.io siftscience.com statsig.com statsigapi.net hcaptcha.com challenges.cloudflare.com recaptcha.net stripe.com stripe.network stripecdn.com withpersona.com intercom.io intercomcdn.com"
CLAUDE_KEYWORDS="claude anthropic browser-intake"
ANTHROPIC_CIDR="160.79.104.0/21"
ANTHROPIC_CIDR6="2607:6bc0::/48 2607:6bc0:11::/48"
MIN_VERGE="2.4.0"
CV_DIR="$HOME/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev"
CV_CFG="$CV_DIR/clash-verge.yaml"
VERGE_YAML="$CV_DIR/verge.yaml"
# 软路由模式标记：梯子在路由器上，Clash 里没有订阅节点，到中转的这一跳直接连（由路由器代理出国）
ROUTER_MARK="$CV_DIR/claude-env-router"
ROUTER=""; [ -f "$ROUTER_MARK" ] && ROUTER=1
MARK_BEGIN="// >>> claude-env BEGIN"
MARK_END="// <<< claude-env END"
RC_BEGIN="# >>> claude-env BEGIN"
RC_END="# <<< claude-env END"
# 会干扰 Claude 出口或让 Claude Code 走别处的环境变量
BAD_ENV_NAMES="ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_HTTP_PROXY CLAUDE_CODE_HTTPS_PROXY CLAUDE_CODE_PROXY_URL NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy"
BAD_ENV_ALT=$(echo $BAD_ENV_NAMES | tr ' ' '|')
BAD_ENV_RE="^(export[[:space:]]+)?($BAD_ENV_ALT)="            # 顶层、开终端就生效的
BAD_ENV_RE_ANY="^[[:space:]]+(export[[:space:]]+)?($BAD_ENV_ALT)="  # 缩进的（多在函数里，手动调用才生效）
# 关遥测：Claude Code 读 ~/.claude/settings.json 的 env，也写进终端启动别名
TELEMETRY_ENV="DISABLE_TELEMETRY DISABLE_ERROR_REPORTING DO_NOT_TRACK CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
CLAUDE_DESKTOP_DIR="$HOME/Library/Application Support/Claude"
# Claude Code 本地的设备/实验/统计标识（删除后自动重新生成，不会退出登录）
CC_ID_KEYS="userID anonymousId machineID remoteControlMachineId cachedStatsigGates cachedGrowthBookFeatures cachedGrowthBookFeaturesAt cachedDynamicConfigs cachedExperimentData cachedExperimentFeatures metricsStatusCache metricsStatusCacheByPrincipal clientDataCache groveConfigCache passesEligibilityCache modelAccessCache firstStartTime numStartups"
SHELL_FILES="$HOME/.zshrc $HOME/.zprofile $HOME/.zshenv $HOME/.zlogin $HOME/.bash_profile $HOME/.bashrc $HOME/.profile"
LOC_PANE="x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
DRY="${CE_DRY_RUN:-}"
TS=$(date +%Y%m%d-%H%M%S)

c_ok()   { printf '\033[32m✔ %s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m✘ %s\033[0m\n' "$*"; }
step()   { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2"; }
die()    { c_err "$*"; printf '\n请把这个窗口截图发给客服。\n'; exit 1; }
ask()    { local a; read -r -p "$1 " a </dev/tty; printf '%s' "$a"; }

# JSON 取值：jget '<json>' '<JS 表达式或带 return 的函数体，o 为对象>'
jget() { osascript -l JavaScript -e 'function run(a){var o=JSON.parse(a[0]);var b=a[1];if(b.indexOf("return")<0)b="return ("+b+")";var v;try{v=new Function("o",b)(o)}catch(e){v=null}return (v===undefined||v===null)?"":(typeof v==="object"?JSON.stringify(v):String(v))}' "$1" "$2" 2>/dev/null; }
# 改 JSON 文件：jedit <file> '<JS 函数体，o 为对象，直接修改 o>'（文件不存在时从空对象开始）
jedit() { osascript -l JavaScript -e 'function run(a){var fm=$.NSFileManager.defaultManager;var o={};if(fm.fileExistsAtPath(a[0])){var s=$.NSString.stringWithContentsOfFileEncodingError(a[0],$.NSUTF8StringEncoding,null).js;o=JSON.parse(s)}new Function("o",a[1])(o);$(JSON.stringify(o,null,2)).writeToFileAtomicallyEncodingError(a[0],true,$.NSUTF8StringEncoding,null);return "ok"}' "$1" "$2" >/dev/null 2>&1; }

# Clash 控制接口（unix socket）
SECRET=""; SOCK=""
ctl() { # ctl METHOD PATH [BODY]
  local args=(-s -m "${CTL_MAX:-10}" -K - --unix-socket "$SOCK" -X "$1")
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' -d "$3")
  printf 'header = "Authorization: Bearer %s"\n' "$SECRET" | curl "${args[@]}" "http://localhost$2"
}
find_ctl() {
  SECRET=$(grep -E '^secret:' "$CV_CFG" 2>/dev/null | sed -E "s/^secret: *//; s/^['\"]//; s/['\"]$//")
  # 2.5 起 Clash Verge 自己的内核在每个用户的临时目录（getconf DARWIN_USER_TEMP_DIR），以配置里写的为准
  local cfg_sock; cfg_sock=$(grep -E '^external-controller-unix:' "$CV_CFG" 2>/dev/null | head -1 | sed -E "s/^external-controller-unix:[[:space:]]*//; s/^['\"]//; s/['\"][[:space:]]*\$//")
  local cands=("/var/run/clash-verge-service/users/$(id -u)/verge-mihomo.sock" "$cfg_sock" /tmp/verge/verge-mihomo.sock)
  [ -n "${CE_TEST_ROOT:-}" ] && cands=("$CE_TEST_ROOT/verge-mihomo.sock")
  for s in "${cands[@]}"; do
    [ -S "$s" ] && SOCK="$s" && CTL_MAX=4 ctl GET /version | grep -q version && return 0
  done
  SOCK=""; return 1
}
# 判断一个环境变量是否会干扰：中转/证书类一律算；代理类只有指向本机 Clash 以外才算
env_is_bad() { # name value
  case "$1" in
    NO_PROXY|no_proxy) printf '%s' "$2" | grep -qiE 'claude|anthropic' ;;
    HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|CLAUDE_CODE_HTTP_PROXY|CLAUDE_CODE_HTTPS_PROXY|CLAUDE_CODE_PROXY_URL)
      ! printf '%s' "$2" | grep -qE "^(https?|socks5h?)://(127\.0\.0\.1|localhost):${MIXED_PORT}/?\$" ;;
    *) return 0 ;;
  esac
}
# ---- 系统级操作统一入口（压测沙箱里只记日志，状态写沙箱文件） ----
TR="${CE_TEST_ROOT:-}"
sysrun()   { if [ -n "$TR" ]; then echo "$*" >>"$TR/sys.log"; return 0; fi; "$@"; }
lc_get()   { if [ -n "$TR" ]; then grep -E "^$1=" "$TR/launchctl.env" 2>/dev/null | head -1 | cut -d= -f2-; else launchctl getenv "$1" 2>/dev/null; fi; }
lc_unset() { if [ -n "$TR" ]; then echo "launchctl unsetenv $1" >>"$TR/sys.log"; sed -i '' "/^$1=/d" "$TR/launchctl.env" 2>/dev/null; else launchctl unsetenv "$1"; fi; }
set_tz()   { if [ -n "$TR" ]; then echo "set timezone $1" >>"$TR/sys.log"; echo "$1" >"$TR/localtime"; return 0; fi
             sudo systemsetup -settimezone "$1" >/dev/null 2>&1 || sudo ln -sf "/usr/share/zoneinfo/$1" /etc/localtime; }
sys_tz()   { if [ -n "$TR" ]; then cat "$TR/localtime"; else readlink /etc/localtime | sed 's#.*/zoneinfo/##'; fi; }
# 自动设置时区：1 开 / 0 关
tz_auto()  { if [ -n "$TR" ]; then cat "$TR/tzauto" 2>/dev/null || echo 1; else defaults read /Library/Preferences/com.apple.timezone.auto Active 2>/dev/null || echo 1; fi; }
tz_auto_off() { if [ -n "$TR" ]; then echo "disable auto timezone" >>"$TR/sys.log"; [ -f "$TR/tzauto_stuck" ] || echo 0 >"$TR/tzauto"; return 0; fi
             sudo defaults write /Library/Preferences/com.apple.timezone.auto Active -bool false; }
# 系统首选语言（第一位）和地区
sys_lang() { if [ -n "$TR" ]; then head -1 "$TR/lang" 2>/dev/null; else defaults read -g AppleLanguages 2>/dev/null | sed -n 2p | tr -d ' ",'; fi; }
sys_locale() { if [ -n "$TR" ]; then cat "$TR/locale" 2>/dev/null; else defaults read -g AppleLocale 2>/dev/null; fi; }
set_lang() { # 英语放第一位，原来的其他语言按原顺序保留（输入法不受影响）
  if [ -n "$TR" ]; then
    echo "set language en-US" >>"$TR/sys.log"
    { echo en-US; grep -vxE 'en-US|en' "$TR/lang" 2>/dev/null; } >"$TR/lang.new"; mv "$TR/lang.new" "$TR/lang"
    echo en_US >"$TR/locale"; return 0
  fi
  local rest=() l
  while IFS= read -r l; do l=$(printf '%s' "$l" | tr -d ' ",'); case "$l" in ''|'('|')'|en-US|en) ;; *) rest+=("$l");; esac; done < <(defaults read -g AppleLanguages 2>/dev/null)
  defaults write -g AppleLanguages -array en-US ${rest[@]+"${rest[@]}"}
  defaults write -g AppleLocale -string en_US
}
# 浏览器语言：Chromium 系和 Firefox 各存一份自己的语言列表，不跟系统走（Safari 跟系统）
# 显示名|App 名|进程名|数据目录（相对 ~/Library/Application Support）；Firefox 单独处理
BROWSERS="Chrome|Google Chrome|Google Chrome|Google/Chrome
Edge|Microsoft Edge|Microsoft Edge|Microsoft Edge
Brave|Brave Browser|Brave Browser|BraveSoftware/Brave-Browser
Arc|Arc|Arc|Arc/User Data
Chromium|Chromium|Chromium|Chromium
Vivaldi|Vivaldi|Vivaldi|Vivaldi
Firefox|Firefox|firefox|Firefox/Profiles"
# 英语排第一，原来的其他语言按原顺序留在后面（网页翻译等不受影响）
EN_LANGS_JS='function en(v){return ["en-US","en"].concat(String(v||"").split(",").map(function(x){return x.trim()}).filter(function(x){return x&&x!=="en-US"&&x!=="en"})).join(",")}'
jread() { osascript -l JavaScript -e 'function run(a){var s=$.NSString.stringWithContentsOfFileEncodingError(a[0],$.NSUTF8StringEncoding,null);if(!s)return "";var v;try{v=new Function("o",a[1])(JSON.parse(s.js))}catch(e){v=null}return (v===undefined||v===null)?"":String(v)}' "$1" "$2" 2>/dev/null; }
browser_profiles() { # 数据目录 -> 每个用户资料的语言设置文件（Chromium：Preferences；Firefox：prefs.js）
  local d="$HOME/Library/Application Support/$1"
  [ -d "$d" ] || return 0
  case "$1" in Firefox/*) find "$d" -mindepth 2 -maxdepth 2 -name prefs.js 2>/dev/null ;;
    *) find "$d" -mindepth 2 -maxdepth 2 -name Preferences 2>/dev/null | grep -v '/System Profile/' ;; esac
}
browser_lang_ok() { # 设置文件 -> 0 表示英语已排第一；新版 Chrome 以 selected_languages 为准，旧版只有 accept_languages
  case "$1" in
    */prefs.js) grep -qE '^user_pref\("intl\.accept_languages", "en-US, en' "$(dirname "$1")/user.js" 2>/dev/null ;;
    *) [ "$(jread "$1" 'var i=o.intl||{},v=i.selected_languages!==undefined?i.selected_languages:i.accept_languages;return /^en(-US)?(,|$)/.test(v||"")')" = true ] ;;
  esac
}
set_browser_lang() { # 设置文件（浏览器必须已退出，否则它退出时会写回旧值）
  case "$1" in
    */prefs.js)
      local cur u; u="$(dirname "$1")/user.js"
      cur=$(sed -nE 's/^user_pref\("intl\.accept_languages", "([^"]*)"\);.*/\1/p' "$1" 2>/dev/null | tail -1)
      [ -f "$u" ] && sed -i '' '/^user_pref("intl\.accept_languages"/d' "$u"
      printf 'user_pref("intl.accept_languages", "%s");\n' "$(osascript -l JavaScript -e "$EN_LANGS_JS"'
function run(a){return en(a[0]).split(",").join(", ")}' "$cur")" >>"$u" ;;
    *) cp "$1" "$1.backup-claude-env-$TS"
       jedit "$1" "$EN_LANGS_JS"'
o.intl=o.intl||{};var v=en(o.intl.selected_languages||o.intl.accept_languages);o.intl.selected_languages=v;o.intl.accept_languages=v;' ;;
  esac
}
browser_bad() { # 输出语言还不是英语优先的浏览器（显示名）
  printf '%s\n' "$BROWSERS" | while IFS='|' read -r n a p d; do
    browser_profiles "$d" | while IFS= read -r f; do browser_lang_ok "$f" || { echo "$n"; break; }; done
  done
}
fix_browser_langs() {
  local n a p d f reopen="" left=""
  while IFS='|' read -r n a p d <&3; do
    [ -n "$(browser_profiles "$d")" ] || continue
    if ! browser_profiles "$d" | while IFS= read -r f; do browser_lang_ok "$f" || exit 1; done; then
      if proc_running "$p"; then
        printf '  正在关闭 %s 来改它的语言（改完自动重新打开）\n' "$n"
        sysrun osascript -e "quit app \"$a\"" 2>/dev/null
        if [ -n "$TR" ]; then [ -f "$TR/browser_stuck" ] || sed -i '' "/^${p}\$/d" "$TR/procs"; else for _ in $(seq 1 15); do pgrep -xq "$p" || break; sleep 1; done; fi
        if proc_running "$p"; then left="${left:+$left、}$n"; continue; fi
        reopen="$reopen|$a"
      fi
      browser_profiles "$d" | while IFS= read -r f; do browser_lang_ok "$f" || set_browser_lang "$f"; done
      c_ok "${n}：网页语言改成英语优先（原来的语言保留在后面）"
    fi
  done 3<<<"$BROWSERS"
  # Safari 跟系统语言走，要重开才读到新的系统语言
  if proc_running Safari; then sysrun osascript -e 'quit app "Safari"' 2>/dev/null; [ -n "$TR" ] && sed -i '' '/^Safari$/d' "$TR/procs"; reopen="$reopen|Safari"; fi
  [ -n "$left" ] && c_warn "这些浏览器没能自动关闭，语言没改：${left}。请手动退出后重新运行本命令"
  printf '%s\n' "$reopen" | tr '|' '\n' | while IFS= read -r a; do [ -n "$a" ] && sysrun open -a "$a"; done
  return 0
}
# 定位服务总开关：true 开 / false 关（直接问系统，不需要权限）
loc_on() { if [ -n "$TR" ]; then cat "$TR/location" 2>/dev/null || echo true; return; fi
           osascript -l JavaScript -e 'ObjC.import("CoreLocation");ObjC.bindFunction("objc_msgSend",["bool",["id","SEL"]]);String($.objc_msgSend($.CLLocationManager,"locationServicesEnabled"))' 2>/dev/null; }
sys_services() { if [ -n "$TR" ]; then echo "networksetup -listallnetworkservices" >>"$TR/sys.log"; printf 'Wi-Fi\n'; else networksetup -listallnetworkservices | tail -n +2 | grep -v '^\*'; fi; }
verge_version() { if [ -n "$TR" ]; then cat "$TR/verge_version" 2>/dev/null; else defaults read "/Applications/Clash Verge.app/Contents/Info" CFBundleShortVersionString 2>/dev/null; fi; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]; }
# 只在沙箱里加速等待；客户运行照常等待。
if [ -n "$TR" ] && [ "${CE_TEST_FAST:-}" = 1 ]; then sleep() { :; }; fi
# 其他常见 Mac 代理软件：「显示名|App 名|进程名」。它们无法可靠地自动配置链式代理，检测到就引导迁移到 Clash Verge Rev
OTHER_CLIENTS="ClashX Meta|ClashX Meta.app|ClashX Meta
ClashX|ClashX.app|ClashX
ClashX Pro|ClashX Pro.app|ClashX Pro
Clash Party|Clash Party.app|Clash Party
Mihomo Party|Mihomo Party.app|Mihomo Party
FlClash|FlClash.app|FlClash
Clash Nyanpasu|Clash Nyanpasu.app|Clash Nyanpasu
Clash for Windows|Clash for Windows.app|Clash for Windows
Stash|Stash.app|Stash
Surge|Surge.app|Surge
Shadowrocket|Shadowrocket.app|Shadowrocket
Quantumult X|Quantumult X.app|Quantumult X
Loon|Loon.app|Loon
sing-box (SFM)|SFM.app|SFM
Hiddify|Hiddify.app|Hiddify
Karing|Karing.app|Karing
V2rayU|V2rayU.app|V2rayU
v2rayN|v2rayN.app|v2rayN
V2Box|V2Box.app|V2Box
NekoRay|nekoray.app|nekoray"
APPS_DIR="/Applications"; [ -n "$TR" ] && APPS_DIR="$TR/Applications"
proc_running() { if [ -n "$TR" ]; then grep -qxF "$1" "$TR/procs" 2>/dev/null; else pgrep -xq "$1"; fi; }
installed_others() { printf '%s\n' "$OTHER_CLIENTS" | while IFS='|' read -r n a p; do { [ -d "$APPS_DIR/$a" ] || [ -d "$HOME/Applications/$a" ]; } && echo "$n"; done; }
running_others()   { printf '%s\n' "$OTHER_CLIENTS" | while IFS='|' read -r n a p; do proc_running "$p" && echo "$n|$a"; done; }
urlenc() { osascript -l JavaScript -e 'function run(a){return encodeURIComponent(a[0])}' "$1"; }
trace_ip() { awk -F= '/^ip=/{print $2}'; }
# 不经过任何代理设置直接请求：只有 TUN 接管了系统流量，才会从专属 IP 出去
dtrace() { env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy curl -s -m 15 --noproxy '*' "$@"; }
# ===== 迁移：没装 Clash Verge Rev → 自动安装 + 搬订阅 + 关旧软件 =====
# 自动安装的 Clash Verge Rev：官方 GitHub 固定版本 + SHA-256（发布满两周的稳定版）
VERGE_VER="2.5.8"
VERGE_UA="clash-verge/v${VERGE_VER}"
VERGE_URL="https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v${VERGE_VER}/"
if [ "$(uname -m)" = arm64 ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  V_ASSET="Clash.Verge_${VERGE_VER}_aarch64.dmg"; V_SUM=1f7c3a73970f103fc3cb9944744772fa1540160f05911e033ffc57f7c9f860ec
else
  V_ASSET="Clash.Verge_${VERGE_VER}_x64.dmg"; V_SUM=8cdf7a01a1c548a081339aff21b2599d60f67730d05485e90831f4bbdbf3b093
fi
VERGE_APP="$APPS_DIR/Clash Verge.app"
# 原来代理软件带的内核进程（退出时一起关）
OTHER_CORES="FlClash|FlClashCore
Clash Party|mihomo mihomo-alpha mihomo-smart
Mihomo Party|mihomo mihomo-alpha mihomo-smart
Clash Nyanpasu|mihomo mihomo-alpha clash-rs
Clash for Windows|clash-darwin
v2rayN|xray v2ray sing-box mihomo
Hiddify|HiddifyCli hiddify-core
NekoRay|nekobox_core nekoray_core"
thook() { [ -n "$TR" ] && [ -n "${CE_TEST_HOOK:-}" ] || return 0; "$CE_PYTHON" "$CE_TEST_HOOK" "$@" >/dev/null 2>&1; }
# ===== 虚拟网卡（TUN）要用 Clash Verge 的「服务模式」：没装就用 Clash Verge 自带的安装程序装上 =====
# 和 Clash Verge 2.5.8 设置里点「安装服务模式」完全一样：App 里自带的 clash-verge-service-install --prepare-install，
# 带上 App 自带的两个内核；我们已经有管理员权限（sudo），所以它直接安装，不再弹密码框。
SVC_ID="io.github.clash-verge-rev.clash-verge-rev.service"   # 2.5 起的服务（launchd）
SVC_OLD_ID="io.github.clashverge.helper"                      # 更早版本的服务
SVC_MIN="2.5.8"                                               # 自动安装只用在我们验证过的版本上
SVC_LOG=""
verge_app_dir() { local a; for a in "$VERGE_APP" "$HOME/Applications/Clash Verge.app"; do [ -d "$a" ] && { echo "$a"; return 0; }; done; return 1; }
lc_running() { { launchctl print "system/$1" 2>/dev/null || sudo -n launchctl print "system/$1" 2>/dev/null; } | grep -qE '^[[:space:]]*state = running'; }
svc_state() { # running | stopped | none
  if [ -n "$TR" ]; then cat "$TR/service" 2>/dev/null || echo none; return 0; fi
  local id found=""
  for id in "$SVC_ID" "$SVC_OLD_ID"; do
    [ -e "/Library/LaunchDaemons/$id.plist" ] || continue
    found=1; lc_running "$id" && { echo running; return 0; }
  done
  # 读不到 launchd 状态时，以服务的控制接口在不在为准
  [ -n "$found" ] && [ -S /var/run/clash-verge-service/service.sock ] && { echo running; return 0; }
  [ -n "$found" ] && echo stopped || echo none
}
# 限时运行（macOS 没有 timeout 命令）：超时就结束它，返回 124
run_bounded() {
  local secs=$1 pid i=0; shift
  "$@" & pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge "$secs" ]; then kill "$pid" 2>/dev/null; sudo -n pkill -f 'clash-verge-service-install' 2>/dev/null; wait "$pid" 2>/dev/null; return 124; fi
    sleep 1; i=$((i + 1))
  done
  wait "$pid"
}
svc_install() {
  if [ -n "$TR" ]; then sudo_once; echo "install clash verge service" >>"$TR/sys.log"; thook service-install; return; fi
  local app res inst c gid args=()
  app=$(verge_app_dir) || return 1
  res="$app/Contents/Resources/resources"; inst="$res/clash-verge-service-install"
  [ -x "$inst" ] && [ -f "$res/clash-verge-service" ] || return 1
  for c in verge-mihomo verge-mihomo-alpha; do [ -f "$app/Contents/MacOS/$c" ] && args+=(--core "$c" "$app/Contents/MacOS/$c"); done
  [ "${#args[@]}" -gt 0 ] || return 1
  sudo_once || return 1
  gid=$(id -g)
  mkdir -p "$HOME/.claude-env-backup"; SVC_LOG="$HOME/.claude-env-backup/service-install-$TS.log"
  # cd / 与 Clash Verge 自己一样（避开隐私保护的目录）；CLASH_VERGE_SERVICE_GID = 当前用户的组，Clash Verge 才连得上服务
  ( cd / && run_bounded 180 sudo -n env CLASH_VERGE_SERVICE_GID="$gid" "$inst" --prepare-install --ensure --gid "$gid" --prompt "Clash Verge" "${args[@]}" ) >"$SVC_LOG" 2>&1 || return 1
  for _ in $(seq 1 15); do [ "$(svc_state)" = running ] && return 0; sleep 1; done
  return 1
}
# 结果放在 SVC_OK：1 = 服务模式在运行（能开 TUN）
SVC_OK=""
ensure_service() {
  local st; st=$(svc_state)
  if [ "$st" = running ]; then SVC_OK=1; c_ok "Clash Verge 服务模式已在运行（虚拟网卡要用它）"; return 0; fi
  local vv; vv=$(verge_version)
  if [ -z "$vv" ] || ! ver_ge "$vv" "$SVC_MIN"; then
    c_warn "Clash Verge ${vv:-版本未知} 不能自动安装「服务模式」（需要 ${SVC_MIN} 及以上），先不开虚拟网卡（TUN），网络照常可用"
    return 1
  fi
  printf '  正在安装 Clash Verge 的「服务模式」（虚拟网卡要用它；和在 Clash Verge 设置里点「安装服务模式」一样，大约半分钟）…\n'
  if svc_install; then SVC_OK=1; c_ok "Clash Verge 服务模式已安装并在运行"; return 0; fi
  c_warn "Clash Verge 服务模式没装上，先不开虚拟网卡（TUN），网络照常可用${SVC_LOG:+（安装记录：${SVC_LOG/#$HOME/~}）}"
  return 1
}
verge_present() { [ -d "$VERGE_APP" ] || [ -d "$HOME/Applications/Clash Verge.app" ] || [ -f "$CV_CFG" ]; }
# 订阅链接只显示到域名，后面的路径和参数（含令牌）一律打码
mask_url() { printf '%s' "$1" | sed -E 's#^(https?://)([^@/?#]*@)?([^/?#]+).*#\1\3/***#'; }
SUDO_READY=""
sudo_once() { # 需要管理员权限的几步共用一次密码：输一次，后台保持到脚本结束
  [ -n "$SUDO_READY" ] && return 0
  if [ -n "$TR" ]; then echo "sudo -v" >>"$TR/sys.log"; SUDO_READY=1; return 0; fi
  sudo -n true 2>/dev/null || printf '  接下来需要输入一次开机密码（输入时不显示）\n'
  sudo -v || return 1
  SUDO_READY=1
  ( while kill -0 $$ 2>/dev/null; do sudo -n -v 2>/dev/null; sleep 50; done ) >/dev/null 2>&1 &
}
# 读 YAML 列表（items: / files:）：输出「I<Tab>id<Tab>type<Tab>url」每项一行，顶层简单字段输出「T<Tab>键<Tab>值」
YLIST_AWK='
function unq(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s)
  if (length(s) >= 2 && s ~ /^\047.*\047$/) { s = substr(s, 2, length(s) - 2); gsub(/\047\047/, "\047", s); return s }
  if (length(s) >= 2 && s ~ /^".*"$/) return substr(s, 2, length(s) - 2)
  sub(/[ \t]+#.*$/, "", s); return s }
function flush() { if (have) print "I\t" id "\t" ty "\t" url; have = 0; id = ""; ty = ""; url = "" }
function setk(k, v) { v = unq(v); if (k == "uid" || k == "id") id = v; else if (k == "type") ty = v; else if (k == "url") url = v }
BEGIN { ind = -1 }
{ sub(/\r$/, "") }
/^[ \t]*(#|$)/ { next }
/^[A-Za-z_][A-Za-z0-9_-]*:/ { flush(); k = $0; sub(/:.*/, "", k); v = $0; sub(/^[^:]*:/, "", v); v = unq(v)
  inl = (k == LK); lastk = k; pend = (v == ""); if (!inl && v != "") print "T\t" k "\t" v; next }
!inl { if (pend && match($0, /^[ \t]*- /)) { print "T\t" lastk "\t" unq(substr($0, RLENGTH + 1)); pend = 0 } next }
match($0, /^ *- /) { i = RLENGTH - 2
  if (ind < 0 || i == ind) { if (ind < 0) ind = i; flush(); have = 1; rest = substr($0, RLENGTH + 1)
    if (match(rest, /^[A-Za-z0-9_-]+:/)) setk(substr(rest, 1, RLENGTH - 1), substr(rest, RLENGTH + 1)); next } }
have { match($0, /^ */); if (RLENGTH == ind + 2) { kv = substr($0, RLENGTH + 1); if (kv ~ /^[A-Za-z0-9_-]+:/) { k = kv; sub(/:.*/, "", k); v = kv; sub(/^[^:]*:/, "", v); setk(k, v) } } }
END { flush() }'
ylist() { [ -f "$1" ] && awk -v LK="$2" "$YLIST_AWK" "$1"; }
# 只读查询 SQLite：先复制到临时目录再读，原文件不动；列之间用 Tab 分隔
sqlrows() {
  [ -f "$1" ] || return 0
  local d; d=$(mktemp -d)
  cp "$1" "$d/db" 2>/dev/null && { for x in -wal -shm; do [ -f "$1$x" ] && cp "$1$x" "$d/db$x"; done; sqlite3 -separator "$(printf '\t')" "$d/db" "$2" 2>/dev/null; }
  rm -rf "$d"
}
# ---- 从其他代理软件的本地配置里找订阅（只读）：每行「是否正在使用<Tab>链接」----
read_flclash() { # FlClash：新版订阅在 database.sqlite 的 profiles 表，旧版在偏好设置的 config 里；正在用的是 currentProfileId
  local d="$HOME/Library/Application Support/com.follow.clash" pl="$HOME/Library/Preferences/com.follow.clash.plist" cfg="" rows
  if [ -f "$pl" ]; then
    cfg=$(plutil -extract flutter.config raw -o - "$pl" 2>/dev/null) || cfg=""
    [ -n "$cfg" ] || cfg=$(jget "$(plutil -convert json -o - "$pl" 2>/dev/null)" 'o["flutter.config"]')
  fi
  [ -n "$cfg" ] && jget "$cfg" 'return (o.profiles||[]).filter(function(p){return p.url}).map(function(p){return String(p.id)+"\t"+p.url}).join("\n")'
  rows=$(sqlrows "$d/database.sqlite" "SELECT id, url FROM profiles WHERE type = 'url' ORDER BY \"order\"")
  [ -n "$rows" ] || rows=$(sqlrows "$d/database.sqlite" "SELECT id, url FROM profiles WHERE type = 'url'")
  [ -n "$rows" ] && printf '%s\n' "$rows"
} 2>/dev/null
mark_cur() { # 第 1 列是 id，换成「是否正在使用」
  awk -F'\t' -v C="$1" 'NF >= 2 { print ((C != "" && ($1 "") == (C "")) ? 1 : 0) "\t" $2 }'
}
read_yaml_client() { # file listkey curkey
  [ -f "$1" ] || return 0
  ylist "$1" "$2" | awk -F'\t' -v CK="$3" '
    $1 == "T" && $2 == CK { cur = $3; next }
    $1 == "I" { n++; id[n] = $2; ty[n] = $3; url[n] = $4 }
    END { for (i = 1; i <= n; i++) if (url[i] != "" && (ty[i] == "" || ty[i] == "remote")) {
            c = (CK == "index") ? (cur != "" && i - 1 == cur + 0) : (cur != "" && (id[i] "") == (cur "")); print (c ? 1 : 0) "\t" url[i] } }'
}
read_v2rayn() {
  local d g cur
  for d in "$HOME/.local/share/v2rayN" "$HOME/Library/Application Support/v2rayN"; do
    g="$d/guiConfigs"; [ -d "$g" ] || continue
    cur=$( [ -f "$g/guiNConfig.json" ] && jget "$(cat "$g/guiNConfig.json")" 'o.SubIndexId' )
    sqlrows "$g/guiNDB.db" "SELECT Id, Url FROM SubItem WHERE Enabled = 1 ORDER BY Sort" | mark_cur "$cur"
  done
}
find_subs() { # 输出「排序<Tab>软件<Tab>是否正在使用<Tab>链接」，正在运行的软件、正在使用的订阅排前面，去重
  local n p run
  {
    { read_flclash | mark_cur "$(flclash_cur)"; } | sed "s/^/FlClash	/"
    read_yaml_client "$HOME/.config/clash/profiles/list.yml" files index | sed "s/^/Clash for Windows	/"
    read_yaml_client "$HOME/Library/Application Support/mihomo-party/profile.yaml" items current | sed "s/^/Clash Party	/"
    for p in "$HOME/.config/clash-nyanpasu" "$HOME/.config/Clash Nyanpasu" "$HOME/Library/Application Support/Clash Nyanpasu" "$HOME/Library/Application Support/clash-nyanpasu"; do
      read_yaml_client "$p/profiles.yaml" items current | sed "s/^/Clash Nyanpasu	/"
    done
    read_v2rayn | sed "s/^/v2rayN	/"
  } | while IFS="$(printf '\t')" read -r n c u; do
    printf '%s\n' "$u" | grep -qE '^https?://[^[:space:]]+$' || continue
    run=2; printf '%s\n' "$OTHER_CLIENTS" | grep -F "$n|" | head -1 | { IFS='|' read -r _ _ pr; proc_running "$pr"; } && run=0
    printf '%s\t%s\t%s\t%s\n' "$((run + 1 - c))" "$n" "$c" "$u"
  done | awk -F'\t' '!seen[$4]++' | sort -t "$(printf '\t')" -k1,1n -s
}
flclash_cur() {
  local pl="$HOME/Library/Preferences/com.follow.clash.plist" cfg
  [ -f "$pl" ] || return 0
  cfg=$(plutil -extract flutter.config raw -o - "$pl" 2>/dev/null) || cfg=$(jget "$(plutil -convert json -o - "$pl" 2>/dev/null)" 'o["flutter.config"]')
  printf '%s' "$cfg" | grep -oE '"currentProfileId" *: *"?[^",} ]+' | head -1 | sed -E 's/.*: *"?//'
}
# 原来的代理软件开着的本机端口：优先看系统代理设置，再试常见端口。下载订阅和安装包时先走它（国内直连 GitHub 常常很慢）
np_get() { # kind service
  if [ -n "$TR" ]; then cat "$TR/np_$1" 2>/dev/null || printf 'Enabled: No\n'; else networksetup "-get$1" "$2" 2>/dev/null; fi; }
np_field() { awk -F': ' -v K="$1" '$1 == K { print $2; exit }'; }
find_old_proxy() {
  local ports="" svc out p
  while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    out=$(np_get webproxy "$svc")
    [ "$(printf '%s\n' "$out" | np_field Enabled)" = Yes ] && printf '%s\n' "$out" | np_field Server | grep -qE '^(127\.0\.0\.1|localhost)$' && ports="$ports $(printf '%s\n' "$out" | np_field Port)"
  done < <(sys_services)
  for p in $ports 7890 7891 10809 7897 1080; do
    curl -s -m 5 -o /dev/null -x "http://127.0.0.1:$p" https://www.google.com/generate_204 && { echo "http://127.0.0.1:$p"; return 0; }
  done
  return 0
}
OLDPX=""
routes() { [ -n "$OLDPX" ] && echo "$OLDPX"; echo direct; }
# 用 Clash Verge 的身份下载订阅（机场按这个返回 Clash 格式）；链接通过标准输入交给 curl，不出现在命令行里
fetch_sub() { # url outfile
  local r code esc
  esc=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
  for r in $(routes); do
    if [ "$r" = direct ]; then code=$(printf 'url = "%s"\n' "$esc" | curl -s -L -m 30 -A "$VERGE_UA" --noproxy '*' -o "$2" -w '%{http_code}' -K -)
    else code=$(printf 'url = "%s"\n' "$esc" | curl -s -L -m 30 -A "$VERGE_UA" -x "$r" -o "$2" -w '%{http_code}' -K -); fi
    case "$code" in 2*) ;; *) continue ;; esac
    LC_ALL=C sed -i '' $'1s/^\xef\xbb\xbf//' "$2" 2>/dev/null
    grep -qE '^(proxies|proxy-providers):' "$2" && return 0
  done
  return 1
}
manual_fallback() {
  c_err "$1"
  local others; others=$(installed_others | paste -sd '、' -)
  [ -n "$others" ] && printf '  检测到你在用：%s。需要换成 Clash Verge Rev（免费开源），请按下面手动装一下：\n' "$others"
  printf '  1. 已为你打开下载页：M 芯片下载 aarch64.dmg，Intel 下载 x64.dmg，装好打开\n'
  if [ -n "$ROUTER" ]; then
    printf '  2. 装好后打开 Clash Verge Rev 一次，退出，然后重新运行本命令，看到提问时再输入 R（梯子在路由器上不需要订阅）\n'
  else
    printf '  2. 在 Clash Verge Rev「订阅」里粘贴你的订阅链接（机场官网或原软件的订阅设置里能找到），选中它\n'
    printf '  3. 退出原来的代理软件，确认能打开 google.com 后，重新运行本命令\n'
  fi
  sysrun open "https://github.com/clash-verge-rev/clash-verge-rev/releases/latest"
  exit 3
}
install_verge() {
  printf '  正在下载 Clash Verge Rev %s（约 85MB，来自官方 GitHub；网络慢的话要几分钟，请稍等）…\n' "$VERGE_VER"
  if [ -n "$TR" ]; then echo "download $V_ASSET" >>"$TR/sys.log"; thook download || return 1; echo "install $V_ASSET" >>"$TR/sys.log"; thook install; return; fi
  local d f r ok="" app
  d=$(mktemp -d); f="$d/$V_ASSET"
  for r in $(routes) $(routes); do   # 每条路各试两轮（GitHub 偶尔会临时出错）
    rm -f "$f"
    if [ "$r" = direct ]; then curl -fsSL --retry 2 -m 900 --noproxy '*' -o "$f" "$VERGE_URL$V_ASSET"; else curl -fsSL --retry 2 -m 900 -x "$r" -o "$f" "$VERGE_URL$V_ASSET"; fi
    [ -f "$f" ] && [ "$(shasum -a 256 "$f" | awk '{print $1}')" = "$V_SUM" ] && ok=1 && break
    sleep 3
  done
  [ -n "$ok" ] || { rm -rf "$d"; return 1; }
  c_ok "下载完成，文件校验通过（SHA-256 与官方发布一致）"
  printf '  正在安装到「应用程序」…\n'
  mkdir "$d/mnt"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$d/mnt" "$f" >/dev/null 2>&1 || { rm -rf "$d"; return 1; }
  app=$(find "$d/mnt" -maxdepth 1 -name '*.app' | head -1)
  if [ -n "$app" ]; then
    if [ -w "$APPS_DIR" ]; then rm -rf "$VERGE_APP" && ditto "$app" "$VERGE_APP"
    else sudo_once && sudo rm -rf "$VERGE_APP" && sudo ditto "$app" "$VERGE_APP"; fi
  fi
  hdiutil detach "$d/mnt" -quiet 2>/dev/null || hdiutil detach "$d/mnt" -force -quiet 2>/dev/null
  rm -rf "$d"
  [ -d "$VERGE_APP" ] || return 1
  # 只去掉这个 App 的「来自网络」隔离标记，免得第一次打开被拦
  xattr -dr com.apple.quarantine "$VERGE_APP" 2>/dev/null || { sudo_once && sudo xattr -dr com.apple.quarantine "$VERGE_APP" 2>/dev/null; }
  return 0
}
start_verge() { if [ -n "$TR" ]; then echo "open Clash Verge" >>"$TR/sys.log"; thook verge-start; else open "$VERGE_APP" 2>/dev/null || open -a "Clash Verge"; fi; }
stop_verge() {
  sysrun osascript -e 'quit app "Clash Verge"' 2>/dev/null
  [ -n "$TR" ] && return 0
  for _ in $(seq 1 15); do pgrep -f 'Clash Verge.app/Contents/MacOS/' >/dev/null || break; sleep 1; done
  pgrep -f 'Clash Verge.app/Contents/MacOS/' >/dev/null || return 0
  pkill -f 'Clash Verge.app/Contents/MacOS/' 2>/dev/null; sleep 2; pkill -x verge-mihomo 2>/dev/null; pkill -x verge-mihomo-alpha 2>/dev/null
}
wait_ctl() { local end=$((SECONDS + $1)); while [ "$SECONDS" -lt "$end" ]; do [ -f "$CV_CFG" ] && find_ctl && return 0; sleep 2; done; return 1; }
quit_old() { # 显示名|App 名|进程名：先正常退出，再结束进程（连同它的内核）
  local n=$1 a=$2 p=$3 c
  sysrun osascript -e "quit app \"${a%.app}\"" 2>/dev/null
  if [ -n "$TR" ]; then sed -i '' "/^${p}\$/d" "$TR/procs"; return 0; fi
  for _ in 1 2 3 4 5; do pgrep -xq "$p" || break; sleep 1; done
  pkill -x "$p" 2>/dev/null
  for c in $(printf '%s\n' "$OTHER_CORES" | grep -F "$n|" | head -1 | cut -d'|' -f2); do pkill -x "$c" 2>/dev/null || sudo -n pkill -x "$c" 2>/dev/null; done
  return 0
}
# 系统代理还指向本机别的端口（原来的软件），就关掉，不然它退出后浏览器上不了网
reset_sys_proxy() { # keep_port -> 输出关掉的「网络 类型」
  local svc kind out
  while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    for kind in webproxy securewebproxy socksfirewallproxy; do
      out=$(np_get "$kind" "$svc")
      [ "$(printf '%s\n' "$out" | np_field Enabled)" = Yes ] || continue
      printf '%s\n' "$out" | np_field Server | grep -qE '^(127\.0\.0\.1|localhost|::1)$' || continue
      [ "$(printf '%s\n' "$out" | np_field Port)" = "$1" ] && continue
      if [ -n "$TR" ]; then echo "networksetup -set${kind}state $svc off" >>"$TR/sys.log"; printf 'Enabled: No\n' >"$TR/np_$kind"
      else sudo_once && sudo networksetup "-set${kind}state" "$svc" off; fi
      echo "$svc $kind"
    done
  done < <(sys_services)
}
has_current_profile() { [ -n "$(ylist "$CV_DIR/profiles.yaml" items | awk -F'\t' '$1 == "T" && $2 == "current" && $3 != "null" && $3 != "~" { print $3 }')" ]; }
# 先读有限的随机字节再筛（不能让 tr 无限读 /dev/urandom：父进程忽略 SIGPIPE 时它永远停不下来）
new_uid() { printf '%s%s' "$1" "$(head -c 400 /dev/urandom | LC_ALL=C tr -dc '0-9a-zA-Z' | cut -c1-11)"; }
yq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }
# 按 Clash Verge 自己导入订阅的方式写入：订阅文件 + 它配套的 5 个增强项，加进 profiles.yaml 并设为当前订阅
import_sub() { # url content_file name [local]：local = 本地配置（软路由模式，没有订阅链接）
  local pd="$CV_DIR/profiles" uid now m s r p g ef pf="$CV_DIR/profiles.yaml" k T
  mkdir -p "$pd"
  uid=$(new_uid R); now=$(date +%s); m=$(new_uid m); s=$(new_uid s); r=$(new_uid r); p=$(new_uid p); g=$(new_uid g)
  cp "$2" "$pd/$uid.yaml"
  printf '# Profile Enhancement Merge Template for Clash Verge\n\n' >"$pd/$m.yaml"
  printf '// Define main function (script entry)\n\nfunction main(config, profileName) {\n  return config;\n}\n' >"$pd/$s.js"
  for k in "Rules $r" "Proxies $p" "Groups $g"; do
    printf '# Profile Enhancement %s Template for Clash Verge\n\nprepend: []\n\nappend: []\n\ndelete: []\n' "${k% *}" >"$pd/${k#* }.yaml"
  done
  ef=$(mktemp)
  {
    if [ "${4:-}" = local ]; then
      printf -- '- uid: %s\n  type: local\n  name: %s\n  file: %s.yaml\n  updated: %s\n' "$uid" "$(yq "$3")" "$uid" "$now"
      printf '  option:\n    merge: %s\n    script: %s\n    rules: %s\n    proxies: %s\n    groups: %s\n' "$m" "$s" "$r" "$p" "$g"
    else
      printf -- '- uid: %s\n  type: remote\n  name: %s\n  file: %s.yaml\n  url: %s\n  updated: %s\n' "$uid" "$(yq "$3")" "$uid" "$(yq "$1")" "$now"
      printf '  option:\n    update_interval: 1440\n    allow_auto_update: true\n    merge: %s\n    script: %s\n    rules: %s\n    proxies: %s\n    groups: %s\n' "$m" "$s" "$r" "$p" "$g"
    fi
    printf -- '- uid: %s\n  type: merge\n  file: %s.yaml\n  updated: %s\n' "$m" "$m" "$now"
    printf -- '- uid: %s\n  type: script\n  file: %s.js\n  updated: %s\n' "$s" "$s" "$now"
    printf -- '- uid: %s\n  type: rules\n  file: %s.yaml\n  updated: %s\n' "$r" "$r" "$now"
    printf -- '- uid: %s\n  type: proxies\n  file: %s.yaml\n  updated: %s\n' "$p" "$p" "$now"
    printf -- '- uid: %s\n  type: groups\n  file: %s.yaml\n  updated: %s\n' "$g" "$g" "$now"
    # 全局的 Merge / Script 两项：Clash Verge 第一次启动时 profiles.yaml 还是空的就不会补上，没有它们全局扩展脚本（Script.js）不生效
    if ! grep -qE '^[[:space:]]*- uid: Merge[[:space:]]*$' "$pf" 2>/dev/null; then
      printf -- '- uid: Merge\n  type: merge\n  file: Merge.yaml\n  updated: %s\n' "$now"
      [ -f "$pd/Merge.yaml" ] || printf '# Profile Enhancement Merge Template for Clash Verge\n\nprofile:\n  store-selected: true\n' >"$pd/Merge.yaml"
    fi
    if ! grep -qE '^[[:space:]]*- uid: Script[[:space:]]*$' "$pf" 2>/dev/null; then
      printf -- '- uid: Script\n  type: script\n  file: Script.js\n  updated: %s\n' "$now"
      [ -f "$pd/Script.js" ] || printf '// Define main function (script entry)\n\nfunction main(config, profileName) {\n  return config;\n}\n' >"$pd/Script.js"
    fi
  } >"$ef"
  [ -f "$pf" ] && cp "$pf" "$pf.backup-claude-env-$TS"
  { [ -f "$pf" ] && cat "$pf"; true; } | awk -v U="$uid" -v EF="$ef" '
    BEGIN { while ((getline l < EF) > 0) E[++ne] = l; pre = "-" }
    function emit(  j, p) { p = (pre == "-") ? "" : pre; for (j = 1; j <= ne; j++) print p E[j]; done = 1 }
    { sub(/\r$/, "") }
    inl && !done && /^[^ \t#-]/ { emit(); inl = 0 }
    /^current:/ { print "current: " U; cur = 1; skipc = 1; next }
    skipc && /^- / { next }
    { skipc = 0 }
    /^items:/ { print "items:"; inl = 1; seen = 1; next }
    inl && pre == "-" && match($0, /^ *- /) { pre = substr($0, 1, RLENGTH - 2) }
    /^[ \t]*$/ { blank++; next }
    { while (blank > 0) { print ""; blank-- } print }
    END { if (!done) { if (!seen) print "items:"; emit() } if (!cur) print "current: " U }' >"$pf.new" && mv "$pf.new" "$pf"
  rm -f "$ef"
}
# 订阅里的节点名（proxies: 下面每项的 name），每行一个
sub_names() { awk '/^proxies:/ { f = 1; next } /^[^ \t-]/ { f = 0 }
  f && match($0, /^[ \t]*-[ \t]*\{?[ \t]*name:[ \t]*/) { v = substr($0, RLENGTH + 1)
    if (v ~ /^"/) { sub(/^"/, "", v); sub(/".*/, "", v) } else if (v ~ /^\047/) { sub(/^\047/, "", v); sub(/\047.*/, "", v) } else { sub(/[,}].*/, "", v) }
    sub(/[ \t]+$/, "", v); if (v != "") print v }' "$1"; }
# Clash Verge 内核里实际加载到的、订阅里的节点数
count_nodes() { # names_file
  local px; px=$(ctl GET /proxies)
  if [ -s "$1" ]; then jget "$px" 'return Object.keys(o.proxies||{}).join("\n")' | grep -cxFf "$1"
  else jget "$px" 'var p=o.proxies||{};return Object.keys(p).filter(function(k){return !/^(Direct|Reject|RejectDrop|Compatible|Pass|Selector|URLTest|Fallback|LoadBalance|Relay|Dns)$/.test(p[k].type)}).length'; fi
}
migrate() { # install|import
  if [ "$1" = install ]; then
    c_warn "这台电脑还没装 Clash Verge Rev（这套设置要用它）。接下来自动帮你："
    printf '  ① 从官方下载并安装 Clash Verge Rev  ② 把你原来代理软件里的订阅搬进去  ③ 关掉原来的代理软件（只是退出，不卸载）\n'
  else
    c_warn "Clash Verge Rev 里还没有订阅。接下来把你原来代理软件里的订阅导进去，再关掉原来的代理软件（只是退出，不卸载）"
  fi
  OLDPX=$(find_old_proxy)
  [ -n "$OLDPX" ] && c_ok "原来的代理软件能用（本机端口 ${OLDPX##*:}），下载时先借它的网络"
  local subs subf chosen="" n cl c u tries vport was nn host names
  [ "${CE_ROUTER:-}" = 1 ] && ROUTER=1
  subf=$(mktemp)
  if [ -z "$ROUTER" ]; then
    subs=$(find_subs)
    [ -n "$subs" ] || c_warn "没在电脑上的代理软件里找到订阅"
  fi
  while IFS="$(printf '\t')" read -r _ cl c u; do
    [ -n "$u" ] || continue
    printf '  找到 %s 的订阅：%s%s，正在下载…\n' "$cl" "$(mask_url "$u")" "$([ "$c" = 1 ] && echo '（正在使用）')"
    if fetch_sub "$u" "$subf"; then chosen=$u; break; fi
    c_warn "这个订阅下载不下来，或者不是 Clash 格式，换下一个"
  done < <(printf '%s\n' "$subs" | head -6)
  tries=0
  while [ -z "$chosen" ] && [ -z "$ROUTER" ] && [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    # 没有终端可问（或沙箱测试没要求交互）就不问
    { [ -z "$TR" ] || [ -n "${CE_TEST_TTY:-}" ]; } && ( : </dev/tty ) 2>/dev/null || break
    u=$(ask "请粘贴你的订阅链接（http 开头，在机场官网或原来软件的订阅设置里复制）。如果你的梯子装在路由器上（软路由），电脑上没有代理软件，请输入大写 R，回车：" | tr -d ' \r\n')
    case "$u" in r|R) ROUTER=1; break;; esac
    [ -n "$u" ] || break
    printf '%s\n' "$u" | grep -qE '^https?://[^[:space:]]+$' || { c_warn "这不像订阅链接（应该以 http:// 或 https:// 开头），请再试一次"; continue; }
    printf '  正在下载订阅 %s …\n' "$(mask_url "$u")"
    if fetch_sub "$u" "$subf"; then chosen=$u; else c_warn "这个链接下载不到 Clash 格式的订阅。请在机场官网找「Clash」订阅链接再粘贴"; fi
  done
  [ -n "$chosen" ] || [ -n "$ROUTER" ] || { rm -f "$subf"; manual_fallback "没拿到能用的订阅，没法自动配置。"; }
  names=$(mktemp)
  if [ -n "$ROUTER" ]; then
    # 软路由：梯子在路由器上，Clash 里不放订阅节点，只放一个空配置（其余流量直连，由路由器代理）；到中转的那一跳也直连
    printf '# 软路由模式：梯子在路由器上，这里不需要订阅节点\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n' >"$subf"
    c_ok "软路由模式：不需要订阅。电脑到我们中转的这一跳，由你路由器上的梯子代理出国"
    printf '  请确认：路由器上的梯子对海外网站是开着的（这台电脑现在能打开 google.com 就说明是通的）\n'
  else
    sub_names "$subf" >"$names"; nn=$(grep -c . "$names")
    c_ok "订阅下载成功：$(mask_url "$chosen")$([ "${nn:-0}" -gt 0 ] && echo "（约 ${nn} 个节点）")"
  fi
  if [ "$1" = install ]; then
    install_verge || { rm -f "$subf" "$names"; manual_fallback "自动下载或安装 Clash Verge Rev 没成功（多半是网络问题）。"; }
    c_ok "Clash Verge Rev ${VERGE_VER} 已安装"
    printf '  正在第一次打开 Clash Verge Rev…\n'
    start_verge
    wait_ctl 90 || die "Clash Verge Rev 装好了，但第一次打开没成功。请手动打开一次 Clash Verge Rev，再重新运行本命令。"
  fi
  stop_verge
  if [ -n "$ROUTER" ]; then
    import_sub "" "$subf" "软路由（梯子在路由器上）" local; rm -f "$subf"
    [ -n "$DRY" ] || printf '软路由模式：梯子在路由器上，Clash 里没有订阅节点\n' >"$ROUTER_MARK"
    c_ok "已在 Clash Verge Rev 里建好软路由配置，并设为当前使用"
  else
    host=$(printf '%s' "$chosen" | sed -E 's#^https?://([^@/?#]*@)?([^/?#:]+).*#\2#')
    import_sub "$chosen" "$subf" "$host"; rm -f "$subf"
    c_ok "订阅已导入 Clash Verge Rev，并设为当前使用的订阅"
  fi
  local runold; runold=$(running_others)
  if [ -n "$runold" ]; then
    printf '  正在关闭原来的代理软件：%s（两个代理软件同时开会抢网络；以后只用 Clash Verge Rev）\n' "$(printf '%s\n' "$runold" | cut -d'|' -f1 | paste -sd '、' -)"
    while IFS='|' read -r n a; do quit_old "$n" "$a" "$(printf '%s\n' "$OTHER_CLIENTS" | grep -F "$n|$a|" | head -1 | cut -d'|' -f3)"; done <<<"$runold"
    c_ok "原来的代理软件已关闭（没有卸载，想用时还能打开，但别和 Clash Verge Rev 同时开）"
  fi
  vport=$(grep -E '^mixed-port:' "$CV_CFG" 2>/dev/null | awk '{print $2}'); vport=${vport:-7897}
  was=$(reset_sys_proxy "$vport")
  [ -n "$was" ] && c_ok "已关掉原来软件留下的系统代理（$(printf '%s\n' "$was" | paste -sd '、' -)）"
  printf '  正在打开 Clash Verge Rev 并加载订阅…\n'
  start_verge
  # 刚退出的 Clash Verge 偶尔还没完全关掉，这次打开会落空：再打开一次
  SOCK=""; wait_ctl 60 || { start_verge; wait_ctl 60; } || die "Clash Verge Rev 打开后连不上控制接口。"
  if [ -n "$ROUTER" ]; then
    rm -f "$names"
    find_ctl || die "Clash Verge Rev 打开后连不上控制接口。"
    c_ok "Clash Verge Rev 已加载软路由配置"
  else
    n=0; for _ in $(seq 1 15); do n=$(count_nodes "$names"); [ "${n:-0}" -gt 0 ] && break; sleep 2; done
    rm -f "$names"
    [ "${n:-0}" -gt 0 ] || die "订阅导入后 Clash Verge Rev 里没有读到节点。请打开 Clash Verge Rev「订阅」页看一下是否有报错，截图发给客服。"
    c_ok "Clash Verge Rev 已读到订阅里的 ${n} 个节点"
  fi
}

[ "$(uname)" = "Darwin" ] || die "这个脚本只支持 macOS。"
if [ -n "${CE_TEST_ROOT:-}" ]; then
  [ -d "$CE_TEST_ROOT" ] || { echo "CE_TEST_ROOT 不存在"; exit 9; }
  case "$HOME" in "$CE_TEST_ROOT"*) ;; *) echo "压测必须把 HOME 指到 CE_TEST_ROOT 里面"; exit 9;; esac
fi
printf '\n\033[1mClaude 稳定使用环境 · 一键部署\033[0m\n'
[ -n "$DRY" ] && c_warn "测试模式：不改动本机任何配置。"

# ===== 1. 前提检查 =====
step 1 "检查梯子和 Clash Verge"
if ! verge_present; then
  [ -n "$DRY" ] && manual_fallback "没找到 Clash Verge Rev。"
  migrate install
elif [ -f "$CV_DIR/profiles.yaml" ] && ! has_current_profile && [ -z "$DRY" ]; then
  migrate import
fi
if [ ! -f "$CV_CFG" ]; then
  [ -n "$DRY" ] && die "Clash Verge 没在运行"
  start_verge; wait_ctl 60 || die "Clash Verge 启动失败或控制接口连不上。"
fi
VV=$(verge_version)
if [ -n "$VV" ] && ! ver_ge "$VV" "$MIN_VERGE"; then
  c_warn "Clash Verge 版本 $VV 偏旧（我们测过 $MIN_VERGE 及以上），建议在 Clash Verge「设置 → 检查更新」升级后再运行"
fi
if ! find_ctl; then
  [ -n "$DRY" ] && die "Clash Verge 没在运行"
  sysrun open -a "Clash Verge"; for _ in $(seq 1 15); do sleep 2; find_ctl && break; done
  [ -n "$SOCK" ] || die "Clash Verge 启动失败或控制接口连不上。"
fi
VV_NOTE=""; [ -n "$VV" ] && VV_NOTE="（${VV}）"
c_ok "Clash Verge 正在运行$VV_NOTE"
RUN_OTHERS=$(running_others)
if [ -n "$RUN_OTHERS" ]; then
  c_warn "这些代理软件也在运行，会和 Clash Verge 抢网络、让 Claude 流量漏出去：$(printf '%s\n' "$RUN_OTHERS" | cut -d'|' -f1 | paste -sd '、' -)"
  if [ -z "$DRY" ] && [ "$(ask "帮你退出它们？（y/n，默认 y）")" != "n" ]; then
    printf '%s\n' "$RUN_OTHERS" | while IFS='|' read -r n a; do sysrun osascript -e "quit app \"${a%.app}\"" 2>/dev/null; [ -n "$TR" ] && sed -i '' "/^$(printf '%s' "$OTHER_CLIENTS" | grep -F "$n|$a|" | head -1 | cut -d'|' -f3)\$/d" "$TR/procs"; done
    sleep 3
    c_ok "已退出（以后别和 Clash Verge 同时开）"
  fi
fi
MIXED_PORT=$(jget "$(ctl GET /configs)" 'o["mixed-port"]'); MIXED_PORT=${MIXED_PORT:-7897}
if [ -n "$ROUTER" ]; then
  curl -s -m 10 -o /dev/null -x "http://127.0.0.1:$MIXED_PORT" https://www.google.com/generate_204 || die "路由器的梯子不通：这台电脑通过路由器打不开 Google。请先确认路由器上的梯子是开着的、这台电脑接的就是这个路由器，再重新运行。"
  c_ok "路由器上的梯子可用（这台电脑能经路由器打开 Google）"
else
  curl -s -m 10 -o /dev/null -x "http://127.0.0.1:$MIXED_PORT" https://www.google.com/generate_204 || die "梯子不通：通过 Clash 打不开 Google。请先确认你的梯子能正常使用。"
  c_ok "梯子可用"
fi

# ===== 2. 开通码 =====
step 2 "读取开通码"
CODE="${CE_CODE:-${1:-}}"
if [ -z "$CODE" ]; then printf '请粘贴开通码（CE1- 开头，粘贴后不显示），回车：'; read -r -s CODE </dev/tty; echo; fi
CODE=$(printf '%s' "$CODE" | tr -d ' \r\n')
case "$CODE" in CE1-*) ;; *) die "开通码格式不对：应以 CE1- 开头。";; esac
B64=$(printf '%s' "${CODE#CE1-}" | tr '_-' '/+')
case $(( ${#B64} % 4 )) in 2) B64="$B64==";; 3) B64="$B64=";; esac
CJ=$(printf '%s' "$B64" | base64 -D 2>/dev/null)
PX_HOST=$(jget "$CJ" 'o.host'); PX_PORT=$(jget "$CJ" 'o.port'); PX_USER=$(jget "$CJ" 'o.user')
PX_PASS=$(jget "$CJ" 'o.pass'); PX_IP=$(jget "$CJ" 'o.ip'); TZNAME=$(jget "$CJ" 'o.tz')
SAFE='^[A-Za-z0-9._-]+$'
[[ "$PX_HOST" =~ $SAFE ]] && [[ "$PX_PORT" =~ ^[0-9]{1,5}$ ]] && [[ "$PX_USER" =~ $SAFE ]] && [[ "$PX_PASS" =~ $SAFE ]] \
  && [[ "$PX_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && [[ "$TZNAME" =~ ^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$ ]] \
  || die "开通码无效或不完整，请向客服重新获取。"
c_ok "你的专属 IP：${PX_IP}（时区 ${TZNAME}）"

# ===== 3. 写入 Clash（全局扩展脚本，不动原订阅） =====
step 3 "写入 Clash Verge 分流规则"
OUT_DIR="$CV_DIR/profiles"
if [ -n "$DRY" ]; then OUT_DIR=$(mktemp -d); c_warn "测试模式输出目录：$OUT_DIR"; cp "$CV_DIR/profiles/Script.js" "$OUT_DIR/" 2>/dev/null; fi
SCRIPT_JS="$OUT_DIR/Script.js"
[ -f "$SCRIPT_JS" ] || printf 'function main(config, profileName) {\n  return config;\n}\n' >"$SCRIPT_JS"
[ -n "$DRY" ] || cp "$SCRIPT_JS" "$SCRIPT_JS.backup-claude-env-$TS"
sed -i '' "/^${MARK_BEGIN//\//\\/}/,/^${MARK_END//\//\\/}/d" "$SCRIPT_JS"
grep -q '__ceUserMain' "$SCRIPT_JS" || sed -i '' -E 's/function[[:space:]]+main[[:space:]]*\(/function __ceUserMain(/' "$SCRIPT_JS"
jsarr() { local s; s=$(printf '"%s",' "$@"); printf '[%s]' "${s%,}"; }
cat >>"$SCRIPT_JS" <<EOF
$MARK_BEGIN
function main(config, profileName) {
  if (typeof __ceUserMain === "function") config = __ceUserMain(config, profileName) || config;
  var G = "$GROUP_NAME", N = "$NODE_NAME", F = "$FRONT_NAME";
  var SUFFIX = $(jsarr $CLAUDE_SUFFIXES), KEYWORD = $(jsarr $CLAUDE_KEYWORDS);
  var CIDR = $(jsarr $ANTHROPIC_CIDR), CIDR6 = $(jsarr $ANTHROPIC_CIDR6);
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
  var node = { name: N, type: "http", server: "$PX_HOST", port: $PX_PORT, username: "$PX_USER", password: "$PX_PASS", udp: false };
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
$MARK_END
EOF
if node -e 1 2>/dev/null; then
  node -e '
    const fs=require("fs"),vm=require("vm");const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(process.argv[1],"utf8"),c);
    const r=c.main({proxies:[],"proxy-groups":[{name:"节点选择",type:"select",proxies:["a"]}],rules:["MATCH,节点选择"],dns:{enable:true}},"t");
    if(!r.proxies.find(p=>p["dialer-proxy"]==="节点选择")||!r.rules.includes("DOMAIN-SUFFIX,claude.ai,'"$GROUP_NAME"'")||!r.dns["nameserver-policy"]["+.claude.ai"])process.exit(1)' "$SCRIPT_JS" \
    && c_ok "扩展脚本自检通过" || die "扩展脚本自检失败（原文件已备份）"
  # 软路由（没有任何订阅节点）：到中转的这一跳必须是直连，规则照样生成
  node -e '
    const fs=require("fs"),vm=require("vm");const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(process.argv[1],"utf8"),c);
    const r=c.main({proxies:[],"proxy-groups":[],rules:["MATCH,DIRECT"],dns:{enable:true}},"t");
    const n=r.proxies.find(p=>p.name==="'"$NODE_NAME"'");
    if(!n||"dialer-proxy" in n||!r.rules.includes("DOMAIN-SUFFIX,claude.ai,'"$GROUP_NAME"'")||r.rules[r.rules.length-1]!=="MATCH,DIRECT")process.exit(1)' "$SCRIPT_JS" \
    && c_ok "扩展脚本自检通过（无前置梯子的情形）" || die "扩展脚本自检失败（无前置梯子的情形，原文件已备份）"
fi
if [ -n "$ROUTER" ]; then c_ok "已写入全局扩展脚本：Claude、后台上报、人机验证、付款、实名都走专属 IP；到中转的这一跳由你路由器上的梯子代理"
else c_ok "已写入全局扩展脚本：Claude、后台上报、人机验证、付款、实名都走专属 IP；你原来的订阅和节点不变"; fi

# ===== 4. 清理环境变量 =====
step 4 "清理环境变量（中转地址、指向别处的代理等）"
FOUND=0
for f in $SHELL_FILES; do
  [ -f "$f" ] || continue
  INNER=$(grep -nE "$BAD_ENV_RE_ANY" "$f")
  [ -n "$INNER" ] && printf '  %s 第 %s行写在函数/条件里（手动调用才生效），不动\n' "${f/#$HOME/~}" "$(printf '%s\n' "$INNER" | cut -d: -f1 | tr '\n' ' ')"
  BADLINES=""
  while IFS=: read -r n line; do
    [ -n "$n" ] || continue
    kv=$(printf '%s\n' "$line" | sed -E 's/^export[[:space:]]+//'); name=${kv%%=*}
    val=$(printf '%s\n' "${kv#*=}" | sed -E "s/[[:space:]]+#.*$//; s/^['\"]//; s/['\"]$//")
    env_is_bad "$name" "$val" && { BADLINES="$BADLINES $n"; printf '  %s 第 %s 行：%s=…\n' "${f/#$HOME/~}" "$n" "$name"; }
  done < <(grep -nE "$BAD_ENV_RE" "$f")
  [ -n "$BADLINES" ] || continue
  FOUND=1
  if [ -z "$DRY" ]; then
    cp "$f" "$f.backup-claude-env-$TS"
    for n in $BADLINES; do sed -i '' "${n}s/^/# [claude-env 已停用 $TS] /" "$f"; done
  fi
done
for v in $BAD_ENV_NAMES; do
  val=$(lc_get "$v")
  if [ -n "$val" ] && env_is_bad "$v" "$val"; then
    FOUND=1; printf '  系统级（launchctl）：%s\n' "$v"
    [ -n "$DRY" ] || lc_unset "$v"
  fi
done
CS="$HOME/.claude/settings.json"
if [ -f "$CS" ]; then
  CS_PAIRS=$(jget "$(cat "$CS")" 'var e=o.env||{};return Object.keys(e).filter(k=>"'"$BAD_ENV_NAMES"'".split(" ").indexOf(k)>=0).map(k=>k+"="+e[k]).join("\n")')
  CS_BAD=""
  while IFS= read -r kv; do [ -n "$kv" ] && env_is_bad "${kv%%=*}" "${kv#*=}" && CS_BAD="$CS_BAD ${kv%%=*}"; done <<<"$CS_PAIRS"
  [ -n "$(jget "$(cat "$CS")" 'o.apiKeyHelper')" ] && CS_BAD="$CS_BAD apiKeyHelper"
  if [ -n "$CS_BAD" ]; then
    FOUND=1; printf '  ~/.claude/settings.json：%s\n' "$CS_BAD"
    [ -n "$DRY" ] || { cp "$CS" "$CS.backup-claude-env-$TS"; jedit "$CS" 'var bad="'"${CS_BAD# }"'".split(" ");bad.forEach(function(k){if(k==="apiKeyHelper")delete o.apiKeyHelper;else if(o.env)delete o.env[k]})'; }
  fi
fi
if [ "$FOUND" = 0 ]; then c_ok "没有发现会干扰的环境变量"
elif [ -n "$DRY" ]; then c_warn "测试模式：以上项目正式运行时会被停用（先备份）"
else c_ok "以上项目已停用（原文件都有 .backup-claude-env-$TS 备份）"; fi

# ===== 5. 本机设置 =====
step 5 "本机设置：TUN / 时区 / 语言 / 定位 / 遥测 / 旧标识"
set_tun() { # true|false
  if grep -qE '^enable_tun_mode:' "$VERGE_YAML"; then sed -i '' -E "s/^enable_tun_mode:.*/enable_tun_mode: $1/" "$VERGE_YAML"
  else echo "enable_tun_mode: $1" >>"$VERGE_YAML"; fi
}
TUN_ON=""
if [ -z "$DRY" ]; then
  if ensure_service; then
    set_tun true; TUN_ON=1
    c_ok "TUN（虚拟网卡）设为开启"
  elif [ "$(jget "$(ctl GET /configs)" 'o.tun&&o.tun.enable')" = true ]; then
    c_ok "TUN（虚拟网卡）现在就开着，保持不动"
  else
    set_tun false   # Clash Verge 没有服务模式时开着 TUN 内核起不来；先关掉，验收里会告诉客户怎么打开
  fi
  NEED_SUDO=""
  { [ "$(tz_auto)" != 0 ] || [ "$(sys_tz)" != "$TZNAME" ]; } && NEED_SUDO=1
  [ -n "$NEED_SUDO" ] && [ -z "$SUDO_READY" ] && printf '  接下来改时区需要输入一次开机密码（输入时不显示）\n'
  [ "$(tz_auto)" = 0 ] || tz_auto_off
  [ "$(sys_tz)" = "$TZNAME" ] || set_tz "$TZNAME"
  c_ok "已关闭「自动设置时区」，电脑时区：$(sys_tz)"
  if [ "$(sys_lang)" != en-US ] || [ "$(sys_locale)" != en_US ]; then set_lang; fi
  c_ok "系统语言：英语排第一（原来的中文等保留在后面，输入法不变），地区：美国。重启电脑后生效"
  fix_browser_langs
  if [ "$(loc_on)" != false ]; then
    printf '  需要你手动关一下「定位服务」：已打开设置页，把最上面「定位服务」的开关关掉（会让你输入开机密码）\n'
    sysrun open "$LOC_PANE"
    for _ in 1 2; do
      if [ -n "$TR" ]; then [ -f "$TR/location_stuck" ] || echo false >"$TR/location"
      else ask "关好后回到这里按回车：" >/dev/null; fi
      [ "$(loc_on)" = false ] && break
      c_warn "定位服务还开着，请再确认一次"
    done
  fi
  [ "$(loc_on)" = false ] && c_ok "定位服务已关闭" || c_warn "定位服务仍开着（验收会标出）"
  ENV_INLINE=""; for v in $TELEMETRY_ENV; do ENV_INLINE="$ENV_INLINE $v=1"; done
  ALIAS_LINE="alias claude='TZ=$TZNAME LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8${ENV_INLINE} HTTPS_PROXY=http://127.0.0.1:$MIXED_PORT HTTP_PROXY=http://127.0.0.1:$MIXED_PORT command claude'"
  for f in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    [ "$f" = "$HOME/.zshrc" ] || [ -f "$f" ] || continue
    [ -f "$f" ] && { [ -f "$f.backup-claude-env-$TS" ] || cp "$f" "$f.backup-claude-env-$TS"; sed -i '' "/^$RC_BEGIN/,/^$RC_END/d" "$f"; }
    printf '%s\n%s\n%s\n' "$RC_BEGIN" "$ALIAS_LINE" "$RC_END" >>"$f"
  done
  mkdir -p "$HOME/.claude"
  [ -f "$CS" ] && { [ -f "$CS.backup-claude-env-$TS" ] || cp "$CS" "$CS.backup-claude-env-$TS"; }
  jedit "$CS" 'o.env=o.env||{};"'"$TELEMETRY_ENV"'".split(" ").forEach(function(k){o.env[k]="1"})'
  c_ok "Claude Code：固定走 Clash、时区 ${TZNAME}、遥测和错误上报已关闭"
  BK="$HOME/.claude-env-backup/$TS"; mkdir -p "$BK"
  if [ -f "$HOME/.claude.json" ]; then
    cp "$HOME/.claude.json" "$BK/claude.json"
    jedit "$HOME/.claude.json" '"'"$CC_ID_KEYS"'".split(" ").forEach(function(k){delete o[k]})'
  fi
  # 旧备份里也存着旧设备标识；遥测、统计、实验缓存整个目录挪走
  mkdir -p "$BK/old"
  for p in "$HOME"/.claude.json.backup* "$HOME/.claude/backups" "$HOME/.claude/statsig" "$HOME/.claude/telemetry" \
           "$HOME/.claude/stats-cache.json" "$HOME/.claude/usage-data" "$HOME/.claude/usage.jsonl" "$HOME/Library/Caches/claude-cli-nodejs"; do
    [ -e "$p" ] && mv "$p" "$BK/old/"
  done
  c_ok "Claude Code：设备/实验/统计标识、旧配置备份、遥测缓存已清理，不会退出登录"
  if [ -d "$CLAUDE_DESKTOP_DIR" ]; then
    sysrun osascript -e 'quit app "Claude"' 2>/dev/null; sleep 2
    mkdir -p "$BK/desktop"
    for p in ant-did ant-device-registry.json sentry Crashpad; do [ -e "$CLAUDE_DESKTOP_DIR/$p" ] && mv "$CLAUDE_DESKTOP_DIR/$p" "$BK/desktop/"; done
    c_ok "Claude 桌面版：设备标识和本机配置快照已清理（登录状态保留）"
  fi
  c_ok "以上都已备份到 ~/.claude-env-backup/$TS"

  step 6 "重启 Clash Verge 使配置生效（断网几秒）"
  restart_verge() { sysrun osascript -e 'quit app "Clash Verge"' 2>/dev/null; sleep 4; sysrun open -a "Clash Verge"; SOCK=""; for _ in $(seq 1 20); do sleep 2; find_ctl && break; done; }
  restart_verge
  if [ -z "$SOCK" ] && [ -n "$TUN_ON" ]; then
    # 开着 TUN 内核没起来：先关掉虚拟网卡让 Clash Verge 正常运行（客户不能断网），验收里会提示
    c_warn "Clash Verge 开着虚拟网卡（TUN）没能启动，先关掉虚拟网卡让它正常运行"
    set_tun false; TUN_ON=""; restart_verge
  fi
  [ -n "$SOCK" ] || die "Clash Verge 重启后连不上。"
  if [ -n "$TUN_ON" ]; then
    # 服务模式下内核由服务启动，虚拟网卡要等几秒
    for _ in $(seq 1 10); do [ "$(jget "$(ctl GET /configs)" 'o.tun&&o.tun.enable')" = true ] && break; sleep 2; done
    [ "$(jget "$(ctl GET /configs)" 'o.tun&&o.tun.enable')" = true ] && c_ok "虚拟网卡（TUN）已在运行" || c_warn "虚拟网卡（TUN）设了开启，但内核没打开它（验收会标出）"
  fi
  [ "$(jget "$(ctl GET /configs)" 'o.mode')" = "rule" ] || ctl PATCH /configs '{"mode":"rule"}' >/dev/null
  for _ in $(seq 1 15); do curl -s -m 3 -o /dev/null -x "http://127.0.0.1:$MIXED_PORT" https://www.google.com/generate_204 && break; sleep 2; done
  V6=$(curl -6 -s -m 6 https://claude.ai/cdn-cgi/trace | trace_ip)
  if [ -n "$V6" ] && [ "$V6" != "$PX_IP" ]; then
    printf '  发现 IPv6 绕过 Clash（%s），关闭网卡 IPv6（需要开机密码）\n' "$V6"
    sys_services | while read -r svc; do sysrun sudo networksetup -setv6off "$svc" 2>/dev/null; done
  fi
fi

# ===== 7. 严格验收 =====
step 7 "严格验收"
PASS=0; FAILN=0
chk() { if [ "$2" = ok ]; then c_ok "$1"; PASS=$((PASS+1)); else c_err "$1 —— $2"; FAILN=$((FAILN+1)); fi; }
CFG=$(ctl GET /configs)
[ "$(jget "$CFG" 'o.mode')" = "rule" ] && chk "Clash 规则模式" ok || chk "Clash 规则模式" "当前是 $(jget "$CFG" 'o.mode')，请在首页切到「规则」"
if [ "$(jget "$CFG" 'o.tun&&o.tun.enable')" = "true" ]; then chk "TUN 虚拟网卡已开启" ok
elif [ -z "$DRY" ] && [ "$(svc_state)" = running ]; then chk "TUN 虚拟网卡已开启" "没开。服务模式已装好：Clash Verge「设置」→ 打开「虚拟网卡模式」，然后重新运行本命令"
else chk "TUN 虚拟网卡已开启" "没开（服务模式没能自动装上）。Clash Verge「设置」→ 点「安装服务模式」，再打开「虚拟网卡模式」，然后重新运行本命令"; fi
if [ -z "$DRY" ]; then
  RULES=$(ctl GET /rules)
  rule_to() { jget "$RULES" 'return o.rules.some(r=>r.payload==="'"$1"'"&&r.proxy==="'"$2"'")'; }
  MISSING=""; for d in claude.ai sentry.io hcaptcha.com stripe.com withpersona.com; do [ "$(rule_to "$d" "$GROUP_NAME")" = true ] || MISSING="$MISSING $d"; done
  [ -z "$MISSING" ] && chk "分流规则已加载（Claude、上报、验证、付款、实名）" ok || chk "分流规则已加载" "缺少：${MISSING}。Clash Verge「订阅」页确认「全局扩展脚本」已启用"
  [ "$(jget "$RULES" 'return o.rules.some(r=>r.type==="AND"&&r.proxy==="REJECT"&&/claude\.ai/.test(r.payload))')" = "true" ] && chk "Claude 的 UDP/QUIC 已拦截" ok || chk "Claude 的 UDP/QUIC 已拦截" "规则没加载"
  [ "$(jget "$RULES" 'return o.rules.some(r=>r.proxy==="REJECT"&&/2607:6bc0/.test(r.payload))')" = "true" ] && chk "Anthropic IPv6 已拒绝（只走 IPv4）" ok || chk "Anthropic IPv6 已拒绝" "规则没加载"
  # 以 Clash Verge 实际生效的配置为准：「DNS 覆写」开着时会盖掉扩展脚本写的 nameserver-policy
  if grep -qF "dns-query#$GROUP_NAME" "$CV_CFG" 2>/dev/null; then chk "Claude 域名走海外加密 DNS（不经过国内 DNS）" ok
  elif grep -qE '^[[:space:]]*enhanced-mode:[[:space:]]*fake-ip' "$CV_CFG" 2>/dev/null; then chk "Claude 域名不在本机解析（Fake-IP，交给专属 IP 远端解析）" ok
  else chk "Claude 域名走海外加密 DNS" "没生效，多半是 Clash Verge「设置」里开了「DNS 覆写」：关掉后重新运行本命令"; fi
  DELAY=$(jget "$(ctl GET "/proxies/$(urlenc "$NODE_NAME")/delay?timeout=8000&url=$(urlenc https://claude.ai/cdn-cgi/trace)")" 'o.delay')
  if [ -n "$ROUTER" ]; then
    [ -n "$DELAY" ] && chk "链路 路由器→中转→专属IP 连通（${DELAY}ms）" ok || chk "链路 路由器→中转→专属IP 连通" "不通。多半是路由器没让这台电脑到 ${PX_HOST} 的流量走梯子（它在海外，国内直连会被墙）：请在路由器里让 ${PX_HOST} 走代理，再重新运行；还不行就截图发给客服"
  else
    [ -n "$DELAY" ] && chk "链路 梯子→中转→专属IP 连通（${DELAY}ms）" ok || chk "链路 梯子→中转→专属IP 连通" "不通，请截图发给客服"
  fi
fi
for d in claude.ai claude.com anthropic.com challenges.cloudflare.com; do
  IP_T=$(dtrace "https://$d/cdn-cgi/trace" | trace_ip)
  [ "$IP_T" = "$PX_IP" ] && chk "$d 看到的出口 = ${PX_IP}（不设代理直连，证明 TUN 接管）" ok || chk "$d 看到的出口" "看到的是 ${IP_T:-连不上}"
done
IP_P=$(curl -s -m 15 -x "http://127.0.0.1:$MIXED_PORT" https://api.anthropic.com/cdn-cgi/trace | trace_ip)
[ "$IP_P" = "$PX_IP" ] && chk "Claude Code 通道出口 = $PX_IP" ok || chk "Claude Code 通道出口" "看到的是 ${IP_P:-连不上}"
V6=$(curl -6 -s -m 6 https://claude.ai/cdn-cgi/trace | trace_ip)
{ [ -z "$V6" ] || [ "$V6" = "$PX_IP" ]; } && chk "无 IPv6 绕过" ok || chk "无 IPv6 绕过" "IPv6 直连看到 $V6"
OTHER=$(dtrace https://www.cloudflare.com/cdn-cgi/trace | trace_ip)
{ [ -n "$OTHER" ] && [ "$OTHER" != "$PX_IP" ]; } && chk "其他网站仍走你的梯子（不浪费专属 IP 流量）" ok || chk "其他网站仍走你的梯子" "其他网站出口是 ${OTHER:-连不上}"
TRUST=$(curl -s -m 15 "https://ip.net.coffee/api/iprisk/$PX_IP" | grep -oE '"trust_score": *[0-9]+' | grep -oE '[0-9]+$')
if [ -z "$TRUST" ]; then c_warn "Claude 信任评分暂时查不到（第三方服务），不影响使用"; PASS=$((PASS+1))
elif [ "$TRUST" -ge 80 ]; then chk "Claude 信任评分 ${TRUST}（≥80）" ok
else chk "Claude 信任评分" "只有 ${TRUST}，请截图发给客服"; fi
[ "$(sys_tz)" = "$TZNAME" ] && chk "电脑时区 = IP 时区（${TZNAME}）" ok || chk "电脑时区 = IP 时区" "电脑是 $(sys_tz)，IP 是 $TZNAME"
[ "$(tz_auto)" = 0 ] && chk "「自动设置时区」已关闭" ok || chk "「自动设置时区」已关闭" "还开着，换网络后时区可能被改回去"
{ [ "$(sys_lang)" = en-US ] && [ "$(sys_locale)" = en_US ]; } && chk "系统语言英语、地区美国" ok || chk "系统语言英语、地区美国" "当前是 $(sys_lang) / $(sys_locale)"
BADB=$(browser_bad | paste -sd '、' -)
[ -z "$BADB" ] && chk "浏览器网页语言英语优先" ok || chk "浏览器网页语言英语优先" "还不是：${BADB}。请退出这些浏览器后重新运行本命令"
[ "$(loc_on)" = false ] && chk "定位服务已关闭" ok || chk "定位服务已关闭" "还开着：系统设置 → 隐私与安全性 → 定位服务，关掉总开关"
# 以「新开一个终端」实际带的环境变量为准
LEFT=""
while IFS= read -r kv; do [ -n "$kv" ] && env_is_bad "${kv%%=*}" "${kv#*=}" && LEFT="$LEFT ${kv%%=*}"; done < <(env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" TERM=xterm-256color zsh -ilc env </dev/null 2>/dev/null | grep -E "^($BAD_ENV_ALT)=")
for v in $BAD_ENV_NAMES; do val=$(lc_get "$v"); [ -n "$val" ] && env_is_bad "$v" "$val" && LEFT="$LEFT ${v}(系统级)"; done
[ -z "${LEFT// /}" ] && chk "没有干扰的环境变量" ok || chk "没有干扰的环境变量" "还有：$LEFT"
if [ -z "$DRY" ]; then
  TEL_MISS=$( [ -f "$CS" ] && jget "$(cat "$CS")" 'var e=o.env||{};return "'"$TELEMETRY_ENV"'".split(" ").filter(k=>e[k]!=="1").join(" ")' || echo "$TELEMETRY_ENV")
  { [ -z "$TEL_MISS" ] && zsh -ic 'alias claude' 2>/dev/null | grep -q "TZ=$TZNAME.*DISABLE_TELEMETRY=1"; } && chk "Claude Code 遥测已关闭、时区与代理已固定" ok || chk "Claude Code 遥测已关闭" "缺少：${TEL_MISS:-终端别名}"
  LEFTK=$( [ -f "$HOME/.claude.json" ] && jget "$(cat "$HOME/.claude.json")" 'return "'"$CC_ID_KEYS"'".split(" ").filter(k=>k in o).join(" ")')
  [ -z "$LEFTK" ] && chk "Claude Code 旧设备标识已清除" ok || chk "Claude Code 旧设备标识已清除" "还在：$LEFTK"
  RES=""; for p in "$HOME"/.claude.json.backup* "$HOME/.claude/backups" "$HOME/.claude/statsig" "$HOME/.claude/telemetry"; do [ -e "$p" ] && RES="$RES ${p/#$HOME/~}"; done
  [ -z "$RES" ] && chk "旧配置备份和遥测缓存已清除" ok || chk "旧配置备份和遥测缓存已清除" "还在：$RES"
  [ -e "$CLAUDE_DESKTOP_DIR/ant-did" ] || [ -e "$CLAUDE_DESKTOP_DIR/sentry" ] && chk "Claude 桌面版设备标识已清除" "还在" || chk "Claude 桌面版设备标识已清除" ok
fi
STILL=$(running_others | cut -d'|' -f1 | paste -sd '、' -)
[ -z "$STILL" ] && chk "没有其他代理软件同时运行" ok || chk "没有其他代理软件同时运行" "还在运行：${STILL}，请退出"

printf '\n'
if [ "$FAILN" = 0 ]; then
  printf '\033[1;32m全部 %s 项验收通过 ✅\033[0m\n' "$PASS"
  printf '  专属 IP：%s（%s）\n' "$PX_IP" "$TZNAME"
  printf '  最后一步：重启电脑一次（让英文语言生效），重启后再打开浏览器、Claude 桌面版和终端\n'
  printf '  再用浏览器打开 https://laoshirenvip.com/ip-check ，确认浏览器这一侧的时区、语言也一致\n'
  printf '  提醒：这些 Claude 号不要在插着国内 SIM 卡的安卓手机上登录\n'
  exit 0
else
  printf '\033[1;31m%s 项通过，%s 项没通过 ✘\033[0m\n请把这个窗口截图发给客服。\n' "$PASS" "$FAILN"
  exit 4
fi
