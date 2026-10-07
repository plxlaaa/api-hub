/**
 * 启用路由表缓存（网关热路径）。
 *
 * 背景：网关每次转发都要执行
 *   db.modelRoute.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } })
 * 把整张路由表读出来交给 resolveRoute 匹配。SQLite 单写者模型下，
 * 这条查询会和探测写日志、调用日志落库抢锁；而网关是 QPS 最高的路径，
 * 高并发时整表查询的累积开销最明显。
 *
 * 路由表是典型的「读多写少」数据：只有管理端增删改路由（或配置导入）
 * 才会变化，且频率极低（人工操作，几分钟甚至几小时一次）。
 *
 * 失效策略（三重保险，宁可多查一次也不能用脏配置转发）：
 * 1. 主动失效：所有路由写入点（POST/PUT/DELETE /api/routes、配置导入）
 *    同步调用 invalidateRouteCache()，改完立即生效，不等 TTL；
 * 2. 短 TTL 兜底：默认 5s，防止漏掉某个写入点导致配置长期陈旧；
 * 3. 写入即失效优先于 TTL：TTL 只在「确实没人改过」时充当缓存。
 *
 * 刻意不缓存渠道（Channel）查询：渠道的 autoDisabled / latencyMs 由探测调度器
 * 与熔断逻辑高频改动，且熔断摘除必须立刻生效，缓存会导致「渠道已熔断仍被选中」。
 * 渠道查询本身是 id IN (...) 精确匹配，成本远低于整表路由查询。
 */

import type { ModelRoute } from '@prisma/client'
import { log } from './logger.ts'

/** 缓存有效期（毫秒）。取小值：路由变更后最迟 5 秒生效，且有主动失效兜底 */
const DEFAULT_TTL_MS = 5_000

interface CacheEntry {
  at: number
  routes: ModelRoute[]
  /** 正在进行中的加载，避免并发请求同时打 DB（缓存击穿） */
  inflight: Promise<ModelRoute[]> | null
}

let entry: CacheEntry | null = null
let ttlMs = DEFAULT_TTL_MS

/**
 * 读取启用中的路由表（带缓存）。
 *
 * @param loader实际查库函数，测试可注入假实现
 */
async function loadRoutes(loader: () => Promise<ModelRoute[]>): Promise<ModelRoute[]> {
  const now = Date.now()
  if (entry && now - entry.at < ttlMs) return entry.routes

  // 已有加载在进行中：复用同一个 Promise，避免 N 个并发请求同时查库
  if (entry?.inflight) return entry.inflight

  const inflight = loader()
    .then((routes) => {
      entry = { at: Date.now(), routes, inflight: null }
      return routes
    })
    .catch((err) => {
      // 查库失败：清掉 inflight 让下次请求重试，同时把异常抛给调用方
      // （绝不用陈旧数据兜底 —— 配置错了比慢一点严重得多）
      if (entry?.inflight === inflight) entry = null
      throw err
    })

  entry = { at: entry?.at ?? 0, routes: entry?.routes ?? [], inflight }
  return inflight
}

/** 注入式读取（默认走真实 DB）；测试可覆盖为假数据 */
let routeLoader: () => Promise<ModelRoute[]> = async () => {
  const { db } = await import('@/lib/db')
  return db.modelRoute.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } })
}

/** 取启用中的路由表（带缓存）。网关与 /v1/models 共用。 */
export function getEnabledRoutes(): Promise<ModelRoute[]> {
  return loadRoutes(() => routeLoader())
}

/**
 * 主动失效路由缓存。
 * 所有 ModelRoute 写入点（创建/更新/删除/配置导入）完成后必须调用。
 */
export function invalidateRouteCache(): void {
  entry = null
}

/** 仅供测试：替换 loader 并清空缓存 */
export function __setRouteLoaderForTest(fn: (() => Promise<ModelRoute[]>) | null): void {
  routeLoader = fn ?? defaultRouteLoader
  invalidateRouteCache()
}

/** 仅供测试：设置 TTL（毫秒），传0 表示每次都重新查库 */
export function __setRouteCacheTtlForTest(ms: number): void {
  ttlMs = ms
  invalidateRouteCache()
}

async function defaultRouteLoader(): Promise<ModelRoute[]> {
  const { db } = await import('@/lib/db')
  return db.modelRoute.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } })
}
routeLoader = defaultRouteLoader

/** 缓存命中统计（供 /api/health 观测，首次查询时打一条 debug 日志便于确认生效） */
let lastHitLogAt = 0
export function logCacheHitOnce(): void {
  const now = Date.now()
  if (now - lastHitLogAt < 60_000) return
  lastHitLogAt = now
  log.debug('路由缓存可用', { ttlMs })
}