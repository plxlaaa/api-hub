# 更新日志

本文件记录 API Hub 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增
- **路由表缓存** `src/lib/route-cache.ts`：网关转发与 `/v1/models` 此前每次请求都要
  `findMany` 整张路由表，是QPS 最高路径上的重复全表查询。现按「读多写少」特征做
  短 TTL（5s）缓存 + **写入即失效**（路由增删改、配置导入四处写入点全部主动
  `invalidateRouteCache()`），并用单飞（inflight 合并）防止并发击穿。
  刻意**不缓存渠道**：`autoDisabled` 由熔断与探测高频改动，缓存会导致「已熔断渠道仍被选中」。
  查库失败时抛错而**不回退陈旧数据** —— 配置错比慢一点严重得多。
- **部署自检脚本**（两端对等，均零依赖、可用于部署流水线判定，退出码 0/1）：
  - `scripts/verify-deploy.sh`：Linux/macOS。检查 Node 版本、端口监听、`/api/health`
    数据库可用性、**管理接口是否真的拒绝未授权访问**、systemd 状态、`db/` 可写性。
    兼容无 curl 环境（自动退化到 wget）。
  - `deploy/windows/verify-deploy.ps1`：Windows。检查项与Linux 版一一对应，
    额外校验 Windows 服务运行状态与开机自启（`StartMode=Automatic`）。
    所有 Windows 专用 cmdlet（`Get-Service`/`Get-CimInstance`/`Get-NetTCPConnection`）
    均先探测可用性再调用，在 PowerShell 7 for Linux 上也不会中断脚本。
- 单元测试 `tests/route-cache.test.ts`：8 个用例，覆盖缓存命中/TTL 过期/主动失效、
  并发击穿合并（20 并发只查库 1 次）、查库失败抛错与恢复、限流桶高基数淘汰。

### 变更
- **`Retry-After` 改为实测值**：限流429 此前写死 `Retry-After: 10`，与实际剩余窗口
  （最长可达 60s）不符，客户端 SDK 会提前重试并再次被拒，形成重试风暴。
  现取限流器返回的真实 `retryAfterMs`（向上取整，至少 1s）。
- 网关日志裁剪改为固定 2 条查询：原实现每次触发要做 `count()` 全表扫 +
  `findMany({ skip: 2000 })` 扫过并丢弃前 2000 行 + `deleteMany({ id: { in: [...] } })`
  拼出上千个 id 的 IN 列表。现取「倒数第 2000 条」的时间戳作分界，一条 `deleteMany`
  按 `createdAt` 之前删除，开销与表大小基本无关。

### 修复
- **`/api/overview` 渠道平均延迟算错**：groupBy 按 `(channelName, ok)` 分组后，
  原代码对各组 `_avg` 再取算术平均 —— 这是「组均值的均值」，组大小差异大时明显偏移
  （一个 2 次调用的渠道会与一个 500 次调用的渠道等权）。现改用 `_sum` + 内存加权平均，
  口径与 `/api/stats`、`/api/channels` 统一为「仅成功请求计入延迟」。
- **限流桶淘汰速度追不上新增速度**：`hitRateLimit` 在桶数达到上限时**只删 1 个**桶
  （注释却写「清空最旧的一批」）。当 key 基数持续增长（如大量不同 IP 撞库）时，
  Map 长期贴着上限，新桶一写入就被立刻挤掉刚写入的桶 → **限流被静默放宽、形同虚设**。
  现批量淘汰（10% 且至少 16 个），回收速度稳定高于新增。
- **网关早期失败时拿不到 `X-Request-Id`**：`/v1/models` 与 `/v1/chat/completions` 的
  鉴权 401、缺 model、非法 JSON 等分支此前不带请求 ID，客户端无法与服务端日志对账。
  现由`handleChatCompletions` 统一兜底补齐，成功响应也回传该头。
- 删除 Next.js 脚手架遗留的 `src/app/api/route.ts`（`Hello, world!` 占位路由）。

### 安全
- SSRF 防护从「字面量判断」升级为「字面量 + DNS 解析后 IP 判定」，可拦截
  指向 `127.0.0.1`、`10.x`、`192.168.x`、链路本地 `169.254.169.254` 的域名，
  以及 IPv4-mapped IPv6 写法。已接入渠道保存/更新、配置导入、fetch-models 三处入口。
- 配置导入规模上限（`MAX_CHANNELS=500` / `MAX_ROUTES=1000`），文件内重复项只保留首个。
- 打包脚本对暂存目录做凭据/数据库文件二次校验，命中即中止，防止发布包泄漏 API Key。

## [V28] — 2026-10-07

