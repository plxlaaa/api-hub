/**
 * 纯 JS SQLite 驱动适配器 —— Prisma Client 子集实现（零 glibc 原生依赖）
 *
 * 背景（repo issue #1）：Prisma 6 的 query engine 是 glibc 原生二进制，在
 * Android/Termux（bionic libc）上无法 dlopen（报 libpthread.so.0 not found），
 * 且 Prisma 官方不发布 Android 引擎。本文件用 SQLite 纯绑定实现项目实际
 * 用到的 Prisma API 子集，让 Termux / 无引擎环境可以完整运行：
 *
 *   findMany / findUnique / findFirst / create / update / updateMany /
 *   delete / deleteMany / count / groupBy / aggregate / upsert
 *   + $queryRawUnsafe / $executeRawUnsafe / $disconnect
 *
 * 底层绑定按运行时自动选择（都不需要编译原生模块）：
 * - Node 22.5+（Termux / 标准部署）：node:sqlite 内置模块
 * - Bun（沙箱/开发）：bun:sqlite
 *
 * 支持的查询特性（按 src/ 全量扫描清点，未列出的特性不支持）：
 * - where：等值、null、not、in/notIn、lt/lte/gt/gte、contains/startsWith/endsWith(+mode)
 * - 逻辑组：OR / AND / NOT；undefined 字段按 Prisma 语义忽略
 * - orderBy：单对象或数组（多键）；cursor 游标分页（skip 含 cursor 行的 Prisma 语义）
 * - select 投影 / include（ProbeLog→Channel 关联）/ take / skip
 * - groupBy（by / _count._all / _sum）与 aggregate（_count/_sum/_avg/_min/_max）
 * - 类型转换：Boolean(1/0↔true/false)、DateTime(epoch ms↔Date)、Json(文本↔对象)
 * - @default(cuid()/now()) 与 @updatedAt 自动维护（Prisma 客户端职责前移到驱动层）
 *
 * 明确不支持（项目也未用到）：$transaction、嵌套 create/connect、relation 过滤、
 * createMany、JOIN 查询。误用时直接抛错，绝不静默错判。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------- 底层绑定 ----------

interface RawBackend {
  all(sql: string, params?: unknown[]): unknown[]
  run(sql: string, params?: unknown[]): { changes: number }
  close(): void
}

/** 两个绑定各自用到的最小接口形态（避免引入 @types 依赖） */
interface BunDb {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number | bigint } }
  close(): void
}
interface NodeDb {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number | bigint } }
  close(): void
}

/**
 * 加载 SQLite 绑定（运行时自动选择，均零原生编译依赖）：
 * - Bun（沙箱/开发）：bun:sqlite
 * - Node 22.3+（Termux / 标准部署）：node:sqlite 内置模块
 */
function loadBackend(dbFile: string): RawBackend {
  mkdirSync(dirname(dbFile), { recursive: true })
  // process.getBuiltinModule（Node 22.3+ / Bun）是官方内置模块加载入口：
  // - 不经过打包器静态分析（createRequire 的动态 require 会被 Turbopack 运行时拦截，
  //   报 "Cannot find module as expression is too dynamic"）
  // - 字面量模块名也安全：这只是普通的函数调用，bundler 不会改写
  const gbm = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  if (!gbm) throw new Error('当前运行时缺少 process.getBuiltinModule（需 Node 22.3+）')
  if (typeof (globalThis as Record<string, unknown>).Bun !== 'undefined') {
    const { Database } = gbm.call(process, 'bun:sqlite') as { Database: new (p: string) => BunDb }
    const d = new Database(dbFile)
    return {
      all: (sql, params = []) => d.prepare(sql).all(...params),
      run: (sql, params = []) => ({ changes: Number(d.prepare(sql).run(...params).changes) }),
      close: () => d.close(),
    }
  }
  const { DatabaseSync } = gbm.call(process, 'node:sqlite') as { DatabaseSync: new (p: string) => NodeDb }
  const d = new DatabaseSync(dbFile)
  return {
    all: (sql, params = []) => d.prepare(sql).all(...params),
    run: (sql, params = []) => {
      const r = d.prepare(sql).run(...params)
      return { changes: Number(r.changes) }
    },
    close: () => d.close(),
  }
}

// ---------- schema 元数据（与 prisma/schema.prisma 保持同步） ----------

