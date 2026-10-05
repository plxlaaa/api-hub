# API Hub 架构与扩展指南

> 目标：新功能以「注册/新增文件」方式接入，主流程零改动。V26 起核心扩展点收敛为三层。

## 模块地图

```
src/
├─ lib/
│  ├─ adapters/          ★ 扩展点①：上游协议适配器
│  │  ├─ types.ts        ProtocolAdapter 接口定义
│  │  ├─ openai.ts       OpenAI 兼容（直通）
│  │  ├─ anthropic.ts    Anthropic Messages（双向转换）
│  │  ├─ gemini.ts       Google Gemini generateContent（双向转换，mock 已验证/真机待测）
│  │  └─ index.ts        注册表 getAdapter() / resolveChatEndpoint()
│  ├─ route-order.ts     ★ 扩展点②：路由策略注册表 STRATEGY_REGISTRY（6 策略含 cost）
│  ├─ metadata.ts        ★ 扩展点③：Json 扩展字段（实验配置空间）
│  ├─ gemini.ts          Gemini 格式转换纯函数
│  ├─ anthropic.ts       Anthropic 格式转换纯函数（被 adapter 引用）
│  ├─ gateway.ts         转发主流程（只面向 Adapter 接口，不感知具体协议）
│  ├─ probe.ts           探测/一键测试（复用 Adapter）+ upstreamUrl 规范化
│  ├─ route-config.ts    路由渠道配置解析 + normalizeStrategy（源自 STRATEGY_LABELS）
│  ├─ auth.ts            JWT 管理鉴权 + 登录锁定（走 rate-limit）
│  ├─ rate-limit.ts      进程内滑动窗口限流（登录防爆破 + 网关 Key 限速共用）
│  ├─ redact.ts          密钥/内网地址脱敏（所有对外错误信息必经）
│  ├─ url-safety.ts      上游地址校验（防 SSRF）
│  ├─ json-field.ts      库内 JSON 字符串字段的容错解析
│  ├─ credentials.ts     管理员凭据与一次性设置令牌
│  └─ db.ts              Prisma 单例 + PRAGMA + 首次启动自动建表
├─ app/api/              Next.js 路由处理器（薄壳，业务在 lib）
└─ components/           管理台 UI（tabs 平铺）
install-api-hub.sh       Linux 一键安装（systemd；无 systemd 自动降级 nohup）
install-api-hub.ps1      Windows 一键安装（计划任务 / nssm）
Dockerfile               多阶段构建镜像（容器部署）
docker-compose.yml       容器编排（具名卷持久化数据库）
doctor.mjs               环境自检（支持 --json）
tests/security.test.ts   安全模块单测（Node 内置 runner，零依赖）
```

## 部署脚本（非扩展点，运维面）

脚本只做「拉源码 → 装依赖 → 建库 → 构建 → 注册常驻服务」，不改动任何业务代码。改它们时注意三条硬约束：

1. **工作目录即数据库位置**。`src/lib/db.ts` 与 `src/lib/credentials.ts` 都按 `process.cwd()/db/` 定位 SQLite 与凭据文件，
   所以 systemd 的 `WorkingDirectory` 必须是项目根（`next start` 而非 standalone 就是为了保住这个前提）。
2. **私有仓库走 PAT + tarball**，不依赖 git 鉴权：`api.github.com/repos/<owner>/<repo>/tarball/<branch>`，
   解包时 `--strip-components=1`；已有 `db/` 时绝不覆盖，更新前先备份。
3. **首次建表不能依赖 prisma CLI**。容器内没有 CLI，改由 `src/lib/db.ts` 在启动时执行
   `CREATE TABLE IF NOT EXISTS`（代码里的 `SCHEMA_DDL`）兜底。
   **改 `prisma/schema.prisma` 时必须同步改 `SCHEMA_DDL`**，否则新装环境缺表。
   同时`db/` 目录由 `db.ts` 启动时 `mkdirSync(recursive)` 自动创建——SQLite 不会自动建父目录，
   目录缺失时首次连接会直接报 `Error code: 14: Unable to open the database file`。

### 环境适配

| 环境 | 检测方式 | 行为 |
|------|---------|------|
| 有 systemd | `/run/systemd/system` 存在 | 注册 `api-hub.service` |
| 无 systemd | 同上取反 | 降级 `nohup` + `crontab @reboot`，并提示改用 Docker |
| 有 Docker | `--docker` / `-Docker` | 走 `docker compose`，容器内自带 Node |
| Windows | `process.platform` | 计划任务；检测到 nssm 时自动升级为 Windows 服务 |

## 扩展点①：新增上游协议（如 Gemini、Azure）

