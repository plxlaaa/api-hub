#!/usr/bin/env bash
# ============================================================
#  API Hub 一键安装脚本
#  适用：Ubuntu 24.04 / 22.04 / Debian 12+（海外服务器直连）
#  用法：
#    sudo GITHUB_TOKEN=ghp_xxx bash install-api-hub.sh
#    sudo bash install-api-hub.sh --token ghp_xxx --domain hub.example.com
#    sudo bash install-api-hub.sh --update          # 更新代码（保留数据库）
#    sudo bash install-api-hub.sh --uninstall       # 卸载（保留数据库）
#    sudo bash install-api-hub.sh --precheck        # 只做环境自检
#    sudo bash install-api-hub.sh --status          # 查看运行状态与设置令牌
#  参数：
#    -t/--token    GitHub PAT（需 repo 读权限，私有仓库必填；也可用环境变量 GITHUB_TOKEN）
#    -d/--dir      安装目录（默认 /opt/api-hub）
#    -p/--port     监听端口（默认 3000）
#    -b/--branch   分支（默认 main）
#       --domain   域名，填了就自动装 Caddy 并签发 HTTPS 证书
#       --cn       走国内镜像（npmmirror），国内机器加这个
# ============================================================
set -euo pipefail

REPO_OWNER="plxlaaa"
REPO_NAME="api-hub"
BRANCH="main"
INSTALL_DIR="/opt/api-hub"
PORT="3000"
DOMAIN=""
TOKEN="${GITHUB_TOKEN:-}"
CN=0
ACTION="install"
KEEP_DB=1

SERVICE_NAME="api-hub"
BUN_BIN=""
TMP_DIR=""

# ---------- 输出 ----------
c_reset=$'\033[0m'; c_red=$'\033[31m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_cyan=$'\033[36m'
info()  { printf '%s[INFO]%s %s\n'  "$c_cyan"   "$c_reset" "$*"; }
ok()    { printf '%s[ OK ]%s %s\n'  "$c_green"  "$c_reset" "$*"; }
warn()  { printf '%s[WARN]%s %s\n'  "$c_yellow" "$c_reset" "$*"; }
err()   { printf '%s[FAIL]%s %s\n'  "$c_red"    "$c_reset" "$*" >&2; }
die()   { err "$*"; exit 1; }
step()  { printf '\n%s===== %s =====%s\n' "$c_cyan" "$*" "$c_reset"; }

# ---------- 参数 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--token)    TOKEN="${2:-}"; shift 2;;
    -d|--dir)      INSTALL_DIR="${2:-}"; shift 2;;
    -p|--port)     PORT="${2:-}"; shift 2;;
    -b|--branch)   BRANCH="${2:-}"; shift 2;;
       --domain)   DOMAIN="${2:-}"; shift 2;;
       --cn)       CN=1; shift;;
       --update)   ACTION="update"; shift;;
       --uninstall) ACTION="uninstall"; shift;;
       --purge)    KEEP_DB=0; shift;;
       --precheck) ACTION="precheck"; shift;;
       --status)   ACTION="status"; shift;;
    -h|--help)     sed -n '2,25p' "$0"; exit 0;;
    *) die "未知参数：$1（用 --help 查看用法）";;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 或 sudo 运行：sudo bash $0"
command -v curl >/dev/null || die "缺少 curl，请先安装 curl"

PKG_MGR=""
detect_pkg_mgr() {
  for m in apt-get dnf yum apk pacman zypper; do
    command -v "$m" >/dev/null 2>&1 && { PKG_MGR="$m"; return 0; }
  done
  return 0
}
detect_pkg_mgr

# ============================================================
# 状态查看
# ============================================================
do_status() {
  step "运行状态"
  systemctl is-active --quiet "$SERVICE_NAME" && ok "服务运行中" || err "服务未运行"
  systemctl status "$SERVICE_NAME" --no-pager -l | head -20 || true
  echo
  info "最近日志：journalctl -u $SERVICE_NAME -f"
  if [[ -f "$INSTALL_DIR/db/setup-token.txt" ]]; then
    echo; ok "首次设置令牌（创建管理员账号时用，建号后即焚）："
    echo "    $(cat "$INSTALL_DIR/db/setup-token.txt")"
  elif [[ -f "$INSTALL_DIR/db/credentials.env" ]]; then
    echo; ok "管理员已初始化，直接用用户名+密码登录"
  fi
  echo; info "健康检查：curl -s http://127.0.0.1:$PORT/api/auth/status"
  exit 0
}