const T_STR = 'str'
const T_INT = 'int'
const T_FLOAT = 'float'
const T_BOOL = 'bool'
const T_DATE = 'date'
const T_JSON = 'json'

/** 每张表的列 → 逻辑类型。新增表/列必须同步 prisma/schema.prisma 与 db.ts 的 SCHEMA_DDL。 */
const TABLES: Record<string, Record<string, string>> = {
  Setting: { id: T_STR, key: T_STR, value: T_STR },
  Channel: {
    id: T_STR, name: T_STR, baseUrl: T_STR, apiKey: T_STR, apiFormat: T_STR, models: T_STR,
    enabled: T_BOOL, autoDisabled: T_BOOL, failStreak: T_INT, autoDisabledAt: T_DATE, status: T_STR,
    latencyMs: T_INT, lastCheckAt: T_DATE, lastError: T_STR, remark: T_STR, metadata: T_JSON,
    createdAt: T_DATE, updatedAt: T_DATE,
  },
  ModelRoute: {
    id: T_STR, displayName: T_STR, targetModel: T_STR, channelIds: T_STR, channelConfigs: T_STR,
    strategy: T_STR, priceIn: T_FLOAT, priceOut: T_FLOAT, enabled: T_BOOL, remark: T_STR,
    metadata: T_JSON, createdAt: T_DATE, updatedAt: T_DATE,
  },
  ApiToken: {
    id: T_STR, name: T_STR, key: T_STR, enabled: T_BOOL, quotaLimit: T_INT, quotaUsed: T_INT,
    lastUsedAt: T_DATE, metadata: T_JSON, createdAt: T_DATE,
  },
  ProbeLog: {
    id: T_STR, channelId: T_STR, ok: T_BOOL, latencyMs: T_INT, statusCode: T_INT, error: T_STR,
    createdAt: T_DATE,
  },
  RequestLog: {
    id: T_STR, channelName: T_STR, model: T_STR, targetModel: T_STR, ok: T_BOOL, statusCode: T_INT,
    latencyMs: T_INT, totalTokens: T_INT, tokenName: T_STR, stream: T_BOOL, attempt: T_INT,
    error: T_STR, createdAt: T_DATE,
  },
}

/** 带 @updatedAt 的表：update/updateMany 时驱动层自动刷新 */
const HAS_UPDATED_AT = new Set(['Channel', 'ModelRoute'])

/** 关联关系（include 用）。当前仅 ProbeLog→Channel（多对一）。 */
const RELATIONS: Record<string, Record<string, { table: string; field: string }>> = {
  ProbeLog: { channel: { table: 'Channel', field: 'channelId' } },
}

function mustTable(table: string): Record<string, string> {
  const cols = TABLES[table]
  if (!cols) throw new Error(`未知的表 ${table}（驱动未实现或 schema 未同步）`)
  return cols
}

function mustField(table: string, field: string): string {
  const cols = mustTable(table)
  if (!cols[field]) throw new Error(`表 ${table} 不存在字段 ${field}`)
  return cols[field]
}

// ---------- 值转换（JS 值 ↔ SQLite 存储） ----------

/** cuid 风格 id：时间前缀保证趋势递增 + 随机尾巴保证唯一（Prisma 的 @default(cuid()) 等价物） */
function genId(): string {
  return 'c' + Date.now().toString(36) + randomBytes(9).toString('hex')
}

/** JS 值 → SQLite 存储值（调用方保证 v !== undefined） */
function toSql(table: string, field: string, v: unknown): unknown {
  const type = mustField(table, field)
  if (v === null) return null
  switch (type) {
    case T_BOOL:
      if (typeof v !== 'boolean' && v !== 0 && v !== 1) throw new Error(`${table}.${field} 需要 boolean，收到 ${typeof v}`)
      return v === true || v === 1 ? 1 : 0
    case T_DATE: {
      const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(String(v)).getTime()
      if (Number.isNaN(ms)) throw new Error(`${table}.${field} 无法解析为日期: ${String(v)}`)
      return ms
    }
    case T_JSON:
      return typeof v === 'string' ? v : JSON.stringify(v)
    case T_INT: {
      const n = Number(v)
      if (!Number.isInteger(n)) throw new Error(`${table}.${field} 需要 integer，收到 ${String(v)}`)
      return n
    }
    default:
      return v
  }
}

