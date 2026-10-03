# API Hub 本地部署交接文档（HANDOVER）

> 交接对象：本地 AI 助手 / 操作者。执行环境：Windows 10/11。
> 来源：云端沙箱（Linux）开发并全量 E2E 验证的 V27 版本。**以下步骤在 Linux 沙箱实测通过，Windows 原生环境未经实机验证**——遇到差异请按「判断分支」处理并在结果中如实记录。

## 项目是什么

个人公益站 API 聚合网关：多渠道管理、实时探测、自定义路由（6 种负载均衡策略）、模型改名、OpenAI 兼容统一调用、用量统计、配置备份。技术栈：Next.js (App Router) + Prisma + SQLite + Tailwind。

## 包内容清单

```
full-stack/
├─ src/                  源码（lib/adapters/ 三协议适配器、策略注册表）
├─ prisma/schema.prisma  数据模型
├─ db/custom.db          ⚠️ 现有数据库（含渠道 Key、路由、密钥、调用日志）
├─ ARCHITECTURE.md       架构与扩展指南
└─ doctor.mjs            环境自检脚本
```

## 阶段 0：环境自检（先跑这个）

```powershell
node doctor.mjs
```

输出各项 PASS/FAIL 与修复建议。全部 PASS 才进入阶段 1。

## 阶段 1：安装依赖

```powershell
cd full-stack
bun install          # 首选 bun（项目脚本基于 bun run）
```

**判断分支**：
- 无 bun → `npm install -g bun` 安装；或全部用 npm 等价命令：`npm install` / `npx prisma generate` / `npm run dev`
- 安装超时/失败 → 换国内镜像 `bun install --registry https://registry.npmmirror.com`

## 阶段 2：初始化

```powershell
bun run db:generate   # 生成 Prisma Client（必须，否则启动报错）
```

**注意**：`db/custom.db` 已随包附带（含你的真实配置），**不要**跑 `db:push`（会重置结构）也不要跑 `db:reset`（会清库！）。
只有当 doctor 提示 schema 与库结构不一致时才执行 `bun run db:push`。

## 阶段 3：启动与验收

```powershell
bun run dev           # 开发模式启动（http://localhost:3000）
```

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

用 pm2 或 nssm 把 `bun run dev` 注册为服务；或先手动跑稳定再考虑。

## 安全约束（必须遵守）

1. **db/custom.db 含明文 API Key**（渠道上游 Key + 统一调用 Key）——不要上传网盘/公开仓库，不要发给任何人
2. **网关只监听本机**（localhost）。要局域网访问需自行加反向代理 + 管理台强密码；**不要裸暴露公网**（管理 API 无 HTTPS + 密钥明文存储，公网直挂等于送 Key）
3. 管理员 JWT 密钥存于库 `Setting` 表（jwtSecret），泄露 = 管理台失守，同样勿外传
4. 破坏性操作（`db:reset`、删渠道、清日志）执行前必须先确认

## 应急操作

- **管理员密码遗失**：删除库里 `Setting` 表 `adminPasswordHash` 行后重启，首次访问会要求重新设置（以页面提示为准；若无此流程则联系云端侧重置）
- **库损坏/结构错乱**：`bun run db:push --accept-data-loss` 会重置结构但尽量保留数据；彻底重置前先在管理台「配置备份」导出 JSON
- **依赖损坏**：删 node_modules + bun.lock 重装

## 回报格式

执行完成后按此格式回报：每阶段 PASS/FAIL、doctor 输出摘要、遇到的分支与采取的路径、验收 6 项结果。
