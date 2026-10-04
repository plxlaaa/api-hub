# API Hub 本地部署交接文档（HANDOVER）

> 交接对象：本地 AI 助手 / 操作者。执行环境：Windows 10/11 或 Linux 服务器。
> 来源：云端沙箱（Linux）开发并全量 E2E 验证的 V27 版本。**以下步骤在 Linux 沙箱实测通过，Windows 原生环境未经实机验证**——遇到差异请按「判断分支」处理并在结果中如实记录。

## 项目是什么

个人公益站 API 聚合网关：多渠道管理、实时探测、自定义路由（6 种负载均衡策略）、模型改名、OpenAI 兼容统一调用、用量统计、配置备份。技术栈：Next.js (App Router) + Prisma + SQLite + Tailwind。

## 阶段 0：一键安装（首选路径）

仓库带三种装法，**优先从这三条里选一条**，装完就是常驻服务 + 开机自启，下面阶段 1-4 可跳过。

| 场景 | 选择 |
|------|------|
| Linux 服务器（有 systemd） | 脚本 A |
| Windows 10/11 | 脚本 B |
| 不装 Node / 无 root / 容器环境 | 方式 C（Docker） |

### A. Linux 脚本

```bash
T=ghp_你的GitHub令牌       # 私有仓库需 PAT，勾选 repo
curl -fsSL -H "Authorization: Bearer $T" -H "Accept: application/vnd.github.raw" \
  https://api.github.com/repos/plxlaaa/api-hub/contents/install-api-hub.sh \
  -o install-api-hub.sh
bash install-api-hub.sh --token "$T"          # 有域名加 --domain hub.example.com
```

覆盖 Ubuntu/Debian、RHEL/CentOS/Fedora、Alpine、Arch、openSUSE（自动探测包管理器）。
流程：装 Node 20+ / bun → 拉源码 → 装依赖 → 生成 Prisma Client → 建库 → `next build` →
注册 systemd 服务 `api-hub` → 健康检查 → 打印首次设置令牌。默认装到 `/opt/api-hub`。

| 动作 | 命令 |
|------|------|
| 更新（自动备份 db） | `bash install-api-hub.sh --update --token "$T"` |
| 状态 / 设置令牌 | `bash install-api-hub.sh --status` |
| 环境自检 | `bash install-api-hub.sh --precheck` |
| 卸载（留库） | `bash install-api-hub.sh --uninstall` |
| 卸载并删库 | `bash install-api-hub.sh --uninstall --purge` |
| 容器化部署 | `bash install-api-hub.sh --docker --token "$T"` |

参数：`-d/--dir` `-p/--port` `-b/--branch` `--domain` `--cn`（国内镜像）`--firewall`。
数据库备份落在 `/opt/api-hub-backups/db-<时间戳>`。

### B. Windows 脚本（管理员 PowerShell）

```powershell
$env:GITHUB_TOKEN='ghp_你的GitHub令牌'
irm "https://api.github.com/repos/plxlaaa/api-hub/contents/install-api-hub.ps1" `
  -Headers @{Authorization="Bearer $env:GITHUB_TOKEN"; Accept="application/vnd.github.raw"} `
  -OutFile install-api-hub.ps1
.\install-api-hub.ps1 -Token $env:GITHUB_TOKEN
```

