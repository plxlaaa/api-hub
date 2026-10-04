#!/usr/bin/env bash
# ============================================================
#  API Hub 一键安装脚本（Linux 版）
#  适用：Ubuntu / Debian / RHEL / CentOS / Fedora / Alpine / Arch / openSUSE
#  用法：
#    sudo GITHUB_TOKEN=ghp_xxx bash install-api-hub.sh
#    sudo bash install-api-hub.sh --token ghp_xxx --domain hub.example.com
#    sudo bash install-api-hub.sh --update          # 更新代码（保留数据库）
#    sudo bash install-api-hub.sh --uninstall       # 卸载（保留数据库）
#    sudo bash install-api-hub.sh --precheck        # 只做环境自检
#    sudo bash install-api-hub.sh --status          # 查看运行状态与设置令牌
#    sudo bash install-api-hub.sh --docker          # 容器化部署（无 root/无 systemd 首选）
#  参数：
#    -t/--token    GitHub PAT（需 repo 读权限，私有仓库必填；也可用环境变量 GITHUB_TOKEN）
#    -d/--dir      安装目录（默认 /opt/api-hub）
#    -p/--port     监听端口（默认 3000）
#    -b/--branch   分支（默认 main）
#       --domain   域名，填了就自动装 Caddy 并签发 HTTPS 证书
#       --cn       走国内镜像（npmmirror），国内机器加这个
#       --docker   用 Docker Compose 部署（容器内自带 Node，无需本机装环境）
#       --firewall 自动放行端口（ufw / firewalld）
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
DOCKER=0
FIREWALL=0

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
       --docker)   DOCKER=1; shift;;
       --firewall) FIREWALL=1; shift;;
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

has_systemd() {
  [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1
}

# ============================================================
# 状态查看
# ============================================================
do_status() {
  step "运行状态"
  if [[ $DOCKER -eq 1 ]] && command -v docker >/dev/null 2>&1; then
    docker compose -f "$INSTALL_DIR/docker-compose.yml" ps 2>/dev/null || true
  fi
  if has_systemd; then
    systemctl is-active --quiet "$SERVICE_NAME" && ok "服务运行中" || err "服务未运行"
    systemctl status "$SERVICE_NAME" --no-pager -l | head -20 || true
    echo; info "最近日志：journalctl -u $SERVICE_NAME -f"
  else
    warn "无 systemd，改查进程与端口"
    pgrep -af "next start|standalone/server.js" | head -5 || true
    if command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null | grep ":$PORT" || true; fi
    [[ -f "$INSTALL_DIR/server.log" ]] && { echo; info "最近日志：tail -50 $INSTALL_DIR/server.log"; }
  fi
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
  if [[ -f "$INSTALL_DIR/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    docker compose -f "$INSTALL_DIR/docker-compose.yml" down 2>/dev/null || true
    ok "Docker 容器已停止并移除"
  fi
  if has_systemd; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    ok "服务已停止并移除"
  else
    # 无 systemd：按启动命令特征精确匹配本项目进程，避免误杀其他 node 进程
    local pids
    pids=$(pgrep -f "next start -p $PORT|standalone/server.js" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 1
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
      ok "已停止相关进程（$pids）"
    else
      info "未发现本项目的运行进程"
    fi
  fi
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
  if ! has_systemd; then
    warn "未检测到 systemd（容器 / 精简镜像 / WSL？）。将降级为 nohup 常驻 + crontab @reboot"
    warn "生产环境更推荐：sudo bash $0 --docker --token <PAT>"
  fi
  local mem_mb disk_mb
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  # 磁盘按安装目录所在分区算（自定义 -d 时 /opt 的余量没有参考意义）
  disk_mb=$(df -Pm "$INSTALL_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}' || echo 0)
  [[ "${disk_mb:-0}" -lt 3000 ]] && warn "磁盘剩余 ${disk_mb}MB，依赖+构建产物约需 2GB"
  [[ "${mem_mb:-0}" -lt 1500 ]] && warn "内存 ${mem_mb}MB 偏小，next build 可能需要 1.5GB+，构建失败请加 swap"
  ok "内存 ${mem_mb}MB / 磁盘余量 ${disk_mb}MB / 包管理器 ${PKG_MGR:-未知}"
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
  command -v systemctl >/dev/null || die "未找到 systemctl：本脚本依赖 systemd（Ubuntu 24.04 默认有）。无 systemd 环境请用 --docker 或脚本会自动降级为 nohup"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  ok "服务已注册：$SERVICE_NAME（$start_cmd）"
}

start_and_verify() {
  step "启动并健康检查"
  if has_systemd; then
    systemctl restart "$SERVICE_NAME"
  elif [[ $DOCKER -eq 1 ]]; then
    docker compose -f "$INSTALL_DIR/docker-compose.yml" ps || true
  else
    write_nohup_service
  fi
  local i code
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null || echo 000)
    if [[ "$code" =~ ^(200|20[1-9]|30[0-9]|40[0-9])$ ]]; then
      ok "服务已就绪（${i}s，HTTP $code）：http://127.0.0.1:$PORT"
      return 0
    fi
    sleep 1
  done
  if has_systemd; then
    err "60s 内未通过健康检查，看日志：journalctl -u $SERVICE_NAME -n 100 --no-pager"
  else
    err "60s 内未通过健康检查，看日志：tail -100 $INSTALL_DIR/server.log"
  fi
  exit 1
}

setup_caddy() {
  [[ -z "$DOMAIN" ]] && return 0
  step "配置 Caddy + HTTPS（$DOMAIN）"
  # 已有 Caddy 则直接复用，不重复安装
  if command -v caddy >/dev/null 2>&1; then
    info "检测到已安装 Caddy，跳过安装"
  else
    case "$PKG_MGR" in
      apt-get)
        apt-get update -qq
        apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
          -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
          -o /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -qq
        apt-get install -y -qq caddy;;
      dnf|yum)
        "$PKG_MGR" install -y 'dnf-command(copr)' 2>/dev/null || true
        "$PKG_MGR" install -y copr-gpg-release-caddy 2>/dev/null || true
        if ! "$PKG_MGR" install -y caddy; then
          warn "发行版仓库装 Caddy 失败，改用官方二进制"
          install_caddy_binary
        fi;;
      apk) apk add --no-cache caddy;;
      pacman) "$PKG_MGR" -S --noconfirm --needed caddy 2>/dev/null || install_caddy_binary;;
      zypper) "$PKG_MGR" install -y caddy 2>/dev/null || install_caddy_binary;;
      *) warn "未识别包管理器，改用官方二进制安装 Caddy"; install_caddy_binary;;
    esac
  fi
  command -v caddy >/dev/null || die "Caddy 安装失败，可手动安装后重跑，或自行用 Nginx 反代 127.0.0.1:$PORT"

  mkdir -p /etc/caddy
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
		header_up X-Forwarded-Proto {scheme}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
	}
	log {
		output file /var/log/caddy/access.log
	}
}
EOF
  # X-Real-IP / X-Forwarded-For 必须由反代覆盖写入：管理台的登录防爆破只信任这两个头，
  # 若不注入，客户端可自带该头伪造 IP 绕过锁定。
  if has_systemd; then
    systemctl enable --now caddy 2>/dev/null || true
    systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
  else
    warn "无 systemd，Caddy 未自动启动；请自行管理 caddy 进程"
  fi
  ok "Caddy 已配置，证书自动签发（需域名已解析到本机、80/443 放行）"
}

