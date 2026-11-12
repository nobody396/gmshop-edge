#!/bin/bash
# Claude 成品号 · 本机环境清理（macOS）
#
# 只清理本机残留，不碰代理软件、不退出任何已登录的账号：
#   ① 会让 Claude Code 走别处的环境变量（中转 API 地址/密钥、指向别处的代理）——注释掉并备份
#   ② Claude Code 本地的旧设备/统计/实验标识、旧配置备份、遥测缓存——挪到备份目录（会自动重新生成）
#   ③ Claude 桌面版的旧设备标识；「第三方 API 模式」改回官方登录
#   ④ 关闭 Claude Code 遥测和错误上报
#   ⑤ 可选：--tz 时区（关自动时区并改成配套网络所在地，需要开机密码）；--lang-en 系统语言英语优先
# 所有改动先备份到 ~/.claude-clean-backup/<时间>
#
# 用法：curl -fsSL https://laoshirenvip.com/claude-clean.sh -o /tmp/claude-clean.sh && bash /tmp/claude-clean.sh --tz America/Los_Angeles
#
# 测试用环境变量（客户不需要）：
#   CE_TEST_ROOT=/path 沙箱：系统级命令（sudo、launchctl、defaults 写入、osascript 退出 App）只记日志不执行，状态读写沙箱文件
set -u

TZNAME=""; LANG_EN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tz) TZNAME="${2:-}"; shift 2 ;;
    --tz=*) TZNAME="${1#--tz=}"; shift ;;
    --lang-en) LANG_EN=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) printf '未知参数：%s\n' "$1"; exit 2 ;;
  esac
done