# ============================================================
# 卸载
# ============================================================
do_uninstall() {
  step "卸载 $SERVICE_NAME"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  ok "服务已停止并移除"
  if [[ $KEEP_DB -eq 0 ]]; then
    rm -rf "$INSTALL_DIR"
    warn "已删除 $INSTALL_DIR（含数据库，不可恢复）"
  else
    ok "数据库保留在 $INSTALL_DIR/db —— 手动清理：rm -rf $INSTALL_DIR"
  fi
  exit 0
}

# ============================================================
# 环境自检
# ============================================================
preflight() {
  step "环境自检"
  local mem_mb disk_mb
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  disk_mb=$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)
  [[ $mem_mb -lt 1500 ]] && warn "内存 ${mem_mb}MB 偏小，next build 可能需要 1.5GB+，构建失败请加 swap"
  [[ $disk_mb -lt 3000 ]] && warn "磁盘剩余 ${disk_mb}MB，依赖+构建产物约需 2GB"
  ok "内存 ${mem_mb}MB / 磁盘余量 ${disk_mb}MB"
}

need_node() {
  command -v node >/dev/null 2>&1 || return 0
  local v; v=$(node -v | sed 's/^v//' | cut -d. -f1)
  [[ $v -ge 20 ]] && return 1
  return 0
}

install_node() {
  step "检查 Node.js"
  if ! need_node; then
    ok "Node.js $(node -v) 已满足要求（>= 20）"
    return 0
  fi
  warn "未检测到 Node.js 20+，尝试自动安装"
  case "$PKG_MGR" in
    apt-get)
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y -qq nodejs;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
      "$PKG_MGR" install -y nodejs;;
    apk)   "$PKG_MGR" add --no-cache nodejs npm;;
    pacman) "$PKG_MGR" -Sy --noconfirm nodejs npm;;
    zypper) "$PKG_MGR" install -y nodejs20;;
    *)
      die "未识别的包管理器，请手动安装 Node.js 20+ 后重跑：https://nodejs.org";;
  esac
  command -v node >/dev/null && [[ $(node -v | sed 's/^v//' | cut -d. -f1) -ge 20 ]] \
    || die "Node.js 安装失败，手动安装 20+ 后重跑：https://nodejs.org"
  ok "Node.js $(node -v)"
}

install_bun() {
  step "安装 bun"
  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
    mkdir -p /etc/profile.d 2>/dev/null && {
      echo 'export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"' > /etc/profile.d/bun.sh
      chmod 644 /etc/profile.d/bun.sh
    }
    export PATH="$HOME/.bun/bin:/root/.bun/bin:$PATH"
    hash -r
  fi
  BUN_BIN=$(command -v bun || true)
  [[ -z "$BUN_BIN" && -x /root/.bun/bin/bun ]] && BUN_BIN=/root/.bun/bin/bun
  [[ -n "$BUN_BIN" ]] || die "bun 安装失败，手动装：curl -fsSL https://bun.sh/install | bash"
  ok "bun $($BUN_BIN -v) → $BUN_BIN"
}