/** SQLite 行 → JS 对象（按表元数据做类型还原） */
function fromRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const cols = mustTable(table)
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(row)) {
    const type = cols[field]
    if (type === undefined) {
      out[field] = value
      continue
    }
    if (value === null) {
      out[field] = null
      continue
    }
    switch (type) {
      case T_BOOL:
        out[field] = value === 1 || value === true
        break
      case T_DATE:
        out[field] = typeof value === 'number' ? new Date(value) : new Date(String(value))
        break
      case T_JSON:
        try {
          out[field] = typeof value === 'string' ? JSON.parse(value) : value
        } catch {
          out[field] = value
        }
        break
      default:
        out[field] = value
    }
  }
  return out
}

// ---------- where 子句编译 ----------

interface WhereInput {
  AND?: unknown
  OR?: unknown
  NOT?: unknown
  [field: string]: unknown
}

function quoteCol(field: string): string {
  return `"${field}"`
}

/** 单字段的操作符条件 */
function fieldCondition(table: string, field: string, cond: unknown, params: unknown[]): string {
  const col = quoteCol(field)
  // 标量等值（含 null → IS NULL）
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond) || cond instanceof Date) {
    if (cond === null) return `${col} IS NULL`
    params.push(toSql(table, field, cond))
    return `${col} = ?`
  }
  const ops = cond as Record<string, unknown>
  const parts: string[] = []
  const push = (sql: string, ...vs: unknown[]) => {
    params.push(...vs)
    parts.push(sql)
  }
  if (ops.equals !== undefined) return fieldCondition(table, field, ops.equals, params)
  if (ops.mode !== undefined && typeof ops.mode !== 'string') throw new Error(`${field}.mode 需为 'default'|'insensitive'`)
  const insensitive = ops.mode === 'insensitive'
  if (ops.not !== undefined) {
    if (ops.not === null) parts.push(`${col} IS NOT NULL`)
    else parts.push(`NOT (${fieldCondition(table, field, ops.not, params)})`)
  }
  for (const [key, op] of [['in', 'IN'], ['notIn', 'NOT IN']] as const) {
    const v = ops[key]
    if (v === undefined) continue
    if (!Array.isArray(v)) throw new Error(`${field}.${key} 需为数组`)
    if (v.length === 0) {
      // Prisma 语义：空 in 匹配不到任何行
      parts.push(op === 'IN' ? '0' : '1')
      continue
    }
    const converted = v.map((x) => toSql(table, field, x))
    params.push(...converted)
    parts.push(`${col} ${op} (${converted.map(() => '?').join(', ')})`)
  }
  for (const [key, op] of [['lt', '<'], ['lte', '<='], ['gt', '>'], ['gte', '>=']] as const) {
    const v = ops[key]
    if (v === undefined) continue
    push(`${col} ${op} ?`, toSql(table, field, v))
  }
  if (ops.contains !== undefined) {
    const v = ops.contains
    if (typeof v !== 'string') throw new Error(`${field}.contains 需为字符串`)
    // INSTR 方案：大小写敏感忠实于 Prisma 默认行为，且天然免疫 % _ 通配符注入
    if (insensitive) push(`instr(lower(${col}), lower(?)) > 0`, v)
    else push(`instr(${col}, ?) > 0`, v)
  }
  if (ops.startsWith !== undefined) {
    const v = ops.startsWith
    if (typeof v !== 'string') throw new Error(`${field}.startsWith 需为字符串`)
    if (insensitive) push(`lower(substr(${col}, 1, length(?))) = lower(?)`, v, v)
    else push(`substr(${col}, 1, length(?)) = ?`, v, v)
  }
  if (ops.endsWith !== undefined) {
    const v = ops.endsWith
    if (typeof v !== 'string') throw new Error(`${field}.endsWith 需为字符串`)
    push(`length(${col}) >= length(?) AND substr(${col}, -length(?)) = ?`, v, v, v)
  }
  if (parts.length === 0) throw new Error(`${field} 的 where 条件为空对象（驱动不支持的操作符？）`)
  return `(${parts.join(' AND ')})`
}

