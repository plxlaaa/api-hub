# 安装部署指南

三套装法覆盖98% 场景，按你的环境挑一种即可。装完都是**常驻服务 + 开机自启**。

| 你的情况 | 用哪种 | 章节 |
|---------|--------|------|
| Linux 服务器（有 systemd） | 脚本安装 | [方式一](#方式一linux-脚本安装) |
| Windows 10/11 | PowerShell 脚本 | [方式二](#方式二windows-脚本安装) |
| 不想装 Node / 无root / 容器环境 | Docker | [方式三](#方式三docker-部署) |
| 想手动接管进程 | 手动部署 | [方式四](#方式四手动部署systemd--nssm) |

> **需要 GitHub PAT**：仓库为私有，拉源码需令牌（勾选 `repo` 即可）。
> 令牌只用于下载源码，脚本不会上传任何数据。别把它写进脚本或提交进仓库。

---

## 方式一：Linux 脚本安装

覆盖 Ubuntu / Debian、RHEL / CentOS / Fedora、Alpine、Arch、openSUSE（自动探测包管理器）。

```bash
T=ghp_你的GitHub令牌
curl -fsSL -H "Authorization: Bearer $T" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/plxlaaa/api-hub/contents/install-api-hub.sh \
  -o install-api-hub.sh
bash install-api-hub.sh --token "$T" --domain hub.example.com
```

脚本会依次完成：装 Node 20+ / bun → 拉源码 → 装依赖 → 生成 Prisma Client → 建库 →
构建 → 注册 systemd 服务 `api-hub` → 健康检查 → 打印首次设置令牌。

### 常用参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `-d, --dir` | 安装目录 | `/opt/api-hub` |
| `-p, --port` | 监听端口 | `3000` |
| `-b, --branch` | 安装分支 | `main` |
| `--domain` | 绑定域名，自动装 Caddy 并签 HTTPS | 无 |
| `--cn` | 走 npmmirror 国内镜像 | 关闭 |
| `--firewall` | 自动放行防火墙端口 | 关闭 |
| `--precheck` | 只做环境自检，不安装 | — |

### 运维动作

| 动作 | 命令 |
|------|------|
| 更新代码（自动备份 db） | `bash install-api-hub.sh --update --token "$T"` |
| 查看运行状态 | `bash install-api-hub.sh --status` |
| 重新打印设置令牌 | `bash install-api-hub.sh --status` |
| 只做环境自检 | `bash install-api-hub.sh --precheck` |
| 卸载（保留数据库） | `bash install-api-hub.sh --uninstall` |
| 卸载并删除数据库 | `bash install-api-hub.sh --uninstall --purge` |

### 没有 systemd 的环境

容器、精简镜像、WSL 里没有 systemd，脚本会自动**降级为前台进程 + nohup 守护**，
并提示自启方式（rc.local / crontab@reboot）。功能不受影响，只是没有
`systemctl` 那些便捷命令。

### systemd 手工配置（想自己接管时）

`deploy/systemd/api-hub.service` 是可直接使用的单元文件：

```bash
sudo cp deploy/systemd/api-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now api-hub
sudo systemctl status api-hub
journalctl -u api-hub -f          # 跟踪日志
```

---

## 方式二：Windows 脚本安装

要求 Windows 10 / 11 + PowerShell 5.1+（Win10 自带）。**需要管理员权限**，
脚本会自动请求提权（UAC 弹窗）。

```powershell
# 在 PowerShell 中执行（推荐：会自动申请管理员权限）
irm https://raw.githubusercontent.com/plxlaaa/api-hub/main/install-api-hub.ps1 -outfile install-api-hub.ps1
.\install-api-hub.ps1 -Token ghp_你的令牌 -Port 3000
```

若脚本未能自动提权，手动以管理员身份运行：

```powershell
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\install-api-hub.ps1`" -Token ghp_你的令牌"
```

### 常用参数

| 参数 | 说明 | 默认 |
|------|------|------|
| `-Port` | 监听端口 | `3000` |
| `-Dir` | 安装目录 | `C:\api-hub` |
| `-Branch` | 安装分支 | `main` |
| `-Domain` | 绑定域名（自动装 Caddy 并签 HTTPS） | 无 |
| `-Cn` | 走国内镜像 | 关闭 |
| `-ServiceUser` | 服务运行账户（默认 `LocalSystem`） | `LocalSystem` |

### 注册为 Windows 服务

脚本默认用 **NSSM** 把网关注册为 Windows 服务：

| 动作 | 命令（管理员 PowerShell） |
|------|------|
| 查看服务状态 | `Get-Service api-hub` |
| 启动 / 停止 | `Start-Service api-hub` / `Stop-Service api-hub` |
| 重启 | `Restart-Service api-hub` |
| 卸载服务 | `nssm stop api-hub; nssm remove api-hub confirm` |
| 实时日志 | 日志文件见下|

日志路径：`%ProgramData%\api-hub\logs\api-hub.err.log`（NSSM 捕获 stdout/stderr）。

> **服务注意事项**
> - 服务以 `LocalSystem` 运行时，**无盘符映射**（如 `Z:\`）不可用，路径一律写绝对路径。
> - 若要用网络路径上的数据目录，请改用 `-ServiceUser域\账号` 并授予该账号权限。
> - 卸载脚本请走 `nssm remove`，直接删文件夹会留下服务注册项。

### WSL2 部署

不想在 Windows 上装 Node、或要跑 Linux 完整环境时：

```powershell
wsl --install -d Ubuntu        # 首次需管理员 + 重启
wsl                            # 进入 Linux
```

进入 WSL 后**直接用方式一**（等同一台 Linux 机器）：

```bash
curl -fsSL -H "Authorization: Bearer $T" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/plxlaaa/api-hub/contents/install-api-hub.sh -o install-api-hub.sh
bash install-api-hub.sh --token "$T"
```

WSL2 访问 Windows 侧浏览器：浏览器打开 `http://localhost:3000`（WSL2 有端口转发）。
注意 WSL2 的 systemd 默认不启用，脚本会自动降级为 nohup 守护。

---

## 方式三：Docker 部署

### docker compose（推荐）

```bash
git clone https://github.com/plxlaaa/api-hub.git && cd api-hub
cp .env.example .env          # 可选：改端口 / 时区 / 国内镜像
docker compose up -d --build
docker compose logs -f
```

国内机器建议在 `.env` 里设`CN_MIRROR=1` 走 npmmirror 加速。

### 纯 docker run

```bash
docker build -t api-hub:latest .

docker run -d \
  --name api-hub \
  --restart unless-stopped \
  -p 3000:3000 \
  -v api-hub-data:/app/db \
  -e TZ=Asia/Shanghai \
  api-hub:latest
```

> ⚠️ **务必挂载 `/app/db`**：该目录存 SQLite 库与凭据文件，不挂载则容器一删数据就没了。

### 常用运维命令

| 动作 | 命令 |
|------|------|
| 查看状态 / 健康 | `docker compose ps` |
| 跟踪日志 | `docker compose logs -f` |
| 停止（保留数据） | `docker compose down` |
| 停止并删卷（**会丢数据**） | `docker compose down -v` |
| 备份数据库 | `docker run --rm -v api-hub-data:/data -v "$PWD":/backup alpine tar czf /backup/api-hub-$(date +%F).tgz -C /data .` |

### 反向代理

仓库自带 `Caddyfile`（自动 HTTPS）。用 nginx 参考 `deploy/nginx/api-hub.conf`：

```bash
sudo cp deploy/nginx/api-hub.conf /etc/nginx/conf.d/api-hub.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## 方式四：手动部署（systemd / NSSM）

适合要把网关纳入自有运维体系（Ansible、salt、CI/CD）的场景。

### 通用前置

```bash
# Node 20+ 与 bun
curl -fsSL https://bun.sh/install | bash

git clone https://github.com/plxlaaa/api-hub.git /opt/api-hub
cd /opt/api-hub
bun install
npx prisma generate
npx next build
```

`db/` 目录**不需要**手动创建——服务首次启动会自动建目录、建表（幂等）。

### systemd

```bash
sudo cp deploy/systemd/api-hub.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now api-hub
```

### Windows（NSSM）

```powershell
nssm install api-hub "C:\Program Files\nodejs\node.exe" `
  ".next\standalone\server.js"
nssm set api-hub AppDirectory "C:\api-hub"
nssm set api-hub AppEnvironmentExtra "PORT=3000" "HOSTNAME=127.0.0.1" "NODE_ENV=production"
nssm set api-hub Start SERVICE_AUTO_START
nssm start api-hub
```

---

## 配置项

所有配置通过**环境变量**传入，无需改动代码。

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000` | 监听端口 |
| `HOSTNAME` | `0.0.0.0` | 监听地址。**只用本机反代时设 `127.0.0.1`** |
| `NODE_ENV` | `production` | 运行模式 |
| `TZ` | 系统时区 | 时区，影响日志与统计口径 |
| `DATABASE_URL` | `file:./db/custom.db` | 仅容器内有效；宿主/standalone 部署会忽略 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `LOG_FORMAT` | `json` | `json`（采集用）/ `text`（人读） |
| `PRISMA_LOG` | — |设为 `query` 打印 SQL，排查慢查询用 |
| `LOG_SILENT` | — | 设为 `1` 静默日志（测试用） |

示例见 `.env.example`。

---

## 数据与备份

| 路径 | 内容 |
|------|------|
| `db/custom.db` | SQLite 主库（渠道、路由、密钥、日志） |
| `db/custom.db-wal` / `-shm` | WAL 附属文件（**不可单独拷贝**，会导致快照不一致） |
| `db/credentials.env` | 管理员凭据哈希（scrypt 加盐） |
| `db/setup-token.txt` | 首次设置令牌 |

**正确备份方式**（服务运行中也安全，SQLite 快照一致）：

```bash
sqlite3 db/custom.db ".backup '/backup/custom-$(date +%F).db'"
# 或用脚本：bash install-api-hub.sh --update（更新前自动备份）
```

> ⚠️ 直接 `cp db/custom.db` 在服务运行中可能拿到不完整快照。停服后拷贝，或用上面的 `.backup`。
> ⚠️ `db/` 含明文 API Key 与凭据，**勿提交进仓库、勿外传**（`.gitignore` 已默认排除）。

---

## 开机自启

| 安装方式 | 自启机制 | 验证命令 |
|---------|---------|---------|
| Linux 脚本（有 systemd） | `systemctl enable api-hub` | `systemctl is-enabled api-hub` |
| Linux 脚本（无 systemd） | nohup + rc.local / crontab | `crontab -l` |
| Windows 脚本 | NSSM 服务 `StartType=Automatic` | `Get-Service api-hub` |
| Docker | `--restart unless-stopped` | `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' api-hub` |

---

## 健康检查与排错

### 健康检查

推荐用 `/api/health`（无需鉴权，可安全暴露）：

```bash
curl -fsS http://127.0.0.1:3000/api/health
# 正常：{"status":"ok","uptimeSec":123,"db":{"ok":true},"checksMs":1,...}   HTTP 200
#异常：{"status":"degraded",...,"db":{"ok":false,"error":"..."}}          HTTP 503
```

`503` 表示数据库不可用——服务进程还活着，但**不该再往里导流量**。
容器 healthcheck 与 systemd 均可直接依赖此端点。

> 早期版本曾用 `/api/auth/status` 当探针，但它只反映「是否已初始化」，
> **数据库挂了它照样返回 200**。请统一改用 `/api/health`。

### 排错时对照界面

装完之后，下面这几张界面截图能帮你快速确认「服务到底起来没有」——
**页面打得开 = 进程和数据库都正常**，页面打得开但数据全是空或报错，才需要按下面的 FAQ 逐项排查。

**① 仪表盘**：「渠道健康」卡片是最快的自检点——**在线数应等于已启用且未熔断的渠道数**。
若显示 `在线 0 / 异常 N`，去渠道管理页看「状态」列与自动熔断提示，错误原因就写在那一行里。

<img src="docs/screenshots/02-dashboard.png" alt="仪表盘：渠道健康卡片" width="100%">

**② 渠道管理**：每行的「状态」列就是自检结果——`在线` / `离线（N 连败）` / `熔断中`，
提示文字写着具体原因（如「HTTP 429：上游限流」）。

<img src="docs/screenshots/03-channels.png" alt="渠道管理：状态列与熔断提示" width="100%">

**③ 调用日志**：网关不通时先看这里。`结果` 列为空说明请求压根没到网关；
有记录但 `尝试` > 1 说明发生了故障转移；`错误` 列会写明上游返回的原始原因。

<img src="docs/screenshots/06-request-logs.png" alt="调用日志：结果、尝试次数与错误原因" width="100%">

## 常见问题FAQ

**Q：启动报 `Unable to open the database file` / `Error code: 14`**
A：旧版本未自动创建 `db/` 目录。升级到最新版即可自动创建；或手动 `mkdir -p db` 并确认
目录对服务用户可写。

**Q：`SQLite 就绪` 之后接口仍报 `table does not exist`**
A：日志里紧邻着一条 `自动建表失败` 的 error 才是真实原因（可能是磁盘满或目录权限）。
用 `LOG_LEVEL=debug` 重启看完整错误。

**Q：页面能开，但网关调不通 / 报「所有渠道均失败」**
A：按顺序查 ① 渠道 `enabled` 与未熔断（`autoDisabled=false`）② 探测日志里的错误
③ 容器/沙箱内网渠道需在备注加 `allowInternal: true`（默认禁内网防 SSRF）。

**Q：端口被占用 / 改端口后连不上**
A：`ss -lntp | grep 3000` 查占用；改端口要同时改防火墙与反代。
`HOSTNAME` 若未设，容器内可能绑到容器主机名导致连不上，建议显式设 `0.0.0.0`。

**Q：Windows 服务状态一直是「启动中」**
A：多半是 Node 路径不对。`nssm get api-hub Application` 核对，
建议用 `C:\Program Files\nodejs\node.exe` 绝对路径。

**Q：升级后行为异常**
A：`bash install-api-hub.sh --update --token "$T"`（会自动备份 db 并迁移），
升级前后的差异见 [CHANGELOG.md](CHANGELOG.md)。

### 日志排查

```bash
journalctl -u api-hub -f                      # Linux 实时
journalctl -u api-hub --since "1h ago" -p err # 最近一小时错误
docker compose logs -f api-hub# Docker 实时
```

日志为结构化 JSON，每条含 `ts` / `level` / `msg`。
网关请求会带 `requestId`，客户端响应头 `X-Request-Id` 与之一致——
**拿客户端报的 ID 直接 grep 就能定位整条链路**：

```bash
grep 'a1b2c3d4' api-hub.log
```