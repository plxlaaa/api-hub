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
│  ├─ auth.ts            JWT 管理鉴权
│  └─ db.ts              Prisma 单例
├─ app/api/              Next.js 路由处理器（薄壳，业务在 lib）
└─ components/           管理台 UI（tabs 平铺）
install-api-hub.sh       Linux 一键安装/更新/卸载（systemd 常驻）
install-api-hub.ps1      Windows 一键安装/更新/卸载（计划任务 / nssm）
doctor.mjs               环境自检
```

## 部署脚本（非扩展点，运维面）

两个脚本只做「拉源码 → 装依赖 → 建库 → 构建 → 注册常驻服务」，不改动任何业务代码。改它们时注意两条硬约束：

1. **工作目录即数据库位置**。`src/lib/db.ts` 与 `src/lib/credentials.ts` 都按 `process.cwd()/db/` 定位 SQLite 与凭据文件，
   所以 systemd 的 `WorkingDirectory` 必须是项目根（`next start` 而非 standalone 就是为了保住这个前提）。
2. **私有仓库走 PAT + tarball**，不依赖 git 鉴权：`api.github.com/repos/<owner>/<repo>/tarball/<branch>`，
   解包时 `--strip-components=1`；已有 `db/` 时绝不覆盖，更新前先备份。

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
- `RequestLog.attempt`：故障转移第几次尝试（日志「尝试」列数据源）
- 日志自动清理：保留最近 2000 条（`MAX_REQUEST_LOGS`）

## 关键设计决策

| 决策 | 原因 |
|------|------|
| 适配器只转换「请求体/头/响应」，URL 拼接留在 gateway | baseUrl 自愈逻辑（404 反向变体重试）需要统一处理 endpoint |
| 策略返回排好序的数组而非生成器 | 预览 API 需要完整顺序做展示 |
| metadata 限制扁平 | 防止退化成无 schema 垃圾场，查询/索引友好 |
| channelName 存日志快照 | 渠道删除后历史日志仍可读 |

## 测试基建

- `.zscripts/fakeup/bare-server.js`（:9754）：假上游，支持 openai + anthropic 双协议、流/非流、`/toggle` 模拟宕机
- E2E 用统一 Key 走 `/v1/chat/completions` 全链路验证