function buildWhere(table: string, where: WhereInput | undefined, params: unknown[]): string {
  if (!where) return '1=1'
  const parts: string[] = []
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue // Prisma 语义：undefined 字段忽略
    if (key === 'AND') {
      if (Array.isArray(value)) {
        const inner = value.map((w) => buildWhere(table, w as WhereInput, params))
        parts.push(inner.length ? `(${inner.join(' AND ')})` : '1')
      } else parts.push(buildWhere(table, value as WhereInput, params))
    } else if (key === 'OR') {
      if (!Array.isArray(value)) throw new Error('OR 需为数组')
      const inner = value.map((w) => buildWhere(table, w as WhereInput, params))
      parts.push(inner.length ? `(${inner.join(' OR ')})` : '0')
    } else if (key === 'NOT') {
      if (Array.isArray(value)) {
        const inner = value.map((w) => `NOT (${buildWhere(table, w as WhereInput, params)})`)
        parts.push(inner.length ? `(${inner.join(' AND ')})` : '1')
      } else parts.push(`NOT (${buildWhere(table, value as WhereInput, params)})`)
    } else {
      mustField(table, key) // 未知字段直接抛错，尽早暴露笔误
      parts.push(fieldCondition(table, key, value, params))
    }
  }
  return parts.length ? parts.join(' AND ') : '1=1'
}

// ---------- orderBy / cursor ----------

interface OrderSpec { field: string; dir: 'asc' | 'desc' }

function normalizeOrderBy(table: string, orderBy: unknown): OrderSpec[] {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  const specs: OrderSpec[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('orderBy 需为对象或对象数组')
    for (const [field, dir] of Object.entries(item as Record<string, unknown>)) {
      mustField(table, field)
      if (dir !== 'asc' && dir !== 'desc') throw new Error(`${field} 的排序方向需为 'asc'|'desc'`)
      specs.push({ field, dir })
    }
  }
  return specs
}

function buildOrderBySql(specs: OrderSpec[]): string {
  if (specs.length === 0) return ''
  return ' ORDER BY ' + specs.map((s) => `${quoteCol(s.field)} ${s.dir.toUpperCase()}`).join(', ')
}

// ---------- 聚合 ----------

const AGG_SQL: Record<string, (col: string) => string> = {
  _count: (col) => (col === '_all' ? 'COUNT(*)' : `COUNT(${quoteCol(col)})`),
  _sum: (col) => `SUM(${quoteCol(col)})`,
  _avg: (col) => `AVG(${quoteCol(col)})`,
  _min: (col) => `MIN(${quoteCol(col)})`,
  _max: (col) => `MAX(${quoteCol(col)})`,
}

/** 把 {_count:{_all:true}, _sum:{latencyMs:true}} 编译为 SELECT 片段 + 结果整形器 */
function compileAggregates(agg: Record<string, unknown> | undefined): {
  selectFrag: string
  shape: (row: Record<string, unknown>) => Record<string, unknown>
} {
  const frag: string[] = []
  const keys: Array<{ group: string; field: string; alias: string }> = []
  for (const [group, spec] of Object.entries(agg ?? {})) {
    const fn = AGG_SQL[group]
    if (!fn) continue // by 字段等非聚合键跳过
    if (!spec || typeof spec !== 'object') throw new Error(`${group} 需为 { 字段: true } 形式`)
    for (const [field, on] of Object.entries(spec as Record<string, unknown>)) {
      if (on !== true) continue
      const alias = `__agg_${group}_${field}`
      frag.push(`${fn(field)} AS "${alias}"`)
      keys.push({ group, field, alias })
    }
  }
  return {
    selectFrag: frag.length ? ', ' + frag.join(', ') : '',
    shape: (row) => {
      const out: Record<string, unknown> = {}
      for (const { group, field, alias } of keys) {
        out[group] ??= {}
        const v = row[alias]
        ;(out[group] as Record<string, unknown>)[field] = v === null || v === undefined ? null : Number(v)
      }
      return out
    },
  }
}

// ---------- 驱动主体 ----------

interface TableDelegate {
  findMany(args?: Record<string, unknown>): Promise<unknown[]>
  findUnique(args?: Record<string, unknown>): Promise<unknown>
  findFirst(args?: Record<string, unknown>): Promise<unknown>
  create(args?: Record<string, unknown>): Promise<unknown>
  update(args?: Record<string, unknown>): Promise<unknown>
  updateMany(args?: Record<string, unknown>): Promise<{ count: number }>
  delete(args?: Record<string, unknown>): Promise<unknown>
  deleteMany(args?: Record<string, unknown>): Promise<{ count: number }>
  count(args?: Record<string, unknown>): Promise<number>
  groupBy(args?: Record<string, unknown>): Promise<unknown[]>
  aggregate(args?: Record<string, unknown>): Promise<unknown>
  upsert(args?: Record<string, unknown>): Promise<unknown>
}