c_ok()   { printf '\033[32m✔ %s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m✘ %s\033[0m\n' "$*"; }
step()   { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2"; }

[ "$(uname -s)" = Darwin ] || { c_err "这个命令只适用于 Mac；Windows 请用 PowerShell 那一条。"; exit 1; }
if [ -n "$TZNAME" ] && ! printf '%s' "$TZNAME" | grep -qE '^[A-Za-z_]+(/[A-Za-z_+-]+){1,2}$'; then
  c_err "时区格式不对：$TZNAME"; exit 2
fi

TR="${CE_TEST_ROOT:-}"
TS=$(date +%Y%m%d-%H%M%S)
BK="$HOME/.claude-clean-backup/$TS"
DONE=()
note() { DONE+=("$*"); }

BAD_ENV_NAMES="ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_HTTP_PROXY CLAUDE_CODE_HTTPS_PROXY CLAUDE_CODE_PROXY_URL NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy"
BAD_ENV_ALT=$(echo $BAD_ENV_NAMES | tr ' ' '|')
BAD_ENV_RE="^(export[[:space:]]+)?($BAD_ENV_ALT)="
TELEMETRY_ENV="DISABLE_TELEMETRY DISABLE_ERROR_REPORTING DO_NOT_TRACK CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
CC_ID_KEYS="userID anonymousId machineID remoteControlMachineId cachedStatsigGates cachedGrowthBookFeatures cachedGrowthBookFeaturesAt cachedDynamicConfigs cachedExperimentData cachedExperimentFeatures metricsStatusCache metricsStatusCacheByPrincipal clientDataCache groveConfigCache passesEligibilityCache modelAccessCache firstStartTime numStartups"
SHELL_FILES="$HOME/.zshrc $HOME/.zprofile $HOME/.zshenv $HOME/.zlogin $HOME/.bash_profile $HOME/.bashrc $HOME/.profile"
CLAUDE_DESKTOP_DIR="$HOME/Library/Application Support/Claude"
DESKTOP_MODE_FILES="$HOME/Library/Application Support/Claude-3p/claude_desktop_config.json|$CLAUDE_DESKTOP_DIR/claude_desktop_config.json"
CS="$HOME/.claude/settings.json"

# ---- JSON 读写（macOS 自带 JavaScript，不依赖 Python） ----
jget()  { osascript -l JavaScript -e 'function run(a){var o=JSON.parse(a[0]);var b=a[1];if(b.indexOf("return")<0)b="return ("+b+")";var v;try{v=new Function("o",b)(o)}catch(e){v=null}return (v===undefined||v===null)?"":(typeof v==="object"?JSON.stringify(v):String(v))}' "$1" "$2" 2>/dev/null; }
jedit() { osascript -l JavaScript -e 'function run(a){var fm=$.NSFileManager.defaultManager;var o={};if(fm.fileExistsAtPath(a[0])){var s=$.NSString.stringWithContentsOfFileEncodingError(a[0],$.NSUTF8StringEncoding,null).js;o=JSON.parse(s)}new Function("o",a[1])(o);$(JSON.stringify(o,null,2)).writeToFileAtomicallyEncodingError(a[0],true,$.NSUTF8StringEncoding,null);return "ok"}' "$1" "$2" >/dev/null 2>&1; }

# ---- 系统级操作统一入口（沙箱里只记日志） ----
sysrun()   { if [ -n "$TR" ]; then echo "$*" >>"$TR/sys.log"; return 0; fi; "$@"; }
lc_get()   { if [ -n "$TR" ]; then grep -E "^$1=" "$TR/launchctl.env" 2>/dev/null | head -1 | cut -d= -f2-; else launchctl getenv "$1" 2>/dev/null; fi; }
lc_unset() { if [ -n "$TR" ]; then echo "launchctl unsetenv $1" >>"$TR/sys.log"; sed -i '' "/^$1=/d" "$TR/launchctl.env" 2>/dev/null; else launchctl unsetenv "$1"; fi; }
sys_tz()   { if [ -n "$TR" ]; then cat "$TR/localtime" 2>/dev/null; else readlink /etc/localtime | sed 's#.*/zoneinfo/##'; fi; }
tz_auto()  { if [ -n "$TR" ]; then cat "$TR/tzauto" 2>/dev/null || echo 1; else defaults read /Library/Preferences/com.apple.timezone.auto Active 2>/dev/null || echo 1; fi; }
set_tz()   { if [ -n "$TR" ]; then echo "set timezone $1" >>"$TR/sys.log"; echo "$1" >"$TR/localtime"; return 0; fi
             sudo systemsetup -settimezone "$1" >/dev/null 2>&1 || sudo ln -sf "/usr/share/zoneinfo/$1" /etc/localtime; }
tz_auto_off() { if [ -n "$TR" ]; then echo "disable auto timezone" >>"$TR/sys.log"; echo 0 >"$TR/tzauto"; return 0; fi
             sudo defaults write /Library/Preferences/com.apple.timezone.auto Active -bool false; }
sys_lang() { if [ -n "$TR" ]; then head -1 "$TR/lang" 2>/dev/null; else defaults read -g AppleLanguages 2>/dev/null | sed -n 2p | tr -d ' ",'; fi; }
set_lang() {
  if [ -n "$TR" ]; then
    echo "set language en-US" >>"$TR/sys.log"
    { echo en-US; grep -vxE 'en-US|en' "$TR/lang" 2>/dev/null; } >"$TR/lang.new"; mv "$TR/lang.new" "$TR/lang"; echo en_US >"$TR/locale"; return 0
  fi
  local rest=() l
  while IFS= read -r l; do l=$(printf '%s' "$l" | tr -d ' ",'); case "$l" in ''|'('|')'|en-US|en) ;; *) rest+=("$l");; esac; done < <(defaults read -g AppleLanguages 2>/dev/null)
  defaults write -g AppleLanguages -array en-US ${rest[@]+"${rest[@]}"}
  defaults write -g AppleLocale -string en_US
}
quit_claude_desktop() { sysrun osascript -e 'quit app "Claude"' 2>/dev/null; [ -n "$TR" ] || sleep 2; }

