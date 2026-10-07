# Termux (Android) 部署指南

在 Android 手机 / 平板的 Termux 里完整运行 API Hub 网关。

## 为什么以前不行，现在可以了

Prisma 6 的 query engine 是 glibc 原生二进制，与 Android 的 bionic libc 不兼容
（`dlopen failed: library "libpthread.so.0" not found`），Prisma 官方不支持 Android。

本项目新增了 **node:sqlite 纯绑定驱动适配器**（`src/lib/db-driver/node-sqlite.ts`）：
用 Node 22.5+ 内置的 `node:sqlite` 模块实现了项目用到的 Prisma Client API 子集
（findMany / create / update / groupBy / aggregate / cursor 分页 / include 关联等），
**零原生编译依赖**，在 Android 上自动切换。

## 环境要求

| 项 | 要求 |
|---|---|
| Termux | F-Droid 版（Play 版已停止更新，不推荐） |
| Node.js | **>= 22.5**（`node:sqlite` 内置模块要求）|
| 存储 | ~500MB（依赖 + 构建）|

## 一键安装

```bash
# Termux 内执行
pkg update && pkg upgrade
bash <(curl -fsSL https://raw.githubusercontent.com/plxlaaa/api-hub/main/install-termux.sh)
```

或手动：

```bash
pkg install -y nodejs git
git clone https://github.com/plxlaaa/api-hub.git ~/api-hub
cd ~/api-hub
npm install
node node_modules/prisma/build/index.js generate   # 生成类型（可选）
npm run build
npm run start:node
```

浏览器访问 `http://localhost:3000` 完成管理员初始化。

## 驱动切换机制

- **自动**：检测到 Android（`/system/build.prop` / `$PREFIX` 含 termux）→ node-sqlite 驱动
- **手动**：环境变量 `DB_DRIVER=node-sqlite`（强制）/ `DB_DRIVER=prisma`（强制）
- 日志会打印 `使用 node-sqlite 纯绑定驱动（无 Prisma 引擎）`

两种驱动操作**同一个 SQLite 文件**（`db/custom.db`），数据完全互通——
Termux 里建的库拷回 Linux 服务器（或反之）可直接用。

## 已知差异（node-sqlite 驱动 vs Prisma）

适配器覆盖了项目全部数据访问模式（有 123 项单测双驱动各跑一遍保证行为一致），
但作为通用 Prisma 替代品，以下特性**不支持**（项目未用到）：

- `$transaction` 事务
- 嵌套写（`create: { channel: { connect: ... } }`）
- 关系过滤（`where: { channel: { name: ... } }`）
- `createMany`

如果未来开发用到这些，需在 Prisma 驱动环境下运行或扩展适配器。

## 保持后台运行

Android 会积极杀后台进程，三个对策：

```bash
# 1. 电池优化白名单 + 唤醒锁（最简）
termux-wake-lock

# 2. 通知栏常驻（Termux:Boot 开机自启）
pkg install termux-services
sv-enable apihub   # 需要先写一个 run 脚本，见下

# 3. runit 服务脚本示例（$PREFIX/sv/apihub/run）
#!/data/data/com.termux/files/usr/bin/sh
cd $HOME/api-hub
exec npm run start:node 2>&1
```

## 排障

```bash
node doctor.mjs        # 环境自检（含 Android/node:sqlite 检测）
tail -f server.log     # 运行日志
DB_DEBUG=1 npm run start:node   # 打印每条 SQL（驱动调试）
```

常见问题：

| 症状 | 处置 |
|---|---|
| `Cannot find module 'node:sqlite'` | Node < 22.5，`pkg upgrade nodejs` |
| `prisma generate` 报错 | 不影响 Termux 运行，仅影响类型提示 |
| 手机重启后服务没了 | 见「保持后台运行」 |
| `/usr/bin/env: bad interpreter` | Termux 无 `/usr/bin/env`，npm scripts 内部已用 node 直调规避 |