export function createNodeSqliteClient(dbFile: string): Record<string, unknown> {
  const backend = loadBackend(dbFile)

  const rawAll = (sql: string, params: unknown[] = []): Promise<unknown[]> => {
    if (process.env.DB_DEBUG) console.error('[db-debug] SQL:', sql, 'PARAMS:', JSON.stringify(params))
    return Promise.resolve(backend.all(sql, params.map((p) => (p === undefined ? null : p))))
  }
  const rawRun = (sql: string, params: unknown[] = []): Promise<{ changes: number }> =>
    Promise.resolve(backend.run(sql, params.map((p) => (p === undefined ? null : p))))

  /**
   * cursor 游标条件：返回「严格排在 cursor 之后」的 SQL（复用 orderBy 的多键方向）。
   * Prisma 语义中 skip 会把 cursor 行本身计入（文档模式 cursor+skip:1 = 从下一行开始），
   * 因此 offset 由调用方做 (skip - (cursor?1:0)) 修正，这里只负责排除 cursor 行。
   */
  async function buildCursorWhere(
    table: string,
    specs: OrderSpec[],
    cursor: Record<string, unknown> | undefined,
    params: unknown[],
  ): Promise<string> {
    if (!cursor || specs.length === 0) return ''
    const keys = Object.keys(cursor)
    if (keys.length === 0) return ''
    // 1) 取 cursor 行的排序字段值
    const curParams: unknown[] = []
    const curWhere = buildWhere(table, cursor as WhereInput, curParams)
    const curRows = (await rawAll(`SELECT * FROM "${table}" WHERE ${curWhere} LIMIT 1`, curParams)) as Array<Record<string, unknown>>
    const row = curRows[0]
    // cursor 行不存在（如已被删除）：宽松处理为无 cursor，避免翻页接口硬报错
    if (!row) return ''
    // 2) 逐前缀展开比较：(f1 op1 c1) OR (f1 = c1 AND f2 op2 c2) ...
    const parts: string[] = []
    const local: unknown[] = []
    for (let i = 0; i < specs.length; i++) {
      const { field, dir } = specs[i]
      const op = dir === 'desc' ? '<' : '>'
      const conj: string[] = []
      for (let j = 0; j < i; j++) {
        local.push(toSql(table, specs[j].field, row[specs[j].field]))
        conj.push(`${quoteCol(specs[j].field)} = ?`)
      }
      local.push(toSql(table, field, row[field]))
      conj.push(`${quoteCol(field)} ${op} ?`)
      parts.push(`(${conj.join(' AND ')})`)
    }
    params.push(...local)
    return `(${parts.join(' OR ')})`
  }

  /** select 投影：只保留值为真值的标量字段（关联键走 attachRelations 装配） */
function project(row: Record<string, unknown>, select?: Record<string, unknown>): Record<string, unknown> {
  if (!select) return row
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(select)) {
    if (v) out[k] = row[k]
  }
  return out
}