# 代理类变量只有指向本机（127.0.0.1 / localhost，通常是你的代理软件）才保留；中转/证书类一律停用
env_is_bad() { # name value
  case "$1" in
    NO_PROXY|no_proxy) printf '%s' "$2" | grep -qiE 'claude|anthropic' ;;
    HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|CLAUDE_CODE_HTTP_PROXY|CLAUDE_CODE_HTTPS_PROXY|CLAUDE_CODE_PROXY_URL)
      ! printf '%s' "$2" | grep -qE '^(https?|socks5h?)://(127\.0\.0\.1|localhost):[0-9]+/?$' ;;
    *) return 0 ;;
  esac
}

printf '\033[1mClaude 本机环境清理\033[0m（所有改动先备份到 ~/.claude-clean-backup/%s）\n' "$TS"
mkdir -p "$BK"

# ===== 1. 环境变量 =====
step 1 "清理会干扰 Claude 的环境变量（中转地址、密钥、指向别处的代理）"
FOUND=0
for f in $SHELL_FILES; do
  [ -f "$f" ] || continue
  BADLINES=""
  while IFS=: read -r n line; do
    [ -n "$n" ] || continue
    kv=$(printf '%s\n' "$line" | sed -E 's/^export[[:space:]]+//'); name=${kv%%=*}
    val=$(printf '%s\n' "${kv#*=}" | sed -E "s/[[:space:]]+#.*$//; s/^['\"]//; s/['\"]$//")
    env_is_bad "$name" "$val" && { BADLINES="$BADLINES $n"; printf '  %s 第 %s 行：%s=…\n' "${f/#$HOME/~}" "$n" "$name"; }
  done < <(grep -nE "$BAD_ENV_RE" "$f")
  [ -n "$BADLINES" ] || continue
  FOUND=1
  cp "$f" "$BK/$(basename "$f")"
  for n in $BADLINES; do sed -i '' "${n}s/^/# [claude-clean 已停用 $TS] /" "$f"; done
done
for v in $BAD_ENV_NAMES; do
  val=$(lc_get "$v")
  if [ -n "$val" ] && env_is_bad "$v" "$val"; then FOUND=1; printf '  系统级（launchctl）：%s\n' "$v"; lc_unset "$v"; fi
done
if [ -f "$CS" ]; then
  CS_PAIRS=$(jget "$(cat "$CS")" 'var e=o.env||{};return Object.keys(e).filter(k=>"'"$BAD_ENV_NAMES"'".split(" ").indexOf(k)>=0).map(k=>k+"="+e[k]).join("\n")')
  CS_BAD=""
  while IFS= read -r kv; do [ -n "$kv" ] && env_is_bad "${kv%%=*}" "${kv#*=}" && CS_BAD="$CS_BAD ${kv%%=*}"; done <<<"$CS_PAIRS"
  [ -n "$(jget "$(cat "$CS")" 'o.apiKeyHelper')" ] && CS_BAD="$CS_BAD apiKeyHelper"
  if [ -n "$CS_BAD" ]; then
    FOUND=1; printf '  ~/.claude/settings.json：%s\n' "$CS_BAD"
    cp "$CS" "$BK/claude-settings.json"
    jedit "$CS" 'var bad="'"${CS_BAD# }"'".split(" ");bad.forEach(function(k){if(k==="apiKeyHelper")delete o.apiKeyHelper;else if(o.env)delete o.env[k]})'
  fi
fi
if [ "$FOUND" = 0 ]; then c_ok "没有发现会干扰的环境变量"; else c_ok "以上项目已停用（原文件已备份）"; note "停用了会干扰 Claude 的环境变量"; fi

# ===== 2. Claude Code =====
step 2 "Claude Code：清理旧设备标识、旧配置备份和遥测缓存（不会退出登录）"
mkdir -p "$HOME/.claude"
[ -f "$CS" ] && [ ! -f "$BK/claude-settings.json" ] && cp "$CS" "$BK/claude-settings.json"
jedit "$CS" 'o.env=o.env||{};"'"$TELEMETRY_ENV"'".split(" ").forEach(function(k){o.env[k]="1"})'
c_ok "已关闭 Claude Code 遥测和错误上报"; note "关闭了 Claude Code 遥测"
CC=0
if [ -f "$HOME/.claude.json" ]; then
  cp "$HOME/.claude.json" "$BK/claude.json"
  jedit "$HOME/.claude.json" '"'"$CC_ID_KEYS"'".split(" ").forEach(function(k){delete o[k]})'
  CC=1
