import path from 'node:path'
import { PrismaClient } from '@prisma/client'

// The DB location is a project-relative invariant: <project root>/db/custom.db.
// Ignore the platform-injected DATABASE_URL (workspace root) entirely.
//
// 并发要点（SQLite 单写者模型）：
// - connection_limit=1：Prisma 连接池串行化写事务，避免 SQLITE_BUSY
// - WAL：读写不互斥，探测调度器写日志的同时网关仍可读
// - busy_timeout：写锁竞争时等待而不是立刻报错
// 这三项在首次连接时通过 $queryRaw 设置（PRAGMA 是连接级语句，需在连接建立后执行）。
const dbFile = path.join(process.cwd(), 'db', 'custom.db')
const databaseUrl = `file:${dbFile}?connection_limit=1`

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaReady: Promise<void> | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: databaseUrl,
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })

/**
 * 应用 SQLite PRAGMA。
 * 用 $executeRawUnsafe 而非 $queryRaw：PRAGMA journal_mode 会返回结果集，用 execute 会被驱动拒。
 * 失败只记警告不抛：老版本 SQLite 不支持 WAL 时应能降级回默认日志模式继续跑。
 */
async function applyPragmas(client: PrismaClient): Promise<void> {
  for (const pragma of [
    'PRAGMA journal_mode = WAL',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA foreign_keys = ON',
  ]) {
    try {
      await client.$queryRawUnsafe(pragma)
    } catch (err) {
      console.warn(`[db] ${pragma} 执行失败（继续运行）:`, err instanceof Error ? err.message : err)
    }
  }
}

/**
 * 确保数据表存在（幂等）。
 *
 * 背景：容器/全新安装时 db/custom.db 是一个空文件（Docker 卷首次挂载即如此），
 * 表还没建，探测调度器与所有接口都会抛 P2021「table does not exist」。
 * 之前依赖安装脚本手动跑 `prisma db push`，但容器场景拿不到 prisma CLI。
 *
 * 这里用与 schema.prisma 等价的 CREATE TABLE IF NOT EXISTS DDL 兜底建表：
 * - 幂等：已存在则无副作用，绝不碰已有数据
 * - 无外部依赖：纯 SQL，不需要 prisma CLI
 * - 缺索引时补建（见下方 CREATE INDEX IF NOT EXISTS）
 *
 * ⚠️ schema 变更后必须同步这里 —— 新增表/列需要补一条 ALTER TABLE。
 * 已有部署升级时由 `install-api-hub.sh --update` 走 prisma db push 正常迁移。
 */
const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "Setting" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "key" TEXT NOT NULL,
     "value" TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Setting_key_key" ON "Setting"("key")`,

  `CREATE TABLE IF NOT EXISTS "Channel" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "name" TEXT NOT NULL,
     "baseUrl" TEXT NOT NULL,
     "apiKey" TEXT NOT NULL,
     "apiFormat" TEXT NOT NULL DEFAULT 'openai',
     "models" TEXT NOT NULL DEFAULT '[]',
     "enabled" BOOLEAN NOT NULL DEFAULT true,
     "autoDisabled" BOOLEAN NOT NULL DEFAULT false,
     "failStreak" INTEGER NOT NULL DEFAULT 0,
     "autoDisabledAt" DATETIME,
     "status" TEXT NOT NULL DEFAULT 'unknown',
     "latencyMs" INTEGER,
     "lastCheckAt" DATETIME,
     "lastError" TEXT,
     "remark" TEXT,
     "metadata" JSONB,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS "ModelRoute" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "displayName" TEXT NOT NULL,
     "targetModel" TEXT NOT NULL,
     "channelIds" TEXT NOT NULL DEFAULT '[]',
     "channelConfigs" TEXT NOT NULL DEFAULT '[]',
     "strategy" TEXT NOT NULL DEFAULT 'priority',
     "priceIn" REAL,
     "priceOut" REAL,
     "enabled" BOOLEAN NOT NULL DEFAULT true,
     "remark" TEXT,
     "metadata" JSONB,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ModelRoute_displayName_key" ON "ModelRoute"("displayName")`,

  `CREATE TABLE IF NOT EXISTS "ApiToken" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "name" TEXT NOT NULL,
     "key" TEXT NOT NULL,
     "enabled" BOOLEAN NOT NULL DEFAULT true,
     "quotaLimit" INTEGER,
     "quotaUsed" INTEGER NOT NULL DEFAULT 0,
     "lastUsedAt" DATETIME,
     "metadata" JSONB,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ApiToken_key_key" ON "ApiToken"("key")`,

  `CREATE TABLE IF NOT EXISTS "ProbeLog" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "channelId" TEXT NOT NULL,
     "ok" BOOLEAN NOT NULL,
     "latencyMs" INTEGER,
     "statusCode" INTEGER,
     "error" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ProbeLog_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
   )`,
  // 统计与清理都按时间倒序扫描，缺索引会全表扫
  `CREATE INDEX IF NOT EXISTS "ProbeLog_createdAt_idx" ON "ProbeLog"("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ProbeLog_channelId_createdAt_idx" ON "ProbeLog"("channelId", "createdAt")`,

  `CREATE TABLE IF NOT EXISTS "RequestLog" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "channelName" TEXT NOT NULL,
     "model" TEXT NOT NULL,
     "targetModel" TEXT NOT NULL,
     "ok" BOOLEAN NOT NULL,
     "statusCode" INTEGER,
     "latencyMs" INTEGER,
     "totalTokens" INTEGER,
     "tokenName" TEXT,
     "stream" BOOLEAN NOT NULL DEFAULT false,
     "attempt" INTEGER NOT NULL DEFAULT 1,
     "error" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  // 仪表盘/统计几乎每次都按时间过滤 + groupBy(channelName)，复合索引覆盖主要查询
  `CREATE INDEX IF NOT EXISTS "RequestLog_createdAt_idx" ON "RequestLog"("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "RequestLog_channelName_createdAt_idx" ON "RequestLog"("channelName", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "RequestLog_model_createdAt_idx" ON "RequestLog"("model", "createdAt")`,
]

/**
 * 检查表是否存在（任一主表缺失即视为未初始化）。
 * 用 sqlite_master 查询，不需要额外依赖。
 */
async function tablesMissing(client: PrismaClient): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('Setting','Channel','ModelRoute','ApiToken','ProbeLog','RequestLog')`,
  )
  return rows.length < 6
}

async function ensureSchema(client: PrismaClient): Promise<void> {
  try {
    if (!(await tablesMissing(client))) return
    console.log('[db] 未检测到完整数据表，正在自动初始化…')
    for (const ddl of SCHEMA_DDL) {
      await client.$executeRawUnsafe(ddl)
    }
    console.log('[db] 数据表初始化完成')
  } catch (err) {
    // 建表失败不阻断启动：让上层接口报出真实错误，便于排查
    console.error('[db] 自动建表失败：', err instanceof Error ? err.message : err)
  }
}

async function bootstrap(client: PrismaClient): Promise<void> {
  await ensureSchema(client)
  await applyPragmas(client)
  console.log('[db] SQLite 就绪（WAL + busy_timeout=5000）')
}

export const dbReady: Promise<void> = (globalForPrisma.prismaReady ??= bootstrap(db).catch((err) => {
  console.warn('[db] 初始化异常（继续运行）:', err instanceof Error ? err.message : err)
}))

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db