/** include 关联装配（多对一）：按外键批量取关联行，避免 N+1 */
  async function attachRelations(
    table: string,
    rows: Record<string, unknown>[],
    select: Record<string, unknown> | undefined,
    include: Record<string, unknown> | undefined,
  ): Promise<void> {
    const relSpec = RELATIONS[table]
    if (!relSpec || !rows.length) return
    const wanted = new Set<string>()
    if (include) for (const k of Object.keys(include)) if (include[k]) wanted.add(k)
    if (select) for (const [k, v] of Object.entries(select)) if (v && typeof v === 'object') wanted.add(k)
    for (const key of wanted) {
      const rel = relSpec[key]
      if (!rel) throw new Error(`表 ${table} 不存在关联 ${key}`)
      const ids = [...new Set(rows.map((r) => r[rel.field]).filter((v) => v !== null && v !== undefined))]
      const related = new Map<string, Record<string, unknown>>()
      if (ids.length > 0) {
        const nested = (include?.[key] ?? select?.[key]) as Record<string, unknown> | true | undefined
        const nestedSelect = nested && typeof nested === 'object' ? (nested.select as Record<string, unknown>) : undefined
        const ph = ids.map(() => '?').join(', ')
        const raw = (await rawAll(`SELECT * FROM "${rel.table}" WHERE "id" IN (${ph})`, ids)) as Array<Record<string, unknown>>
        for (const r of raw) related.set(String(r.id), project(fromRow(rel.table, r), nestedSelect))
      }
      for (const r of rows) {
        const fk = r[rel.field]
        r[key] = fk === null || fk === undefined ? null : related.get(String(fk)) ?? null
      }
    }
  }

  /** 行获取统一出口：fromRow 类型还原 + select 投影 + include 装配 */
  const selectRows = async (
    table: string,
    sql: string,
    params: unknown[],
    select?: Record<string, unknown>,
    include?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const rows = (await rawAll(sql, params)) as Array<Record<string, unknown>>
    const mapped = rows.map((r) => project(fromRow(table, r), select))
    await attachRelations(table, mapped, select, include)
    return mapped
  }

  const delegates: Record<string, unknown> = {}
  for (const table of Object.keys(TABLES)) {
    const d: TableDelegate = {
      findMany: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const specs = normalizeOrderBy(table, args.orderBy)
        const cursorSql = await buildCursorWhere(table, specs, args.cursor as Record<string, unknown>, params)
        const fullWhere = cursorSql ? `(${where}) AND ${cursorSql}` : where
        let sql = `SELECT * FROM "${table}" WHERE ${fullWhere}${buildOrderBySql(specs)}`
        const take = args.take as number | undefined
        const skip = (args.skip as number | undefined) ?? 0
        const offset = args.cursor ? Math.max(0, skip - 1) : skip
        const limits: string[] = []
        if (take !== undefined) limits.push(`LIMIT ${Number(take)}`)
        if (offset > 0) limits.push(`OFFSET ${Number(offset)}`)
        if (limits.length) sql += ' ' + limits.join(' ')
        return selectRows(table, sql, params, args.select as Record<string, unknown>, args.include as Record<string, unknown>)
      },

      findUnique: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const rows = await selectRows(table, `SELECT * FROM "${table}" WHERE ${where} LIMIT 1`, params, args.select as Record<string, unknown>, args.include as Record<string, unknown>)
        return rows[0] ?? null
      },

      findFirst: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const specs = normalizeOrderBy(table, args.orderBy)
        let sql = `SELECT * FROM "${table}" WHERE ${where}${buildOrderBySql(specs)} LIMIT 1`
        const skip = (args.skip as number | undefined) ?? 0
        if (skip > 0) sql += ` OFFSET ${Number(skip)}`
        const rows = await selectRows(table, sql, params, args.select as Record<string, unknown>, args.include as Record<string, unknown>)
        return rows[0] ?? null
      },

      create: async (args: Record<string, unknown> = {}) => {
        const data = { ...(args.data as Record<string, unknown>) }
        const cols = mustTable(table)
        if (cols.id && data.id === undefined) data.id = genId()
        if (cols.createdAt && data.createdAt === undefined) data.createdAt = new Date()
        if (cols.updatedAt && data.updatedAt === undefined) data.updatedAt = new Date()
        const fields = Object.keys(data).filter((f) => data[f] !== undefined)
        const ph = fields.map(() => '?').join(', ')
        const params = fields.map((f) => toSql(table, f, data[f]))
        await rawRun(`INSERT INTO "${table}" (${fields.map(quoteCol).join(', ')}) VALUES (${ph})`, params)
        const rows = await selectRows(table, `SELECT * FROM "${table}" WHERE "id" = ?`, [data.id])
        return rows[0]
      },

      update: async (args: Record<string, unknown> = {}) => {
        const whereParams: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, whereParams)
        const data = (args.data as Record<string, unknown>) ?? {}
        const sets: string[] = []
        const setParams: unknown[] = []
        for (const [f, v] of Object.entries(data)) {
          if (v === undefined) continue
          mustField(table, f)
          sets.push(`${quoteCol(f)} = ?`)
          setParams.push(toSql(table, f, v))
        }
        if (HAS_UPDATED_AT.has(table)) {
          sets.push('"updatedAt" = ?')
          setParams.push(Date.now())
        }
        if (sets.length === 0) throw new Error('update 的 data 不能为空')
        const existing = (await rawAll(`SELECT "id" FROM "${table}" WHERE ${where} LIMIT 1`, whereParams)) as Array<Record<string, unknown>>
        const target = existing[0] as { id: string } | undefined
        if (!target) throw new Error(`P2025: Record to update not found（表 ${table}）`)
        await rawRun(`UPDATE "${table}" SET ${sets.join(', ')} WHERE ${where}`, [...setParams, ...whereParams])
        const rows = await selectRows(table, `SELECT * FROM "${table}" WHERE "id" = ?`, [target.id], args.select as Record<string, unknown>)
        return rows[0]
      },

      updateMany: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const data = (args.data as Record<string, unknown>) ?? {}
        const sets: string[] = []
        const setParams: unknown[] = []
        for (const [f, v] of Object.entries(data)) {
          if (v === undefined) continue
          mustField(table, f)
          sets.push(`${quoteCol(f)} = ?`)
          setParams.push(toSql(table, f, v))
        }
        if (HAS_UPDATED_AT.has(table)) {
          sets.push('"updatedAt" = ?')
          setParams.push(Date.now())
        }
        if (sets.length === 0) throw new Error('updateMany 的 data 不能为空')
        const r = await rawRun(`UPDATE "${table}" SET ${sets.join(', ')} WHERE ${where}`, [...setParams, ...params])
        return { count: r.changes }
      },

      delete: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const rows = await selectRows(table, `SELECT * FROM "${table}" WHERE ${where} LIMIT 1`, params)
        const target = rows[0]
        if (!target) throw new Error(`P2025: Record to delete not found（表 ${table}）`)
        await rawRun(`DELETE FROM "${table}" WHERE "id" = ?`, [target.id])
        return target
      },

      deleteMany: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const r = await rawRun(`DELETE FROM "${table}" WHERE ${where}`, params)
        return { count: r.changes }
      },

      count: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const rows = (await rawAll(`SELECT COUNT(*) AS "c" FROM "${table}" WHERE ${where}`, params)) as Array<Record<string, unknown>>
        return Number(rows[0].c)
      },

      groupBy: async (args: Record<string, unknown> = {}) => {
        const by = args.by as string[]
        if (!Array.isArray(by) || by.length === 0) throw new Error('groupBy 需要非空 by 数组')
        for (const f of by) mustField(table, f)
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const agg = compileAggregates(args)
        let sql = `SELECT ${by.map(quoteCol).join(', ')}${agg.selectFrag} FROM "${table}" WHERE ${where} GROUP BY ${by.map(quoteCol).join(', ')}`
        sql += buildOrderBySql(normalizeOrderBy(table, args.orderBy))
        const take = args.take as number | undefined
        if (take !== undefined) sql += ` LIMIT ${Number(take)}`
        const rows = (await rawAll(sql, params)) as Array<Record<string, unknown>>
        return rows.map((r) => {
          const shaped = agg.shape(r)
          const out: Record<string, unknown> = {}
          for (const f of by) {
            const type = mustField(table, f)
            const v = r[f]
            if (type === T_BOOL) out[f] = v === null ? null : v === 1 || v === true
            else if (type === T_DATE) out[f] = v === null ? null : new Date(Number(v))
            else out[f] = v
          }
          return { ...out, ...shaped }
        })
      },

      aggregate: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const agg = compileAggregates(args)
        const rows = (await rawAll(`SELECT 1${agg.selectFrag} FROM "${table}" WHERE ${where}`, params)) as Array<Record<string, unknown>>
        return agg.shape(rows[0] ?? {})
      },

      upsert: async (args: Record<string, unknown> = {}) => {
        const params: unknown[] = []
        const where = buildWhere(table, args.where as WhereInput, params)
        const existing = (await rawAll(`SELECT "id" FROM "${table}" WHERE ${where} LIMIT 1`, params)) as Array<Record<string, unknown>>
        if (existing[0]) {
          return d.update({ where: args.where, data: args.update, select: args.select })
        }
        return d.create({ data: args.create, select: args.select })
      },
    }
    // Prisma 语义：model Channel → db.channel（小驼峰），表名 → 委托键名转换
    delegates[table[0].toLowerCase() + table.slice(1)] = d
  }

  return {
    ...delegates,

    $queryRawUnsafe: (sql: string, ...params: unknown[]) => rawAll(sql, params),

    $executeRawUnsafe: (sql: string, ...params: unknown[]) => rawRun(sql, params).then((r) => r.changes),

    $disconnect: () => {
      backend.close()
      return Promise.resolve()
    },
  }
}
