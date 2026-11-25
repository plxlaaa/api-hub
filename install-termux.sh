#!/data/data/com.termux/files/usr/bin/bash
#
# API Hub —— Termux (Android) 一键安装脚本 v2
#
# 用法（Termux 内执行）：
#   bash install-termux.sh            # 安装到 ~/api-hub（已存在则升级）
#   bash install-termux.sh ~/mydir    # 安装到指定目录
#   bash install-termux.sh --boot     # 仅配置开机自启（需先装 Termux:Boot 插件）
#   bash install-termux.sh --update   # 升级：拉代码 → 重建 → 重启服务
#
# 原理：Android 上 Prisma query engine 无法加载（glibc vs bionic），
# 本项目内置 node:sqlite 纯绑定驱动适配器，DB_DRIVER 在 Android 上自动切换，
# 全程零原生编译依赖。要求 Node >= 22.5（node:sqlite 内置模块）。
#
set -euo pipefail

REPO="https://github.com/plxlaaa/api-hub.git"
TARGET_DIR="$HOME/api-hub"
BOOT_DIR="$HOME/.termux/boot"

say()  { printf '\033[1;32m[termux]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[termux]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[termux]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 环境检查 ----------
[ -d "/data/data/com.termux" ] || die "本脚本仅适用于 Termux 环境（当前不是 Termux）"
[ "${1:-}" = "--boot" ] && BOOT_ONLY=1 || BOOT_ONLY=0

say "检测 Termux 环境 …… OK"

# Termux 包管理器
if ! command -v pkg >/dev/null 2>&1; then
  die "未找到 pkg 命令，请先更新 Termux：apt update && apt upgrade"
fi

# ---------- 1. 依赖安装（nodejs / git）----------
ensure_deps() {
  if ! command -v node >/dev/null 2>&1; then
    say "安装 Node.js ……"
    pkg install -y nodejs
  else
    say "Node.js 已安装：$(node -v)"
  fi

  if ! command -v git >/dev/null 2>&1; then
    say "安装 git ……"
    pkg install -y git
  fi

  # Node 版本检查（node:sqlite 需要 22.5+）
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    die "Node 版本过低（$(node -v)，需要 >= 22.5）。请执行：pkg upgrade nodejs"
  fi
  node -e "require('node:sqlite')" 2>/dev/null || die "当前 Node 无 node:sqlite 模块，请升级：pkg upgrade nodejs"
  say "Node $(node -v) 满足要求"
}

# ---------- 2. 服务管理脚本 api-hub.sh ----------
# start / stop / restart / status / watchdog（boot 自启用 watchdog 模式）
write_service_scripts() {
  say "生成服务管理脚本 api-hub.sh ……"
  cat > "$TARGET_DIR/api-hub.sh" <<'SVC'
#!/data/data/com.termux/files/usr/bin/bash
# API Hub Termux 服务管理：start | stop | restart | status | watchdog
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.server.pid"
LOG_FILE="$DIR/server.log"
PORT="${API_HUB_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start_server() {
  if is_running; then echo "已在运行（PID $(cat "$PID_FILE")）"; return 0; fi
  rm -f "$PID_FILE"
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
  cd "$DIR"
  echo "$(date '+%F %T') 启动 api-hub（端口 $PORT）" >> "$LOG_FILE"
  nohup env NODE_ENV=production DB_DRIVER=node-sqlite \
    node .next/standalone/server.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  # 等待探活（最多 15s）
  for _ in $(seq 1 15); do
    sleep 1
    curl -fsS "$HEALTH_URL" >/dev/null 2>&1 && break
  done
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "启动成功：http://localhost:$PORT（PID $(cat "$PID_FILE")）"
  else
    echo "启动后未探活成功，查看日志：tail -50 $LOG_FILE"
  fi
}

stop_server() {
  if is_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "已停止"
  else
    echo "未在运行"
  fi
}

case "${1:-status}" in
  start)   start_server ;;
  stop)    stop_server ;;
  restart) stop_server; sleep 1; start_server ;;
  status)
    if is_running; then
      if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
        echo "运行中（PID $(cat "$PID_FILE")），健康检查通过：http://localhost:$PORT"
      else
        echo "进程在（PID $(cat "$PID_FILE")）但健康检查失败，日志：tail -50 $LOG_FILE"
      fi
    else
      echo "未在运行"
    fi
    ;;
  watchdog)
    # 看门狗：30s 轮询健康检查，3 连败自动重启（前台运行，配 Termux:Boot 自启）
    echo "$(date '+%F %T') 看门狗启动（30s 轮询，3 连败重启）" >> "$LOG_FILE"
    FAIL=0
    while true; do
      sleep 30
      if curl -fsS --max-time 8 "$HEALTH_URL" >/dev/null 2>&1; then
        FAIL=0
      else
        FAIL=$((FAIL + 1))
        echo "$(date '+%F %T') 健康检查失败 $FAIL/3" >> "$LOG_FILE"
        if [ "$FAIL" -ge 3 ]; then
          echo "$(date '+%F %T') 3 连败，自动重启服务" >> "$LOG_FILE"
          stop_server
          start_server
          FAIL=0
        fi
      fi
    done
    ;;
  *) echo "用法：$0 start|stop|restart|status|watchdog" ;;