# Caddy 官方二进制兜底安装（无发行版包时）
install_caddy_binary() {
  local arch ver
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64;;
    aarch64|arm64) arch=arm64;;
    *) die "当前架构 $(uname -m) 无官方 Caddy 二进制，请手动安装";;
  esac
  ver=$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest \
        | grep -o '"tag_name": *"v[0-9.]*"' | head -1 | sed 's/.*"v/v/;s/"//') \
    || die "无法获取 Caddy 最新版本号（网络不通？）"
  info "安装 Caddy $ver ($arch) 官方二进制"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/${ver}/caddy_${ver}_linux_${arch}.tar.gz" \
    -o /tmp/caddy.tgz || die "Caddy 二进制下载失败"
  tar xzf /tmp/caddy.tgz -C /tmp caddy && install -m 0755 /tmp/caddy /usr/local/bin/caddy
  rm -f /tmp/caddy /tmp/caddy.tgz
  ok "Caddy 已安装到 /usr/local/bin/caddy"
}

# ---------- 防火墙 ----------
setup_firewall() {
  step "放行端口 $PORT"
  if command -v ufw >/dev/null 2>&1; then
    ufw allow "$PORT/tcp" >/dev/null 2>&1 && ok "ufw 已放行 TCP $PORT" || warn "ufw 放行失败（可能未启用）"
  elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 \
      && ok "firewalld 已放行 TCP $PORT" || warn "firewalld 放行失败"
  elif command -v nft >/dev/null 2>&1; then
    warn "检测到 nftables，请自行放行 TCP $PORT"
  else
    info "未检测到 ufw/firewalld，跳过（如有云厂商安全组需手动放行 $PORT）"
    return 0
  fi
  # 管理面板带明文密钥，仅本机访问时完全不需要放行端口
  warn "若只在本机或内网使用，建议不放行公网：管理台含明文 API Key，裸 HTTP 会让登录密码明文过网"
}

