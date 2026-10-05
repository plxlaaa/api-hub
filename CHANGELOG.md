# 更新日志

本文件记录 API Hub 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增
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

### 变更
- **日志接口响应体变更**：`/api/request-logs` 与 `/api/logs` 由裸数组改为
  `{ items, nextCursor, hasMore }` 信封。**前端需改读 `items`**；未传 `cursor` 时
  `items` 内容与从前一致。
- `X-Request-Id` 现在同时出现在网关响应头与所有管理端错误响应中，便于把客户端报错
  与服务端日志对应起来。
- `gateway.ts` / `probe.ts` / `db.ts` 内的 `console.*` 全部替换为 `log.*`，
  日志字段化后可被 journald / Loki 直接采集。
- 网关请求完成时输出一条汇总日志（状态码、耗时、是否管理测试模式）。
- `/api/health` 成为推荐探针端点；Dockerfile 与 docker-compose.yml 的 healthcheck 已切换。

### 修复
- 超长或含非法字符的 `X-Request-Id` 请求头此前会被**截断**后放行，不同请求可能撞到同一
  ID 导致日志串联误导；现改为整段拒绝并重新生成。

## [V27] — 2026-10-04

### 新增
- Docker / docker-compose 部署路径。
- `install-api-hub.sh` 补齐 Linux 各发行版，`install-api-hub.ps1` 覆盖 Windows。
- 发布流程：打 tag 自动打包三平台附件并发布 Release。

### 安全
- 上游错误体密钥自动脱敏；渠道地址默认禁内网（防 SSRF）。
- 客户端断开即中止上游请求，不白烧额度。
- 统一 Key 限速+ 配额原子扣减；SQLite WAL + 忙等超时；熔断冷却期防抖动。

[未发布]: https://github.com/plxlaaa/api-hub/compare/v27...HEAD
[V27]: https://github.com/plxlaaa/api-hub/releases/tag/v27