esac
SVC
  chmod +x "$TARGET_DIR/api-hub.sh"
}

# ---------- 3. Boot 自启（Termux:Boot 插件）----------
write_boot_entry() {
  if ! [ -d "$BOOT_DIR" ]; then
    warn "未检测到 $BOOT_DIR（Termux:Boot 插件未安装或未运行过）"
    warn "自启配置跳过。安装方法：F-Droid 装 Termux:Boot → 打开一次 → 重跑：bash $0 --boot"
    return 1
  fi
  cat > "$BOOT_DIR/api-hub.sh" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock 2>/dev/null
bash "$HOME/api-hub/api-hub.sh" watchdog
BOOT
  chmod +x "$BOOT_DIR/api-hub.sh"
  say "开机自启已写入 $BOOT_DIR/api-hub.sh（开机后自动拉起网关+看门狗）"
}

# ---------- 4. 安装/升级流程 ----------
install_flow() {
  ensure_deps

  if [ -d "$TARGET_DIR/.git" ]; then
    say "目录已存在，拉取最新代码：$TARGET_DIR"
    git -C "$TARGET_DIR" pull --ff-only || warn "拉取失败（本地有改动？），继续用当前代码构建"
  else
    say "克隆仓库到 $TARGET_DIR ……"
    git clone "$REPO" "$TARGET_DIR"
  fi
  cd "$TARGET_DIR"

  say "安装 npm 依赖（约 800+ 包，需要几分钟）……"
  npm install --no-audit --no-fund

  # npm 11 会拦截 install scripts（@prisma/engines 引擎下载）。
  # Termux 上反正不用 Prisma 引擎（自动切 node:sqlite），跳过不影响。
  node node_modules/prisma/build/index.js generate 2>/dev/null \
    || npx prisma generate \
    || warn "prisma generate 失败（不影响 Termux 运行，仅影响本地类型提示）"

  say "生产构建（next build，需要几分钟）……"
  npm run build

  write_service_scripts

  say "运行环境自检 doctor ……"
  node doctor.mjs || true

  # 默认直接拉起服务 + 尝试配自启
  "$TARGET_DIR/api-hub.sh" start || true
  write_boot_entry || true
}

# ---------- 主流程 ----------
if [ "$BOOT_ONLY" = "1" ]; then
  [ -x "$TARGET_DIR/api-hub.sh" ] || die "先完成安装（不带参数跑一次）再配自启"
  write_boot_entry
  exit 0
fi

install_flow

cat <<'EOF'

============================================================
  安装完成！
============================================================
常用命令（cd ~/api-hub 后）：

  bash api-hub.sh status     # 状态 + 健康检查
  bash api-hub.sh restart    # 重启
  bash api-hub.sh stop       # 停止

  浏览器访问：http://localhost:3000

注意事项：
  1. 首次启动自动建表（db/custom.db）；Android 自动用 node:sqlite 驱动
  2. 看门狗已内置：健康检查 3 连败自动重启（30s 轮询）
  3. 开机自启：装 Termux:Boot 插件（F-Droid）→ 打开一次 → 跑
     bash install-termux.sh --boot，之后重启手机自动拉起网关
  4. 升级版本：bash install-termux.sh（拉代码→重建→重启，一条龙）
============================================================
EOF
