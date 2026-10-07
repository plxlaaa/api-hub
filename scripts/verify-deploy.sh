#!/usr/bin/env bash
# ============================================================
#  API Hub 部署自检脚本（Linux / macOS 通用，零依赖）
#
#  用法：
#    bash scripts/verify-deploy.sh                # 检查本机默认 http://127.0.0.1:3000
#    bash scripts/verify-deploy.sh http://127.0.0.1:8080
#    PORT=8080 bash scripts/verify-deploy.sh
#
#  退出码：0 = 全部通过；1 = 有检查项失败
#
#  为什么需要它：
#  装完最容易踩的坑不是「装不上」，而是「装上了但服务没真正可用」——
#  进程在跑但数据库连不上、端口被占用、systemd 单元写错、被旧的 nohup 进程占着端口。
#  本脚本把这些一次性查清楚，避免用户逐条手动排查。
# ============================================================
set -uo pipefail

PORT="${PORT:-3000}"
BASE="${1:-http://127.0.0.1:${PORT}}"
BASE="${BASE%/}"

# 显式传了 URL 时，从中解析端口用于第2 项的监听检查——
# 否则传 http://127.0.0.1:8080 却在 3000 上找监听，必然误报。
case "$BASE" in
  *:[0-9]*)
    _p="${BASE##*:}"
    _p="${_p%%/*}"
    case "$_p" in
      ''|*[!0-9]*) ;;                    # 不是合法端口则保持默认
      *) PORT="$_p" ;;
    esac
    ;;
esac

PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
info() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 探测命令：优先 curl，退化到 wget（最小化容器里常常没有 curl）
http_get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=5 "$1" 2>/dev/null
  else
    return 127
  fi
}

http_code() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null
  else
    return 127
  fi
}

printf '\033[1mAPI Hub 部署自检\033[0m  目标：%s\n' "$BASE"

# ---------- 1. 运行环境 ----------
info "1. 运行环境"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "Node $(node -v)"
  else
    bad "Node $(node -v) 版本过低，需要 20+（standalone 产物用了 Node 20+ 特性）"
  fi
else
  warn "未找到 node（若用二进制/tarball 部署可忽略此项）"
fi

# ---------- 2. 端口监听 ----------
info "2. 端口监听"
LISTENING=""
if command -v ss >/dev/null 2>&1; then
  LISTENING="$(ss -ltn 2>/dev/null | grep -c ":${PORT} " || true)"
elif command -v netstat >/dev/null 2>&1; then
  LISTENING="$(netstat -ltn 2>/dev/null | grep -c ":${PORT} " || true)"
fi
if [ "${LISTENING:-0}" -gt 0 ]; then
  ok "端口 ${PORT} 处于监听状态"
else
  warn "未在 ${PORT} 上侦听到进程（若走了反向代理，服务可能只绑在其它地址）"
fi

# ---------- 3. 健康检查 ----------
info "3. 健康检查（最关键的一项）"
HEALTH="$(http_get "${BASE}/api/health")"
RC=$?
if [ $RC -eq 127 ]; then
  warn "curl 与 wget 都不存在，跳过 HTTP 检查"
elif [ $RC -ne 0 ]; then
  bad "无法连接 ${BASE}/api/health —— 服务没起来，或端口/地址不对"
  printf '      排查：systemctl status api-hub  |  ss -ltnp |  journalctl -u api-hub -n 50\n'
else
  # 无 jq 时用grep 判断关键字段
  case "$HEALTH" in
    *'"ok":true'*|*'"ok": true'*)
      ok "数据库可用（status=ok）"
      ;;
    *'"degraded"'*)
      bad "数据库不可用（status=degraded）—— 进程活着但不能接流量"
      printf '      排查：ls -ld /opt/api-hub/db  权限；df -h 看磁盘是否满\n'
      ;;
    *)
      warn "健康检查返回了预期外的内容：${HEALTH:0:160}"
      ;;
  esac
  case "$HEALTH" in
    *'"db"'*) ok "响应含db 字段（版本正确）" ;;
    *) bad "响应缺少 db 字段，可能跑的是旧版本" ;;
  esac
fi

# ---------- 4. 鉴权保护 ----------
info "4. 鉴权保护"
CODE="$(http_code "${BASE}/api/overview")"
case "$CODE" in
  401|403) ok "管理接口未授权访问被拒绝（HTTP $CODE，符合预期）" ;;
  200) bad "管理接口无需鉴权即可访问 —— 危险！请检查会话配置" ;;
  000|"") warn "无法探测（服务可能未启动）" ;;
  *) warn "管理接口返回 HTTP $CODE（预期 401/403）" ;;
esac

# ---------- 5. 服务管理状态 ----------
info "5. 服务管理状态"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^api-hub.service'; then
  ENABLED="$(systemctl is-enabled api-hub 2>/dev/null || echo unknown)"
  ACTIVE="$(systemctl is-active api-hub 2>/dev/null || echo unknown)"
  [ "$ACTIVE" = "active" ] && ok "systemd：active" || bad "systemd：$ACTIVE（服务未运行）"
  [ "$ENABLED" = "enabled" ] && ok "systemd：已设开机自启" || warn "systemd：$ENABLED（未设开机自启）"
else
  warn "未检测到 api-hub.service（若用 tarball/nohup 部署可忽略）"
fi

# ---------- 6. 数据库文件 ----------
info "6. 数据与数据库"
for d in /opt/api-hub/db /var/lib/api-hub/db "$PWD/db"; do
  if [ -d "$d" ]; then
    if [ -w "$d" ]; then
      ok "$d 存在且可写"
    else
      bad "$d 存在但不可写 —— 服务将无法落库"
    fi
    break
  fi
done
if [ -f /opt/api-hub/db/custom.db ]; then
  SIZE="$(du -h /opt/api-hub/db/custom.db 2>/dev/null | cut -f1)"
  ok "数据库文件存在（${SIZE}）"
fi

# ---------- 汇总 ----------
printf '\n\033[1m检查结果：%d 项通过，%d 项失败\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '失败项请对照 INSTALL.md 的「常见问题 FAQ」处理。\n\n'
  exit 1
fi
printf '部署正常。\n\n'
exit 0