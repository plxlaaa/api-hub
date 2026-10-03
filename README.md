# API Hub · 个人公益站 API 聚合网关

把散落各处的公益站（免费 AI 中转站）Key 聚合成**一个地址、一把 Key**：多渠道管理、实时探测、智能路由、统一调用、用量统计。

> 个人运营使用，非通用商业产品。Private 仓库，请勿分发包含运营数据的副本。

## 功能总览（V27）

| 模块 | 能力 |
|------|------|
| 📡 多渠道管理 | OpenAI 兼容 / Anthropic 原生 / Google Gemini 三协议；baseUrl 路径填错自愈（404 反向变体重试+回写） |
| 🔀 智能路由 | 模型改名 + 渠道编排，6 种负载均衡策略：优先级 / 权重随机 / 速度 / 智商 / 稳定性 / 💰 成本优先；尝试顺序预览与实际转发共用同一实现 |
| 🛡️ 熔断保护 | 探测连续失败自动摘除渠道 + 权重负载恢复；故障转移全链路可视（每次尝试记入日志） |
| 📊 运营数据 | 渠道横评（调用量/成功率/延迟/Token）、24h 探测可用率、密钥级用量统计、仪表盘 Top5 + 7d 趋势 |
| 🔑 统一调用 | 客户端始终用 OpenAI 格式访问网关；密钥配额限制；流式 SSE 全支持 |
| 🔐 管理安全 | 首次自设用户名+密码（scrypt 加盐哈希，明文不落盘）；一次性设置令牌防抢注；登录 5 次错锁 10 分钟；HttpOnly 会话 Cookie 防 XSS 窃取 |
| 🌐 配套 | 公开模型广场（脱敏状态页）、明暗双主题、配置备份导出/导入 |

## 快速开始

前置：Node.js ≥ 18（推荐 bun）

```bash
# 先跑环境自检
node doctor.mjs

# 安装依赖
bun install        # 或 npm install

# 初始化 Prisma Client（不要跑 db:reset，会清库）
bun run db:generate

# 启动
bun run dev        # http://localhost:3000
```

首次进入面板会要求创建管理员账号：**用户名 + 密码 + 一次性设置令牌**。令牌在服务启动日志里打印，
或见本机 `db/setup-token.txt`（权限 600，仅本机可见）——它用于防止面板暴露公网时被人抢先注册，
建号成功即焚毁。之后用用户名+密码登录，再到「渠道管理」添加你的上游 Key。

详细部署步骤与故障排查见 [HANDOVER.md](HANDOVER.md)；数据库（含密钥）不在仓库内，用管理台「配置备份」迁移。

## 统一调用示例

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-gw-你的统一Key" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude", "messages": [{"role": "user", "content": "hi"}]}'
```

`model` 填模型路由的显示名；网关按路由策略选渠道、自动故障转移，客户端无感。

## 架构与扩展

核心扩展点收敛为三层，新能力以「注册/新增文件」接入，主流程零改动：

1. **协议适配器**（`src/lib/adapters/`）——加新上游协议 = 新增一个 adapter 文件 + 注册一行
2. **路由策略注册表**（`src/lib/route-order.ts`）——加新策略 = 一个排序函数 + 注册一行
3. **metadata Json 字段**——实验配置先放 metadata 验证，稳定再升级正式列

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 技术栈

Next.js (App Router) · TypeScript · Prisma + SQLite · Tailwind CSS · shadcn/ui · TanStack Query

## 安全须知

- `db/custom.db` 含明文 API Key：勿上传公开仓库/网盘，勿裸暴露公网（如需外网访问请加反向代理 + 强密码）
- 管理员密码以 scrypt 加盐哈希存于本机 `db/credentials.env`（权限 600，明文不落盘），同样勿提交/外传
- 管理端已做服务器面板级防护：一次性设置令牌（防抢注）、登录 5 次错锁 10 分钟、HttpOnly 会话 Cookie
- 面板若要暴露公网，**务必配 HTTPS**（域名 + 反向代理）；`公网IP:端口` 裸 HTTP 会让登录密码明文过网
- 捐赠渠道的 Key 请仅用于个人额度，遵守各公益站规则