### 新增
- **配置导入/导出保真**：`/api/config/export` 补齐 `percent`、`activeHours`、`metadata`
  字段，导入导出往返不再丢配置（此前导出的渠道缺少这三个字段，回导后调度比例与时段失效）。
- **配置导入纯函数层** `src/lib/config-import.ts`：把归一化逻辑从路由里抽出为
  零 IO 纯函数（`extractImportPayload` / `planImport` / `resolveChannelRefs` /
  `buildImportResult`），可独立单测；同时作为路由瘦身。
- **统计聚合纯函数** `src/lib/log-stats.ts`：`bucketByDay` / `bucketByHour` /
  `aggregateByChannel` / `topModels`，用内存分桶替代逐渠道查询。
- **SSRF 校验加强** `checkUpstreamUrlWithDns`：字面量校验之后追加 DNS 解析，
  对解析出的 IP 再判定，堵住「域名解析到 127.0.0.1/169.254.169.254」的绕过；
  同时覆盖 IPv4-mapped IPv6（`::ffff:127.0.0.1`）。
- **部署物料** `deploy/`：
  - `systemd/api-hub.service`：修正 `StartLimitIntervalSec` / `StartLimitBurst`
    位置错误（写在 `[Service]` 段会被 systemd **静默忽略**，导致崩溃时无限重启），
    已移入 `[Unit]`；新增 `EnvironmentFile` 与 journald 轮转说明。
  - `nginx/api-hub.conf`：`limit_req_zone` 移到 http 上下文（写在 server 块内
    nginx 启动即报错），HTTP/2 配置抽成版本化片段。
  - `nginx/api-hub-http2.conf`：`http2 on;`（nginx ≥1.25）与
    `listen 443 ssl http2;`（<1.25）两种写法互斥，Ubuntu 22.04 自带 1.18 需用后者。
  - `logrotate/api-hub`：文件式日志轮转（journald 之外的场景）。
  - `env/api-hub.env.example`：集中管理配置项，附注不可写入密钥。
  - `windows/register-service.ps1` / `unregister-service.ps1`：Windows 服务注册与卸载，
    含提权检测、Node 绝对路径探测、崩溃重启、`AppRotateBytes` 轮转、
    卸载前自动备份 `db/`、`-Purge` 二次确认。
  - `scripts/pack-standalone.sh`：免依赖 tarball 打包，自动剔除 `db/`（避免把
    开发机凭据与API Key 打进发布包）并做泄漏校验。
- **界面截图** `docs/screenshots/`：9 张真实运行实例的截图（登录、仪表盘、渠道、路由、
  密钥、调用日志、调用示例、模型广场、暗色模式），已嵌入 README、INSTALL、docs/API。
  配套脚本 `tools/shoot.py` 可一键重拍（Playwright），UI 改动后无需手工截图。
- **健康检查接口** `GET /api/health`：返回 `status` / `uptimeSec` / `db.ok` / `checksMs`，
  数据库不可用时返回 **503**。容器与 systemd 可直接用它做探针，替代原先语义过弱的
  `/api/auth/status`（后者只反映「是否已初始化」，DB 挂了仍会返回 200）。
- **游标分页**：`/api/request-logs` 与 `/api/logs` 支持 `limit` + `cursor`，
  响应改为 `{ items, nextCursor, hasMore, total? }` 信封。深翻页不再全表扫描。
- **结构化日志** `src/lib/logger.ts`：级别过滤（`LOG_LEVEL`）、JSON/text 双格式（`LOG_FORMAT`）、
  字段自动脱敏、基于 `AsyncLocalStorage` 的请求 ID 全链路透传。
- **统一响应封装** `src/lib/api-response.ts`：管理端与 OpenAI 兼容两种错误体统一构造，
  自动附加 `X-Request-Id` 响应头。
- **参数校验器** `src/lib/validate.ts`：链式校验，一次返回全部问题而非逐条报错。
- 单元测试 `tests/backend-core.test.ts`：22 个用例，覆盖分页、校验、响应、日志脱敏。
- 单元测试 `tests/config-stats.test.ts`：46 个用例，覆盖导入请求形状兼容、归一化边界、
  引用来源回退链、引用反查、日志分桶、SSRF IP 判定。

### 变更
- `/api/stats` 数据库查询数 **21 → 2**（1 次 groupBy 求总量 + 1 次 findMany 取 7 天窗口明细），
  逐渠道/逐模型统计改为内存聚合。
- 渠道横评统计加 30 天时间窗，`?all=1` 可取全量。
- 7 个管理端读取路由（`auth/me`、`auth/status`、`settings`、`routes`、`routes/preview`、
  `tokens`、`overview`）接入 `jsonOk` + `resolveRequestId`，响应信封与请求 ID 统一。
