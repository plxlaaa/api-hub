/**
 * 进程内滑动窗口限流（内存实现，零依赖）。
 *
 * 用途：
 * 1) 管理台登录防爆破（按 IP）
 * 2) 网关统一 Key 限速（按 Key，防止单把 Key 打满上游额度）
 *
 * 设计取舍：状态存在进程内存，多实例部署下每个实例各算各的。
 * 本项目定位是个人单机部署（systemd / 计划任务单实例），够用；
 * 若要水平扩展需把计数迁到 Redis 或 DB。
 */

interface Bucket {
  /** 窗口内的请求时间戳（毫秒） */
  hits: number[]
}

export interface RateLimitOptions {
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 窗口内最大请求数 */
  max: number
}

export interface RateLimitResult {
  ok: boolean
  /** 剩余可用次数 */
  remaining: number
  /** 触发限流时，距最早一次请求过期还需多少毫秒 */
  retryAfterMs: number
}

/** key → 桶；定期清理过期桶，防止内存无限增长 */
const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 10_000

let sweeper: ReturnType<typeof setInterval> | null = null

function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    // 遍历一遍清掉没有未过期命中的桶
    for (const [k, b] of buckets) {
      if (b.hits.length === 0 || now - b.hits[0] > 60 * 60_000) buckets.delete(k)
    }
  }, 5 * 60_000)
  // 不阻止进程退出（Node 定时器默认会保持事件循环存活）
  if (typeof sweeper === 'object' && sweeper && 'unref' in sweeper) {
    ;(sweeper as unknown as { unref: () => void }).unref()
  }
}

/** 取（并按需创建）限流判定；纯查询，不修改计数 */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  const cutoff = now - opts.windowMs
  const b = buckets.get(key)
  if (!b) return { ok: true, remaining: opts.max, retryAfterMs: 0 }

  // 惰性清理：丢弃窗口外的旧记录
  while (b.hits.length > 0 && b.hits[0] <= cutoff) b.hits.shift()

  if (b.hits.length >= opts.max) {
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, b.hits[0] + opts.windowMs - now),
    }
  }
  return { ok: true, remaining: opts.max - b.hits.length, retryAfterMs: 0 }
}

/** 记一次命中并判定是否超限（check + hit 合并，避免两次遍历的竞态） */
export function hitRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  ensureSweeper()
  const now = Date.now()
  const cutoff = now - opts.windowMs
  let b = buckets.get(key)
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) {
      // 简易保护：满了就清空最旧的一批（宁可放宽限流也不至于打满内存）
      const oldest = buckets.keys().next()
      if (!oldest.done) buckets.delete(oldest.value)
    }
    b = { hits: [] }
    buckets.set(key, b)
  }
  while (b.hits.length > 0 && b.hits[0] <= cutoff) b.hits.shift()

  if (b.hits.length >= opts.max) {
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, b.hits[0] + opts.windowMs - now),
    }
  }
  b.hits.push(now)
  return { ok: true, remaining: opts.max - b.hits.length, retryAfterMs: 0 }
}

/** 清除某 key 的计数（登录成功后调用） */
export function resetRateLimit(key: string): void {
  buckets.delete(key)
}