fi
mkdir -p "$BK/old"
for p in "$HOME"/.claude.json.backup* "$HOME/.claude/backups" "$HOME/.claude/statsig" "$HOME/.claude/telemetry" \
         "$HOME/.claude/stats-cache.json" "$HOME/.claude/usage-data" "$HOME/.claude/usage.jsonl" "$HOME/Library/Caches/claude-cli-nodejs"; do
  [ -e "$p" ] && { mv "$p" "$BK/old/"; CC=1; }
done
if [ "$CC" = 1 ]; then c_ok "设备/统计/实验标识、旧配置备份、遥测缓存已清理"; note "清理了 Claude Code 旧设备标识"
else c_ok "这台电脑还没用过 Claude Code，不需要清理"; fi

# ===== 3. 桌面版 =====
step 3 "Claude 桌面版：清理旧设备标识，改回官方登录"
DESK=0
if [ -d "$CLAUDE_DESKTOP_DIR" ]; then
  quit_claude_desktop
  mkdir -p "$BK/desktop"
  for p in ant-did ant-device-registry.json sentry Crashpad; do [ -e "$CLAUDE_DESKTOP_DIR/$p" ] && { mv "$CLAUDE_DESKTOP_DIR/$p" "$BK/desktop/"; DESK=1; }; done
fi
i=0; IFS='|'
for f in $DESKTOP_MODE_FILES; do
  [ -f "$f" ] && grep -Eq '"deploymentMode"[[:space:]]*:[[:space:]]*"3p"' "$f" || continue
  [ "$DESK" = 2 ] || quit_claude_desktop
  i=$((i+1)); mkdir -p "$BK/desktop-mode"; cp "$f" "$BK/desktop-mode/$i-claude_desktop_config.json"
  jedit "$f" 'if(o.deploymentMode==="3p")o.deploymentMode="1p"'; DESK=2
done
unset IFS
if [ "$DESK" = 2 ]; then c_ok "桌面版已从「第三方 API 模式」改回官方登录，设备标识已清理"; note "桌面版改回官方登录"
elif [ "$DESK" = 1 ]; then c_ok "桌面版设备标识已清理（登录状态保留）"; note "清理了桌面版旧设备标识"
else c_ok "没有需要清理的桌面版数据"; fi

# ===== 4. 时区 / 语言（可选） =====
if [ -n "$TZNAME" ] || [ -n "$LANG_EN" ]; then
  step 4 "时区和语言"
  if [ -n "$TZNAME" ]; then
    if [ "$(tz_auto)" != 0 ] || [ "$(sys_tz)" != "$TZNAME" ]; then
      [ -n "$TR" ] || printf '  改时区需要输入一次开机密码（输入时不显示）\n'
      [ "$(tz_auto)" = 0 ] || tz_auto_off
      [ "$(sys_tz)" = "$TZNAME" ] || set_tz "$TZNAME"
    fi
    if [ "$(sys_tz)" = "$TZNAME" ]; then c_ok "已关闭自动时区，电脑时区：$TZNAME"; note "时区改成 $TZNAME"
    else c_warn "时区没改成功，请在「系统设置 → 通用 → 日期与时间」手动改成 $TZNAME"; fi
  fi
  if [ -n "$LANG_EN" ]; then
    [ "$(sys_lang)" = en-US ] || set_lang
    c_ok "系统语言：英语排第一（原来的中文和输入法保留），重启电脑后生效"; note "系统语言英语优先"
  fi
fi

printf '\n\033[1m清理完成 ✅\033[0m\n'
for d in ${DONE[@]+"${DONE[@]}"}; do printf '  · %s\n' "$d"; done
printf '  备份位置：~/.claude-clean-backup/%s\n' "$TS"
printf '  请关闭并重新打开终端、浏览器和 Claude 桌面版，再继续下一步。\n'