# ============================================================
# Docker 部署（无 systemd / 无 root 权限的环境首选）
# ============================================================
do_docker_deploy() {
  step "Docker 部署"
  command -v docker >/dev/null 2>&1 || die "未安装 Docker。请先装 Docker Engine + Compose 插件：
  Debian/Ubuntu: https://docs.docker.com/engine/install/debian/
  RHEL/CentOS:   https://docs.docker.com/engine/install/centos/
  或改用默认安装：sudo bash $0 --token <PAT>"

  docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1 \
    || die "未找到 docker compose 插件，请安装（apt install docker-compose-plugin）"

  # 需要源码：docker-compose.yml 与 Dockerfile 在仓库里
  fetch_source

  cd "$INSTALL_DIR"
  [[ -f docker-compose.yml ]] || die "仓库中缺少 docker-compose.yml，无法容器化部署"

  # .env 供 compose 变量插值（端口与镜像源）
  if [[ $CN -eq 1 ]]; then
    printf 'PORT=%s\nCN_MIRROR=1\n' "$PORT" > .env
  else
    printf 'PORT=%s\n' "$PORT" > .env
  fi

  # 更新前备份数据库（容器卷里的库）
  if [[ -d "$INSTALL_DIR/db" ]]; then
    local bak="/opt/api-hub-backups/db-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$bak"
    cp -a "$INSTALL_DIR/db/." "$bak/" 2>/dev/null || true
    ok "数据库已备份到 $bak"
  fi

  docker compose up -d --build
  ok "容器已启动"
  start_and_verify
  print_summary
  exit 0
}

# ============================================================
# 无 systemd 时的兜底：nohup 常驻 + 启动脚本
# ============================================================
write_nohup_service() {
  step "注册常驻进程（无 systemd 环境）"
  cd "$INSTALL_DIR"
  local next_bin
  for cand in "$INSTALL_DIR/node_modules/next/dist/bin/next" "$INSTALL_DIR/node_modules/.bin/next"; do
    [[ -f "$cand" ]] && { next_bin="$cand"; break; }
  done
  [[ -z "$next_bin" ]] && next_bin="$INSTALL_DIR/node_modules/.bin/next"

  cat > "$INSTALL_DIR/run.sh" <<EOF
#!/usr/bin/env bash
# API Hub 启动脚本（由 install-api-hub.sh 生成）
# 工作目录必须是项目根：Prisma 与凭据文件都按 cwd 定位 db/
cd "\$(dirname "\${BASH_SOURCE[0]}")"
export NODE_ENV=production
export PORT=$PORT
export HOSTNAME=0.0.0.0
export NEXT_TELEMETRY_DISABLED=1
exec "$BUN_BIN" "$next_bin" start -p $PORT
EOF
  chmod +x "$INSTALL_DIR/run.sh"

  # setsid 让进程脱离当前会话，SSH 断开后仍存活
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$INSTALL_DIR/run.sh" >> "$INSTALL_DIR/server.log" 2>&1 < /dev/null &
  else
    nohup "$INSTALL_DIR/run.sh" >> "$INSTALL_DIR/server.log" 2>&1 < /dev/null &
  fi
  disown 2>/dev/null || true
  ok "已后台启动（nohup），日志：$INSTALL_DIR/server.log"

  if command -v crontab >/dev/null 2>&1; then
    # 开机自启兜底：用 @reboot 拉起（crond 需已启用）
    local line="@reboot $INSTALL_DIR/run.sh"
    if crontab -l 2>/dev/null | grep -qF "$INSTALL_DIR/run.sh"; then
      info "crontab 已存在 @reboot 启动项"
    else
      ( crontab -l 2>/dev/null; echo "$line" ) | crontab - 2>/dev/null \
        && ok "已写入 crontab @reboot 开机自启" \
        || warn "crontab 写入失败，请手动配置开机自启"
    fi
  fi
  warn "本环境无 systemd，未注册系统服务。生产环境建议用 Docker（--docker）或带 systemd 的机器"
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
  # --docker 模式完全走容器化流程，不装本机 Node/bun
  if [[ $DOCKER -eq 1 && ( "$ACTION" == "install" || "$ACTION" == "update" ) ]]; then
    do_docker_deploy
    return 0
  fi

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
      if has_systemd; then write_service; fi
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
      if has_systemd; then write_service; fi
      start_and_verify
      setup_caddy
      [[ $FIREWALL -eq 1 || -n "$DOMAIN" ]] && setup_firewall
      print_summary;;
  esac
}
main