- **日志接口响应体变更**：`/api/request-logs` 与 `/api/logs` 由裸数组改为
  `{ items, nextCursor, hasMore }` 信封。**前端需改读 `items`**；未传 `cursor` 时
  `items` 内容与从前一致。
- `X-Request-Id` 现在同时出现在网关响应头与所有管理端错误响应中，便于把客户端报错
  与服务端日志对应起来。
- `gateway.ts` / `probe.ts` / `db.ts` 内的 `console.*` 全部替换为 `log.*`，
  日志字段化后可被 journald / Loki 直接采集。
- 网关请求完成时输出一条汇总日志（状态码、耗时、是否管理测试模式）。
- `/api/health` 成为推荐探针端点；Dockerfile 与 docker-compose.yml 的 healthcheck 已切换。
- INSTALL.md 新增「仓库自带的部署物料」对照表、集中配置项（EnvironmentFile）、
  日志轮转（journald vs logrotate）、包管理器分发（winget/choco/scoop）、
  HTTP/2 版本适配、免依赖 tarball 方式，以及**防火墙**与**升级/卸载**专章。

### 修复
- **配置恢复功能整体失效**：`/api/config/import`此前是 `channels/fetch-models` 的整份
  复制粘贴，返回 `{models}`，而仪表盘、渠道页、CLI 三处调用方都按导入结果使用——
  「导入配置」按钮实际上什么也没恢复。现按 merge/replace 双模式重写，兼容裸配置体与
  `{mode, data}` 两种请求形状。
- **导入的路由丢失全部渠道引用**：路由归一化只读 `channelConfigs` 与 `channelIds`，
  漏了 `channels`（按「渠道名」引用的写法，也是用户手写配置与早期导出的格式）。
  结果是导入后路由的 `channelIds` 为空数组，**路由形同虚设**——调用只会返回 502。
  现补入回退链：`channelConfigs` → `channels` → `channelIds`。
- `/api/stats` 把**失败请求的延迟也计入渠道均值**，而 `/api/channels` 早已排除；
  网关超时上限 300秒，单次超时即可把均值拉飞。现两处口径统一为「仅成功请求计入」。
- `channels/fetch-models`此前会用管理员传入的 `baseUrl` 直接出网，**无任何 SSRF 校验**，
  现已接入 `checkUpstreamUrlWithDns`。
- 导入时的悬空渠道引用不再写入（此前会生成指向不存在渠道的路由配置），改为剔除并在
  `warnings` 中回报；全部引用失效的路由整条跳过。
- `logrotate` 配置里的 `create 0640 api-hub adm` 在没有该用户的机器上会让logrotate
  **放弃整个配置**（轮转静默失效），改为 `create 0640` 沿用原文件属主。
- 非法 `mode` 值退化为 `merge` 而非 `replace`，避免误删线上配置。
- 超长或含非法字符的 `X-Request-Id` 请求头此前会被**截断**后放行，不同请求可能撞到同一
  ID 导致日志串联误导；现改为整段拒绝并重新生成。

### 安全
- SSRF 防护从「字面量判断」升级为「字面量 + DNS 解析后 IP 判定」，可拦截
  指向 `127.0.0.1`、`10.x`、`192.168.x`、链路本地 `169.254.169.254` 的域名，
  以及 IPv4-mapped IPv6 写法。已接入渠道保存/更新、配置导入、fetch-models 三处入口。
- 配置导入规模上限（`MAX_CHANNELS=500` / `MAX_ROUTES=1000`），文件内重复项只保留首个。
- 打包脚本对暂存目录做凭据/数据库文件二次校验，命中即中止，防止发布包泄漏 API Key。

## [V27] — 2026-10-04

### 新增
- Docker / docker-compose 部署路径。
- `install-api-hub.sh` 补齐 Linux 各发行版，`install-api-hub.ps1` 覆盖 Windows。
- 发布流程：打 tag 自动打包三平台附件并发布 Release。

### 安全
- 上游错误体密钥自动脱敏；渠道地址默认禁内网（防 SSRF）。
- 客户端断开即中止上游请求，不白烧额度。
- 统一 Key 限速+ 配额原子扣减；SQLite WAL + 忙等超时；熔断冷却期防抖动。

[未发布]: https://github.com/plxlaaa/api-hub/compare/v28...HEAD
[V28]: https://github.com/plxlaaa/api-hub/compare/v27...v28
[V27]: https://github.com/plxlaaa/api-hub/releases/tag/v27