1. 新建 `src/lib/adapters/gemini.ts`，实现 `ProtocolAdapter` 六个方法：
   `chatEndpoint` / `buildHeaders` / `buildRequestBody` / `extractUsage` / `extractReply` / 可选 `transformResponse` / `transformStream`
2. `adapters/index.ts` 注册：`ADAPTERS.gemini = geminiAdapter`
3. `adapters/types.ts` 的 `ApiFormat` 联合类型加 `'gemini'`
4. 渠道表单下拉加选项（`listAdapters()`）

**主流程 gateway.ts / probe.ts 不需要任何改动**——协议认知全部收敛在适配器内。

## 扩展点②：新增路由策略（如成本优先、轮询）

1. `route-order.ts`：`RouteStrategy` 联合类型加名字（如 `'cost'`）
2. 实现排序函数 `(candidates: Candidate[]) => Candidate[]`（纯函数，异步也可以）
3. 注册进 `STRATEGY_REGISTRY.cost = costStrategy`，`STRATEGY_LABELS` 加中文名，`BASIS_LABEL` 加预览文案

预览与实际转发共用 `orderCandidates()`，策略即插即用。

## 扩展点③：metadata Json 字段（实验配置）

`Channel` / `ModelRoute` / `ApiToken` 三表均有 `metadata Json?`。
- 用途：分组、标签、模型白名单、限速参数等**实验性配置**
- 约束（`parseMetadata()` 强制）：扁平对象、值限 string/number/boolean、key ≤40 字符、值 ≤200 字符
- 原则：实验配置先放 metadata 验证，稳定后再升级为正式列

## 数据模型

- SQLite + Prisma；schema 变更后 `bun run db:push && bun run db:generate`
- 并发前提：连接串带 `connection_limit=1`，启动执行 `PRAGMA journal_mode=WAL` + `busy_timeout=5000`
  （探测调度器每 60s 写库与网关每请求写日志会并发，否则必然 `SQLITE_BUSY`）
- `RequestLog` / `ProbeLog` 已建 `createdAt`、`channelName+createdAt` 等复合索引（统计接口每次都按时间过滤）
- `RequestLog.attempt`：故障转移第几次尝试（日志「尝试」列数据源）
- 日志自动清理：保留最近 2000 条（`MAX_REQUEST_LOGS`）

## 后端安全基线

改动涉及「错误信息返回」「用户可控地址」「外部请求」时，必须过一遍这几条：

| 风险 | 收口位置 | 做法 |
|------|---------|------|
| 上游错误体回显密钥 / 内网地址 | `lib/redact.ts` | 所有写入日志与响应的上游文本先过 `redactSecrets()` |
| 用户可控 baseUrl 引发 SSRF | `lib/url-safety.ts` | 拒绝内网段、元数据地址、非 http(s) 协议；内网渠道需 metadata 显式放行 |
| 客户端断开后上游继续跑 | `lib/gateway.ts` | `AbortSignal.any([req.signal, timeout])` |
| 单Key 打满上游 | `lib/rate-limit.ts` | 默认 60 次/分钟，`metadata.rateLimitPerMin` 可调 |
| 并发超发配额 | `lib/gateway.ts` | `updateMany({ where:{ quotaUsed:{ lt: limit }}, data:{ increment:1 } })` 原子扣减 |
| 登录爆破 + IP 伪造 | `lib/auth.ts` | 只信任 `x-real-ip`（反代必须注入），不用可伪造的 `x-forwarded-for` |
| JWT 算法混淆 | `lib/auth.ts` | `jwtVerify(..., { algorithms: ['HS256'] })` |

## 关键设计决策

| 决策 | 原因 |
|------|------|
| 适配器只转换「请求体/头/响应」，URL 拼接留在 gateway | baseUrl 自愈逻辑（404 反向变体重试）需要统一处理 endpoint |
| 策略返回排好序的数组而非生成器 | 预览 API 需要完整顺序做展示 |
| metadata 限制扁平 | 防止退化成无 schema 垃圾场，查询/索引友好 |
| channelName 存日志快照 | 渠道删除后历史日志仍可读 |
| 熔断恢复加5 分钟冷却 | 避免「探测成功↔调用失败」把渠道反复摘除/加回 |
| 自动建表用 DDL 而非 `prisma db push` | 容器内没有 prisma CLI，且 db push 在生产有data-loss 风险 |

## 测试基建

- `tests/security.test.ts`：SSRF / 脱敏 / 限流单测，`bun run test`（零依赖）
- 容器端到端：`docker compose up -d --build` 后验证自动建表、鉴权、限流、故障转移
- `.zscripts/fakeup/bare-server.js`（:9754）：假上游，支持 openai + anthropic 双协议、流/非流、`/toggle` 模拟宕机