# ============================================================
# 拉取源码（私有仓库：GitHub PAT + tarball，不依赖 git ssh/https 鉴权）
# ============================================================
fetch_source() {
  step "拉取源码 $REPO_OWNER/$REPO_NAME@$BRANCH"
  if [[ -z "$TOKEN" ]]; then
    if [[ -t 0 ]]; then
      read -rsp "请输入 GitHub PAT（需 repo 读权限）：" TOKEN; echo
    else
      die "未提供 token：用 --token ghp_xxx 或 GITHUB_TOKEN=ghp_xxx bash $0"
    fi
  fi
  [[ -z "$TOKEN" ]] && die "token 为空"

  # 若本脚本已随源码包一起落在本地（同目录有 package.json + prisma/schema.prisma），
  # 直接复用本地源码，不再联网下载
  local self_dir; self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ -f "$self_dir/package.json" && -f "$self_dir/prisma/schema.prisma" && "$self_dir" != "$INSTALL_DIR" ]]; then
    step "复用本地源码（检测到 $self_dir 已是项目目录）"
    mkdir -p "$INSTALL_DIR/db"
    chmod 700 "$INSTALL_DIR/db"
    cp -a "$self_dir/." "$INSTALL_DIR/" 2>/dev/null || true
    ok "源码已就位：$INSTALL_DIR（来源 $self_dir）"
    return 0
  fi

  local tmp; tmp=$(mktemp -d); TMP_DIR="$tmp"; trap 'rm -rf "${TMP_DIR:-}"' EXIT
  local url="https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/tarball/$BRANCH"
  curl -fsSL --max-time 180 \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$url" -o "$tmp/src.tar.gz" \
    || die "下载失败：token 权限不足（需 repo scope，私有仓库要 classic PAT 勾选 repo）或网络不通"
  tar tzf "$tmp/src.tar.gz" 2>/dev/null | grep -q "package.json" \
    || die "下载内容异常（不是预期仓库包），检查 token / 仓库名 / 分支"

  # 更新前备份数据库
  if [[ -d "$INSTALL_DIR/db" ]]; then
    local bak="/opt/api-hub-backups/db-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$bak"
    cp -a "$INSTALL_DIR/db/." "$bak/" 2>/dev/null || true
    ok "数据库已备份到 $bak"
  fi

  mkdir -p "$INSTALL_DIR/db"
  chmod 700 "$INSTALL_DIR/db"
  tar xzf "$tmp/src.tar.gz" --strip-components=1 -C "$INSTALL_DIR"
  rm -rf "$tmp"
  ok "源码已就位：$INSTALL_DIR"
}

install_deps() {
  step "安装依赖"
  cd "$INSTALL_DIR"
  local registry=()
  [[ $CN -eq 1 ]] && registry=(--registry https://registry.npmmirror.com)
  if [[ -f bun.lock ]]; then
    "$BUN_BIN" install --frozen-lockfile "${registry[@]}" || "$BUN_BIN" install "${registry[@]}"
  else
    "$BUN_BIN" install "${registry[@]}"
  fi
  ok "依赖安装完成"

  step "生成 Prisma Client"
  [[ $CN -eq 1 ]] && export PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"
  "$BUN_BIN" run db:generate
  ok "Prisma Client 已生成"
}

init_db() {
  step "初始化数据库"
  cd "$INSTALL_DIR"
  if [[ -f db/custom.db ]]; then
    ok "已存在 db/custom.db，跳过初始化（绝不覆盖现有数据）"
  else
    "$BUN_BIN" run db:push
    chmod 600 db/custom.db 2>/dev/null || true
    ok "数据库已建表：db/custom.db"
  fi
}

build_app() {
  step "构建 Next.js（这步最慢，约 2-5 分钟）"
  cd "$INSTALL_DIR"
  NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 "$BUN_BIN" run build \
    || die "构建失败。常见原因：内存不足（加 swap）、依赖装不全（重跑 bun install）。日志见上方输出"
  ok "构建完成"
}

write_service() {
  step "注册 systemd 服务"
  cd "$INSTALL_DIR"
  local start_cmd
  if [[ -f "$INSTALL_DIR/node_modules/next/dist/bin/next" ]]; then
    start_cmd="$BUN_BIN $INSTALL_DIR/node_modules/next/dist/bin/next start -p $PORT"
  elif [[ -L "$INSTALL_DIR/node_modules/.bin/next" || -f "$INSTALL_DIR/node_modules/.bin/next" ]]; then
    start_cmd="$BUN_BIN $INSTALL_DIR/node_modules/.bin/next start -p $PORT"
  elif [[ -f "$INSTALL_DIR/.next/standalone/server.js" ]]; then
    warn "回退到 standalone 模式运行（若报 Prisma engine 缺失，手动 cp -r node_modules/.prisma .next/standalone/node_modules/）"
    start_cmd="$BUN_BIN $INSTALL_DIR/.next/standalone/server.js"
  else
    die "既没有 next CLI 也没有 standalone 产物：构建异常，检查 $INSTALL_DIR/.next"
  fi
  # 关键点：Prisma 与凭据文件都按 process.cwd() 定位 db/，WorkingDirectory 必须是项目根
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=API Hub - API aggregation gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOSTNAME=0.0.0.0
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=$start_cmd
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "/etc/systemd/system/${SERVICE_NAME}.service"
  command -v systemctl >/dev/null || die "未找到 systemctl：本脚本依赖 systemd（Ubuntu 24.04 默认有）。无 systemd 环境请用 Docker 或手动 nohup 启动"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  ok "服务已注册：$SERVICE_NAME（$start_cmd）"
}

start_and_verify() {
  step "启动并健康检查"
  systemctl restart "$SERVICE_NAME"
  local i code
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)
    if [[ "$code" =~ ^(200|20[1-9]|30[0-9]|40[0-9])$ ]]; then
      ok "服务已就绪（${i}s，HTTP $code）：http://127.0.0.1:$PORT"
      return 0
    fi
    sleep 1
  done
  err "60s 内未通过健康检查，看日志：journalctl -u $SERVICE_NAME -n 100 --no-pager"
  exit 1
}