默认装到 `C:\api-hub`，注册**计划任务**（用户登录即启动）。
若机器上装了 [nssm](https://nssm.cc/) 会**自动**改用真正的 Windows 服务（开机即启，无需登录）；
没装则用计划任务。`-Update` / `-Status` / `-Uninstall` / `-Precheck` / `-Docker` / `-NoFirewall` 可用。

### C. Docker（推荐给容器 / 无 root 环境）

```bash
git clone https://github.com/plxlaaa/api-hub.git && cd api-hub
cp .env.example .env            # 可选：改端口 / 时区
docker compose up -d --build
docker compose logs -f         # 首次设置令牌在这里看
```

数据库在具名卷 `api-hub-data`，容器重建不丢。国内网络可设`CN_MIRROR=1` 走镜像加速。
首次启动会**自动建表**（容器内无 prisma CLI，由 `src/lib/db.ts` 兜底建表）。

**判断分支**：
- 脚本在构建阶段失败 → 多为内存不足（build 建议 4GB+ / Linux 2GB+）或依赖不全，看具体报错再决定加 swap 或重装依赖
- 环境无 systemd（容器/精简镜像）→ 脚本自动降级为 nohup + crontab；更推荐直接 `--docker`
- winget 不可用（Windows）→ 手动装 Node 22 LTS 后重跑脚本，或改用 `-Docker`

## 包内容清单

```
full-stack/
├─ src/                  源码（lib/adapters/ 三协议适配器、策略注册表）
├─ prisma/schema.prisma  数据模型
├─ db/custom.db          ⚠️ 现有数据库（含渠道 Key、路由、密钥、调用日志）
├─ install-api-hub.sh    Linux 一键安装/更新/卸载脚本
├─ install-api-hub.ps1   Windows 一键安装/更新/卸载脚本
├─ Dockerfile            容器镜像（多阶段构建）
├─ docker-compose.yml    容器编排
├─ ARCHITECTURE.md       架构与扩展指南
├─ doctor.mjs            环境自检脚本
└─ tests/security.test.ts 安全模块单测
```

## 阶段 1：安装依赖（手工部署用）

> 走了一键安装的不用看阶段 1-4。这段保留给排查问题 / 定制部署。

```bash
cd api-hub
bun install          # 首选 bun（项目脚本基于 bun run）
```

**判断分支**：
- 无 bun → `npm install -g bun` 安装；或全部用 npm 等价命令：`npm install` / `npx prisma generate` / `npm run dev`
- 安装超时/失败 → 换国内镜像 `bun install --registry https://registry.npmmirror.com`

## 阶段 2：初始化（手工部署用）

> V28 起首次启动会**自动建表**（`src/lib/db.ts` 里的 `SCHEMA_DDL`），
> 所以正常情况**不需要**手动 `db:push`。以下仅在特定场景需要：

```bash
bun run db:generate   # 生成 Prisma Client（必须，否则启动报错）
```

**注意**：
- 已有 `db/custom.db` 的部署**不要**跑 `db:push`（会重置结构）更不要跑 `db:reset`（会清库！）
- 只有 doctor 提示 schema 与库结构不一致时才执行 `bun run db:push`

## 阶段 3：启动与验收（手工部署用）

```powershell
bun run dev           # 开发模式启动（http://localhost:3000）
```

**首次设置令牌（重要）**：服务启动时，若尚未初始化管理员，会自动生成一次性设置令牌，
打印到控制台并写入 `db/setup-token.txt`（权限 600，仅本机可见）。首次进入面板创建管理员账号时，
必须把该令牌粘贴进「一次性设置令牌」输入框——**这是为了防止面板暴露公网时被人抢先注册**。
建号成功后令牌立即焚毁，不能复用。网络无法读取此令牌，只能在本机查看。

验收清单（逐项确认）：

| # | 验收项 | 通过标准 |
|---|--------|----------|
| 1 | 服务启动 | 控制台出现 `Ready`，无红色报错 |
| 2 | 打开 http://localhost:3000 | 登录页/主界面正常渲染 |
| 3 | 登录 | 用你的管理员密码进入仪表盘，八卡有数据 |
| 4 | 渠道探测 | 渠道管理 → 一键探测，克劳德状态变「在线」或返回明确错误 |
| 5 | 网关调用 | 用统一 Key curl 调 `/v1/chat/completions`，返回正常回复 |
| 6 | 调用日志 | 日志表出现刚才的调用记录，「尝试」列显示「首发」 |

验收 5 的 curl 示例（PowerShell）：

```powershell
curl.exe -s http://localhost:3000/v1/chat/completions -H "Authorization: Bearer sk-gw-你的统一Key" -H "Content-Type: application/json" -d '{\"model\":\"claude\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":20}'
```

统一 Key 在「API 密钥」Tab 查看（打码的；完整 Key 若遗失可新建一把）。

**判断分支**：
- 端口 3000 被占用 → `$env:PORT=3001; bun run dev`，后续地址换 3001
- 登录密码遗失 → 参考「应急操作」
- 渠道全部超时 → 本机网络问题（沙箱内可通的地址本地不一定通），先跑一键探测看具体报错

## 阶段 4：开机自启（可选）

一键安装已处理：Linux 注册 systemd `api-hub`，Windows 注册计划任务 `APIHub`（`-UseNssm` 则为 Windows 服务）。
手工部署可用 pm2 或 nssm 把 `bun run start` 注册为服务；或先手动跑稳定再考虑。

服务管理速查：

| 操作 | Linux | Windows | Docker |
|------|-------|---------|--------|
| 看状态 | `systemctl status api-hub` | `.\install-api-hub.ps1 -Status` | `docker compose ps` |
| 看日志 | `journalctl -u api-hub -f` | `Get-Content C:\api-hub\server.log -Tail 50` | `docker compose logs -f` |
| 重启 | `systemctl restart api-hub` | `.\install-api-hub.ps1 -Update -Token <PAT>` | `docker compose restart` |
| 自检 | `cd /opt/api-hub && node doctor.mjs` | `cd C:\api-hub; node doctor.mjs` | `docker compose exec api-hub node doctor.mjs` |

## 安全约束（必须遵守）

1. **db/custom.db 含明文 API Key**（渠道上游 Key + 统一调用 Key）——不要上传网盘/公开仓库，不要发给任何人
2. **db/credentials.env 含管理员用户名 + 密码 scrypt 哈希**（无明文密码，文件权限已收紧为仅当前用户可读写）——同样勿上传/外传
3. **网关只监听本机**（localhost）。要局域网访问需自行加反向代理 + 管理台强密码；**不要裸暴露公网**（管理 API 无 HTTPS + 密钥明文存储，公网直挂等于送 Key）
4. 管理员 JWT 密钥存于库 `Setting` 表（jwtSecret），泄露 = 管理台失守，同样勿外传
5. 破坏性操作（`db:reset`、删渠道、清日志）执行前必须先确认
6. **反代必须注入 `X-Real-IP`**：登录防爆破只信任这个头（不注入的话客户端可自带 `x-real-ip` 伪造 IP 绕过锁定）
7. **改动 schema.prisma 时同步改 `src/lib/db.ts` 的 `SCHEMA_DDL`**，否则新装/容器环境缺表（容器内无 prisma CLI）

## 应急操作

- **管理员账号遗失 / 需要重设**：删除本机 `db/credentials.env` 后重启。服务会生成新的设置令牌（打印到控制台 + 写入 `db/setup-token.txt`），用该令牌重新创建管理员账号即可。旧库里的密码会在首次启动时自动迁移（默认用户名 `admin`）。
- **库损坏/结构错乱**：`bun run db:push --accept-data-loss` 会重置结构但尽量保留数据；彻底重置前先在管理台「配置备份」导出 JSON
- **依赖损坏**：删 node_modules + bun.lock 重装
- **一键安装脚本失败**：重跑加 `--precheck` 看是哪一步；更新前脚本已自动备份 db 到 `/opt/api-hub-backups/db-<时间戳>`（Windows 为 `C:\api-hub-backups\`），可直接回拷

## 回报格式

执行完成后按此格式回报：

- 走一键安装 → 脚本各阶段 PASS/FAIL、最终打印的设置令牌来源、健康检查 HTTP 码、验收 6 项结果
- 走手工部署 → 每阶段 PASS/FAIL、doctor 输出摘要、遇到的分支与采取的路径、验收 6 项结果
