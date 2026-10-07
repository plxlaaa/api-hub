#!/data/data/com.termux/files/usr/bin/bash
#
# API Hub —— Termux (Android) 一键安装脚本
#
# 用法（Termux 内执行）：
#   bash install-termux.sh          # 安装到 ~/api-hub
#   bash install-termux.sh ~/mydir  # 安装到指定目录
#
# 原理：Android 上 Prisma query engine 无法加载（glibc vs bionic），
# 本项目内置 node:sqlite 纯绑定驱动适配器，DB_DRIVER 在 Android 上自动切换，
# 全程零原生编译依赖。要求 Node >= 22.5（node:sqlite 内置模块）。
#
set -euo pipefail

REPO="https://github.com/plxlaaa/api-hub.git"
TARGET_DIR="${1:-$HOME/api-hub}"

say()  { printf '\033[1;32m[termux]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[termux]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[termux]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 环境检查 ----------
[ -d "/data/data/com.termux" ] || die "本脚本仅适用于 Termux 环境（当前不是 Termux）"

say "检测 Termux 环境 …… OK"

# Termux 包管理器
if ! command -v pkg >/dev/null 2>&1; then
  die "未找到 pkg 命令，请先更新 Termux：apt update && apt upgrade"
fi

# ---------- 1. 依赖安装（nodejs / git）----------
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

# ---------- 2. Node 版本检查（node:sqlite 需要 22.5+）----------
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "Node 版本过低（$(node -v)，需要 >= 22.5）。请执行：pkg upgrade nodejs"
fi
node -e "require('node:sqlite')" 2>/dev/null || die "当前 Node 无 node:sqlite 模块，请升级：pkg upgrade nodejs"

say "Node $(node -v) 满足要求"

# ---------- 3. 克隆仓库 ----------
if [ -d "$TARGET_DIR/.git" ]; then
  say "目录已存在，拉取最新代码：$TARGET_DIR"
  git -C "$TARGET_DIR" pull --ff-only
else
  say "克隆仓库到 $TARGET_DIR ……"
  git clone "$REPO" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

# ---------- 4. 安装依赖 ----------
say "安装 npm 依赖（约 800+ 包，需要几分钟）……"
npm install --no-audit --no-fund

# npm 11 会拦截 install scripts（@prisma/engines 引擎下载）。
# Termux 上反正不用 Prisma 引擎（自动切 node:sqlite），跳过不影响。
# 但 prisma generate 生成 Client 类型还是要跑（纯 JS，无原生依赖）：
node node_modules/prisma/build/index.js generate 2>/dev/null \
  || npx prisma generate \
  || warn "prisma generate 失败（不影响 Termux 运行，仅影响本地类型提示）"

# ---------- 5. 构建 ----------
say "生产构建（next build，需要几分钟）……"
npm run build

# ---------- 6. 自检 ----------
say "运行环境自检 doctor ……"
node doctor.mjs || true

# ---------- 7. 完成 ----------
cat <<'EOF'

============================================================
  安装完成！
============================================================
启动（二选一）：

  开发模式：  npm run dev
  生产模式：  npm run start:node

  浏览器访问：http://localhost:3000

注意事项：
  1. 首次启动会自动建表（db/custom.db）
  2. Android 上自动使用 node:sqlite 驱动（无需 Prisma 引擎）
  3. 建议保持屏幕常亮或执行 termux-wake-lock，避免系统杀后台
  4. 手机重启后需重新进入 Termux 启动；可用 termux-services
     或 runit 做开机自启（参考 docs/TERMUX.md）
============================================================
EOF
