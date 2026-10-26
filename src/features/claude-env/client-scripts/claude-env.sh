#!/bin/bash
# Claude 稳定使用环境 · 一键部署（macOS + Clash Verge Rev）
#
# 客户前提：① 自己有能用的梯子，并在 Clash Verge Rev 里导入了订阅
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
  local args=(-s -m 10 -K - --unix-socket "$SOCK" -X "$1")
  [ -n "${3:-}" ] && args+=(-H 'Content-Type: application/json' -d "$3")
  printf 'header = "Authorization: Bearer %s"\n' "$SECRET" | curl "${args[@]}" "http://localhost$2"
}
find_ctl() {
  SECRET=$(grep -E '^secret:' "$CV_CFG" 2>/dev/null | sed -E "s/^secret: *//; s/^['\"]//; s/['\"]$//")
  local cfg_sock; cfg_sock=$(grep -E '^external-controller-unix:' "$CV_CFG" 2>/dev/null | awk '{print $2}')
  local cands=("/var/run/clash-verge-service/users/$(id -u)/verge-mihomo.sock" "$cfg_sock" /tmp/verge/verge-mihomo.sock)
  [ -n "${CE_TEST_ROOT:-}" ] && cands=("$CE_TEST_ROOT/verge-mihomo.sock")
  for s in "${cands[@]}"; do
    [ -S "$s" ] && SOCK="$s" && ctl GET /version | grep -q version && return 0
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

[ "$(uname)" = "Darwin" ] || die "这个脚本只支持 macOS。"
if [ -n "${CE_TEST_ROOT:-}" ]; then
  [ -d "$CE_TEST_ROOT" ] || { echo "CE_TEST_ROOT 不存在"; exit 9; }
  case "$HOME" in "$CE_TEST_ROOT"*) ;; *) echo "压测必须把 HOME 指到 CE_TEST_ROOT 里面"; exit 9;; esac
fi
printf '\n\033[1mClaude 稳定使用环境 · 一键部署\033[0m\n'
[ -n "$DRY" ] && c_warn "测试模式：不改动本机任何配置。"

# ===== 1. 前提检查 =====
step 1 "检查梯子和 Clash Verge"
if [ ! -f "$CV_CFG" ]; then
  OTHERS=$(installed_others | paste -sd '、' -)
  c_err "没找到 Clash Verge Rev。"
  [ -n "$OTHERS" ] && printf '  检测到你在用：%s。这类软件没法可靠地自动配置「梯子 → 专属 IP」链路，需要换成 Clash Verge Rev（免费开源）。\n' "$OTHERS"
  printf '  1. 已为你打开下载页：M 芯片下载 aarch64.dmg，Intel 下载 x64.dmg，装好打开\n'
  printf '  2. 在 Clash Verge Rev「订阅」里粘贴你梯子的订阅链接（机场官网或原软件的订阅设置里能找到），选中它\n'
  printf '  3. 退出原来的代理软件，确认能打开 google.com 后，重新运行本命令\n'
  sysrun open "https://github.com/clash-verge-rev/clash-verge-rev/releases/latest"
  exit 3
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
curl -s -m 10 -o /dev/null -x "http://127.0.0.1:$MIXED_PORT" https://www.google.com/generate_204 || die "梯子不通：通过 Clash 打不开 Google。请先确认你的梯子能正常使用。"
c_ok "梯子可用"

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
fi
c_ok "已写入全局扩展脚本：Claude、后台上报、人机验证、付款、实名都走专属 IP；你原来的订阅和节点不变"

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
if [ -z "$DRY" ]; then
  if grep -qE '^enable_tun_mode:' "$VERGE_YAML"; then sed -i '' -E 's/^enable_tun_mode:.*/enable_tun_mode: true/' "$VERGE_YAML"
  else echo 'enable_tun_mode: true' >>"$VERGE_YAML"; fi
  c_ok "TUN（虚拟网卡）设为开启"
  NEED_SUDO=""
  { [ "$(tz_auto)" != 0 ] || [ "$(sys_tz)" != "$TZNAME" ]; } && NEED_SUDO=1
  [ -n "$NEED_SUDO" ] && printf '  接下来改时区需要输入一次开机密码（输入时不显示）\n'
  [ "$(tz_auto)" = 0 ] || tz_auto_off
  [ "$(sys_tz)" = "$TZNAME" ] || set_tz "$TZNAME"
  c_ok "已关闭「自动设置时区」，电脑时区：$(sys_tz)"
  if [ "$(sys_lang)" != en-US ] || [ "$(sys_locale)" != en_US ]; then set_lang; fi
  c_ok "系统语言：英语排第一（原来的中文等保留在后面，输入法不变），地区：美国。重启电脑后生效"
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
  sysrun osascript -e 'quit app "Clash Verge"' 2>/dev/null; sleep 4; sysrun open -a "Clash Verge"
  SOCK=""; for _ in $(seq 1 20); do sleep 2; find_ctl && break; done
  [ -n "$SOCK" ] || die "Clash Verge 重启后连不上。"
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
[ "$(jget "$CFG" 'o.tun&&o.tun.enable')" = "true" ] && chk "TUN 虚拟网卡已开启" ok || chk "TUN 虚拟网卡已开启" "没开。Clash Verge「设置」→ 先安装「服务模式」，再打开「虚拟网卡模式」"
if [ -z "$DRY" ]; then
  RULES=$(ctl GET /rules)
  rule_to() { jget "$RULES" 'return o.rules.some(r=>r.payload==="'"$1"'"&&r.proxy==="'"$2"'")'; }
  MISSING=""; for d in claude.ai sentry.io hcaptcha.com stripe.com withpersona.com; do [ "$(rule_to "$d" "$GROUP_NAME")" = true ] || MISSING="$MISSING $d"; done
  [ -z "$MISSING" ] && chk "分流规则已加载（Claude、上报、验证、付款、实名）" ok || chk "分流规则已加载" "缺少：${MISSING}。Clash Verge「订阅」页确认「全局扩展脚本」已启用"
  [ "$(jget "$RULES" 'return o.rules.some(r=>r.type==="AND"&&r.proxy==="REJECT"&&/claude\.ai/.test(r.payload))')" = "true" ] && chk "Claude 的 UDP/QUIC 已拦截" ok || chk "Claude 的 UDP/QUIC 已拦截" "规则没加载"
  [ "$(jget "$RULES" 'return o.rules.some(r=>r.proxy==="REJECT"&&/2607:6bc0/.test(r.payload))')" = "true" ] && chk "Anthropic IPv6 已拒绝（只走 IPv4）" ok || chk "Anthropic IPv6 已拒绝" "规则没加载"
  DELAY=$(jget "$(ctl GET "/proxies/$(urlenc "$NODE_NAME")/delay?timeout=8000&url=$(urlenc https://claude.ai/cdn-cgi/trace)")" 'o.delay')
  [ -n "$DELAY" ] && chk "链路 梯子→中转→专属IP 连通（${DELAY}ms）" ok || chk "链路 梯子→中转→专属IP 连通" "不通，请截图发给客服"
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