setup_caddy() {
  [[ -z "$DOMAIN" ]] && return 0
  step "配置 Caddy + HTTPS（$DOMAIN）"
  [[ "$PKG_MGR" == "apt-get" ]] || die "自动装 Caddy 目前只支持 Debian/Ubuntu；其它发行版请手动装 Caddy 并反代 127.0.0.1:$PORT"
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
		header_up X-Forwarded-Proto {scheme}
		header_up X-Real-IP {remote_host}
	}
	log {
		output file /var/log/caddy/access.log
	}
}
EOF
  systemctl enable --now caddy
  systemctl reload caddy
  ok "Caddy 已启用，证书自动签发（需域名已解析到本机、80/443 放行）"
}

print_summary() {
  step "安装完成"
  echo
  echo "  管理台：  http://127.0.0.1:$PORT${DOMAIN:+  或  https://$DOMAIN}"
  echo "  安装目录：$INSTALL_DIR"
  echo "  数据库：  $INSTALL_DIR/db/custom.db（含明文 Key，勿外传）"
  echo
  local i
  for i in $(seq 1 30); do
    [[ -s "$INSTALL_DIR/db/setup-token.txt" ]] && break
    sleep 1
  done
  if [[ -s "$INSTALL_DIR/db/setup-token.txt" ]]; then
    echo "  首次设置令牌：$(cat "$INSTALL_DIR/db/setup-token.txt")"
    echo "  → 打开管理台，用它 + 自设用户名密码创建管理员（建号后令牌即焚毁）"
    echo "  → 或随时查看：cat $INSTALL_DIR/db/setup-token.txt"
  else
    echo "  管理员已初始化，直接登录即可"
  fi
  echo
  echo "  常用命令："
  echo "    看日志   journalctl -u $SERVICE_NAME -f"
  echo "    重启     systemctl restart $SERVICE_NAME"
  echo "    更新     bash $0 --update --token <PAT>"
  echo "    自检     cd $INSTALL_DIR && node doctor.mjs"
  echo
  echo "  接入客户端（AstrBot / 其他 OpenAI SDK）："
  if [[ -n "$DOMAIN" ]]; then
    echo "    Base URL  https://$DOMAIN/v1"
  else
    echo "    Base URL  http://127.0.0.1:$PORT/v1"
  fi
  echo "    API Key   sk-gw-开头那把（管理台「API 密钥」Tab 新建）"
  echo
  warn "面板若暴露公网务必走 HTTPS；裸 IP:端口 登录密码会明文过网"
}

# ============================================================
main() {
  case "$ACTION" in
    status)    do_status;;
    uninstall) do_uninstall;;
    precheck)
      preflight
      install_node
      install_bun
      ok "环境自检通过，可以安装"
      exit 0;;
    update)
      preflight
      install_node
      install_bun
      fetch_source
      install_deps
      init_db
      build_app
      write_service
      start_and_verify
      print_summary;;
    install)
      preflight
      install_node
      install_bun
      fetch_source
      install_deps
      init_db
      build_app
      write_service
      start_and_verify
      setup_caddy
      print_summary;;
  esac
}
main
