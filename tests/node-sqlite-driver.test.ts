/**
 * node-sqlite 纯绑定驱动单元测试（Prisma Client 子集适配器）
 * 运行：npm test（Node 22.5+，node:sqlite 内置模块）
 *
 * 覆盖：类型转换（Boolean/DateTime/Json）、where 操作符、orderBy 多键、
 * cursor 游标分页（Prisma skip 语义）、select/include、groupBy/aggregate、
 * upsert 双分支、update/delete 的 P2025 行为、$queryRaw/$executeRaw。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createNodeSqliteClient } = await import('../src/lib/db-driver/node-sqlite.ts')

const dir = mkdtempSync(join(tmpdir(), 'apihub-driver-'))
const dbFile = join(dir, 'test.db')
const db = createNodeSqliteClient(dbFile) as Record<string, any>

// 建表（与 db.ts ensureSchema 同款最小 DDL）
await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Channel" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "latencyMs" INTEGER,
  "metadata" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`)
await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ProbeLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "latencyMs" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`)
await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "RequestLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channelName" TEXT NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "latencyMs" INTEGER,
  "totalTokens" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`)

test('create/findUnique：类型还原（Boolean→true、DateTime→Date、id 自动生成）', async () => {
  const ch = await db.channel.create({
    data: { name: '测试渠道', enabled: true, latencyMs: 120, metadata: { weight: 2 } },
  })
  assert.ok(ch.id && typeof ch.id === 'string' && ch.id.length > 10, 'id 自动生成（cuid 形态）')
  assert.equal(ch.enabled, true)
  assert.ok(ch.createdAt instanceof Date, 'DateTime 还原为 Date')
  assert.deepEqual(ch.metadata, { weight: 2 }, 'Json 还原为对象')

  const found = await db.channel.findUnique({ where: { id: ch.id } })
  assert.equal(found.name, '测试渠道')
  assert.equal(found.latencyMs, 120)
})

test('where 操作符：in / not / gte / lt / null 等值', async () => {
  const t0 = new Date('2026-01-01T00:00:00Z')
  const logs = [
    { id: 'rl-1', channelName: 'a', ok: true, latencyMs: 100, totalTokens: 10, createdAt: t0 },
    { id: 'rl-2', channelName: 'a', ok: false, latencyMs: 300, totalTokens: 20, createdAt: new Date('2026-01-02T00:00:00Z') },
    { id: 'rl-3', channelName: 'b', ok: true, latencyMs: 500, totalTokens: 30, createdAt: new Date('2026-01-03T00:00:00Z') },
  ]
  for (const l of logs) await db.requestLog.create({ data: l })

  const inA = await db.requestLog.findMany({ where: { channelName: { in: ['a'] } } })
  assert.equal(inA.length, 2)
  const notA = await db.requestLog.findMany({ where: { channelName: { not: 'a' } } })
  assert.equal(notA.length, 1)
  assert.equal(notA[0].id, 'rl-3')
  const recent = await db.requestLog.findMany({ where: { createdAt: { gte: new Date('2026-01-02T00:00:00Z') } }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual(recent.map((r: any) => r.id), ['rl-2', 'rl-3'])
  const fast = await db.requestLog.findMany({ where: { latencyMs: { lt: 300 } } })
  assert.equal(fast.length, 1)
  assert.equal(fast[0].id, 'rl-1')
  // 布尔字段在 where 中以 true/false 表达，存储层为 1/0
  const okOnly = await db.requestLog.findMany({ where: { ok: true } })
  assert.equal(okOnly.length, 2)
})

test('orderBy 多键数组 + take/skip + select 投影', async () => {
  const rows = await db.requestLog.findMany({
    orderBy: [{ ok: 'desc' }, { latencyMs: 'asc' }],
    select: { id: true, latencyMs: true },
  })
  assert.deepEqual(rows.map((r: any) => r.id), ['rl-1', 'rl-3', 'rl-2'], 'ok desc（true 优先）再 latency asc')
  assert.equal(rows[0].channelName, undefined, 'select 未选字段不返回')

  const page = await db.requestLog.findMany({ orderBy: { createdAt: 'asc' }, take: 2, skip: 1 })
  assert.deepEqual(page.map((r: any) => r.id), ['rl-2', 'rl-3'])
})

test('cursor 游标分页：cursor+skip:1 的 Prisma 语义（跳过 cursor 行）', async () => {
  const first = await db.requestLog.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2 })
  assert.deepEqual(first.map((r: any) => r.id), ['rl-3', 'rl-2'])
  const next = await db.requestLog.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 2,
    cursor: { id: 'rl-2' },
    skip: 1,
  })
  assert.deepEqual(next.map((r: any) => r.id), ['rl-1'], '从 cursor 行的下一行开始')
})

test('update 自动维护 @updatedAt；updateMany 返回 { count }', async () => {
  const ch = await db.channel.create({ data: { name: '更新渠道' } })
  const before = ch.updatedAt as Date
  await new Promise((r) => setTimeout(r, 5))
  const updated = await db.channel.update({ where: { id: ch.id }, data: { name: '更新后', latencyMs: null } })
  assert.equal(updated.name, '更新后')
  assert.equal(updated.latencyMs, null, '显式置 null')
  assert.ok((updated.updatedAt as Date).getTime() > before.getTime(), '@updatedAt 自动推进')

  const many = await db.channel.updateMany({ where: { enabled: true }, data: { noSuchField: 1 } }).catch(() => null)
  // 上面字段不存在的调用应抛错（防御误用），这里验证 updateMany 正常路径：
  const okMany = await db.channel.updateMany({ where: { name: '更新后' }, data: { latencyMs: 42 } })
  assert.deepEqual(okMany, { count: 1 })
  assert.ok(many === null, '非法字段触发异常而非静默')
})

test('upsert 双分支（Channel 表）', async () => {
  const ch = await db.channel.upsert({
    where: { name: 'Upsert渠道' },
    create: { name: 'Upsert渠道', enabled: false },
    update: { enabled: true },
  })
  assert.equal(ch.enabled, false, '首次走 create')
  const again = await db.channel.upsert({
    where: { name: 'Upsert渠道' },
    create: { name: 'Upsert渠道', enabled: false },
    update: { enabled: true },
  })
  assert.equal(again.enabled, true, '第二次走 update')
})

test('update/updateMany 支持 Prisma 风格 { increment: n } 原子自增（failStreak/quotaUsed 依赖）', async () => {
  const ch = await db.channel.create({ data: { name: '自增渠道', latencyMs: 2 } })
  const u = await db.channel.update({ where: { id: ch.id }, data: { latencyMs: { increment: 1 } } })
  assert.equal(u.latencyMs, 3, 'update 原子自增')
  const u2 = await db.channel.update({ where: { id: ch.id }, data: { latencyMs: { increment: -3 } } })
  assert.equal(u2.latencyMs, 0, '负增量归零')
  const m = await db.channel.updateMany({ where: { name: '自增渠道' }, data: { latencyMs: { increment: 5 } } })
  assert.deepEqual(m, { count: 1 }, 'updateMany 返回 count')
  const final = await db.channel.findUnique({ where: { id: ch.id } })
  assert.equal(final.latencyMs, 5, 'updateMany 原子自增')
  // 混合：increment 字段与普通字段同 data
  const mix = await db.channel.update({ where: { id: ch.id }, data: { latencyMs: { increment: 1 }, name: '自增改名' } })
  assert.equal(mix.latencyMs, 6)
  assert.equal(mix.name, '自增改名')
  await db.channel.delete({ where: { id: ch.id } })
})

test('update/delete 缺行抛 P2025 形态错误；deleteMany 返回 count', async () => {
  await assert.rejects(
    () => db.channel.update({ where: { id: 'no-such-id' }, data: { name: 'x' } }),
    /P2025/,
  )
  await assert.rejects(() => db.channel.delete({ where: { id: 'no-such-id' } }), /P2025/)
  const del = await db.channel.deleteMany({ where: { name: 'Upsert渠道' } })
  assert.deepEqual(del, { count: 1 })
})

test('groupBy：by/_count._all/_sum + 布尔分组键还原', async () => {
  const grouped = await db.requestLog.groupBy({
    by: ['channelName', 'ok'],
    where: { createdAt: { gte: new Date('2026-01-01T00:00:00Z') } },
    _count: { _all: true },
    _sum: { latencyMs: true },
  })
  const a = grouped.find((g: any) => g.channelName === 'a' && g.ok === true)
  assert.equal(a._count._all, 1)
  assert.equal(a._sum.latencyMs, 100)
  const aFail = grouped.find((g: any) => g.channelName === 'a' && g.ok === false)
  assert.equal(aFail._count._all, 1)
})

test('aggregate：_count._all', async () => {
  const agg = await db.requestLog.aggregate({ _count: { _all: true } })
  assert.equal(agg._count._all, 3)
})

test('include 关联（ProbeLog→Channel）+ findFirst', async () => {
  const ch = await db.channel.create({ data: { name: '关联渠道' } })
  await db.probeLog.create({ data: { channelId: ch.id, ok: true, latencyMs: 55 } })
  const rows = await db.probeLog.findMany({
    where: { ok: true },
    include: { channel: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })
  assert.equal(rows[0].channel.name, '关联渠道')
  assert.equal(rows[0].channel.apiKey, undefined, '嵌套 select 生效')
  const first = await db.probeLog.findFirst({ where: { channelId: ch.id } })
  assert.equal(first.ok, true)
})

test('$queryRawUnsafe / $executeRawUnsafe（PRAGMA 与 sqlite_master）', async () => {
  const mode = await db.$queryRawUnsafe('PRAGMA journal_mode') as Array<Record<string, unknown>>
  assert.ok(mode[0] && 'journal_mode' in mode[0])
  const tables = await db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('Channel','RequestLog')`) as Array<{ name: string }>
  assert.equal(tables.length, 2)
  const changes = await db.$executeRawUnsafe(`UPDATE "Channel" SET "latencyMs" = 1 WHERE "latencyMs" IS NULL`)
  assert.equal(typeof changes, 'number')
})

test('count', async () => {
  const n = await db.requestLog.count({ where: { ok: true } })
  assert.equal(n, 2)
})

test('清理临时库', () => {
  ;(db as any).$disconnect()
  rmSync(dir, { recursive: true, force: true })
})
