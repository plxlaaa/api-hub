# 贡献指南

个人运营项目，欢迎 issue 与 PR。

## 开发环境

```bash
bun install                # 或 npm install
npx prisma generate
npm run dev                # http://localhost:3000
```

前置：Node.js ≥ 20。跑 `node doctor.mjs` 可做环境自检。

## 提交前必须自查

```bash
npm run build              # 必须通过（含 tsc 类型检查）
npm test                   # 单元测试必须全绿
bash scripts/pack-standalone.sh /tmp/pack-check.tar.gz   # 若改动了构建/部署相关
```

改了`deploy/` 下的物料，请用对应真实工具校验：

| 文件 | 校验命令 |
|------|---------|
| `deploy/systemd/*.service` | `systemd-analyze verify deploy/systemd/api-hub.service` |
| `deploy/nginx/*` | `nginx -t -c <临时配置>`（需把 `limit_req_zone` 置于 http 上下文） |
| `deploy/logrotate/*` | `logrotate -d deploy/logrotate/api-hub` |
| `deploy/windows/*.ps1` | `pwsh -NoProfile -File <脚本>`（能实际跑就别只做语法检查） |
| `scripts/verify-deploy.sh` | `bash -n scripts/verify-deploy.sh` + 对着跑起来的服务实跑一遍 |

> 这几份配置都有过「工具直接报错/静默失效」的坑（`StartLimitIntervalSec` 位置错误、
> `limit_req_zone` 作用域错误、`create 0640 <不存在的用户>` 导致整个配置被跳过），
> 改动后务必实测。
>
> PowerShell 脚本另有一个坑：Windows 专用 cmdlet（`Get-Service` / `Get-CimInstance` /
> `Get-NetTCPConnection`）在 PowerShell 7 for Linux 上不存在，直接调用会让脚本**中途崩溃**。
> 新增这类调用前先用 `Get-Command <cmdlet>` 探测；硬编码盘符路径（`C:\...`）前先判`$IsWindows`，
> 否则 `Join-Path` 会抛 "Cannot find drive"。

##代码约定

- **纯函数优先**：能抽成零 IO 纯函数的逻辑（归一化、聚合、判定）一律抽到 `src/lib/`，
  路由只负责编排。这样才能用 `node --test` 直接单测。
- **响应统一**：管理端接口用 `jsonOk` / `jsonError` / `jsonRateLimited` / `jsonServerError`
  （`src/lib/api-response.ts`），不要手拼响应体。
- **日志统一**：用 `log.*`（`src/lib/logger.ts`），不要用 `console.*`——字段化后才能被
  journald / Loki 采集，且自动脱敏。
- **请求 ID**：新接口一律 `resolveRequestId` + 透传 `X-Request-Id`。
- **上游地址**：任何用管理员输入的 URL 出网的地方，都要过
  `checkUpstreamUrlWithDns`（`src/lib/url-safety.ts`）。
- **写路由表必须失效缓存**：网关转发读的是 `getEnabledRoutes()`的缓存
  （`src/lib/route-cache.ts`）。任何 `db.modelRoute` 的写入点（增/删/改、配置导入）
  完成后都要调用 `invalidateRouteCache()`，否则最长 5 秒内新配置不生效——
  表现为「刚建的路由调用却404」。已有的失效点见 `api/routes/route.ts`、
  `api/routes/[id]/route.ts`、`api/config/import/route.ts`。
  **渠道（Channel）刻意不缓存**，无需为此新增失效调用。

## 测试

用 Node 内置 test runner，无需额外框架：

```bash
npm test                                          # 全部
node --experimental-strip-types --test tests/config-stats.test.ts   # 单个文件
```

新增纯函数请补测试；改动现有行为时，请同步更新 `docs/API.md` 与 `CHANGELOG.md`。

## 文档同步（不可遗漏）

改动落地后请一并更新：

- `CHANGELOG.md` —— 在 `## [未发布]` 下追加，标注新增 / 变更 / 修复 / 安全
- `docs/API.md` —— 接口契约、请求与响应字段、统计口径
- `INSTALL.md` —— 部署方式、配置项、排错
- `README.md` —— 功能总览表

>响应体或字段有变更时，**必须**在 CHANGELOG 里显式写明破坏性影响
> （例如「前端需改读 `items`」），不要只写「优化了xx」。

## 提交信息

沿用 Conventional Commits：

```
feat: 新功能
fix: 缺陷修复
refactor: 重构（行为不变）
docs: 文档
chore: 构建/依赖/杂项
security: 安全加固
```

## 安全提醒

- **不要提交任何真实凭据**：API Key、`db/credentials.env`、`db/*.db*` 都在 `.gitignore` 中，
  提交前用 `git status` 再确认一次。
- 发现 SSRF / 越权 / 密钥泄漏类问题，请直接 issue 而非 PR 细节，并在描述中给出复现路径。
