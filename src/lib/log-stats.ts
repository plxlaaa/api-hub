/**
 * 调用日志的时序聚合（纯函数，零IO，可直接单测）。
 *
 * 背景：/api/stats 原来为「近 7 日趋势」逐日循环，每天发 3 次 count/aggregate，
 * 合计 21 次查询打到 SQLite。SQLite 是单写者模型，这类查询串还会和网关转发、
 * 探测写日志抢锁，仪表盘刷新越频繁越拖慢整个服务。
 *
 * 现改为：一次 groupBy 取回窗口内所有日志的 (ok, createdAt, totalTokens)，
 * 在内存里分桶。查询数从 21 降到 1，仪表盘轮询的数据库压力下降一个数量级。
 */

/** 仪表盘需要的最小日志字段 */
export interface LogSample {
  ok: boolean
  createdAt: Date
  totalTokens: number | null
}

export interface DailyBucket {
  /** 形如 "10/7" */
  date: string
  /** 该日的起始时刻（本地时区，已归零到0:00） */
  start: Date
  calls: number
  fails: number
  tokens: number
}

export interface HourBucket {
  /** 形如 "09:00" */
  hour: string
  calls: number
  fails: number
}

export interface ChannelUsage {
  calls: number
  fails: number
  avgLatencyMs: number | null
}

/** 把时刻归零到本地当天 0:00（统计口径与「今日」调用保持一致） */
export function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

/**
 * 近 N 天按天分桶（含今天，按时间升序）。
 * 用 startOfDay 的毫秒值做 key，避免「同一天不同 Date 对象」导致 Map 命中失败。
 */
export function bucketByDay(samples: LogSample[], now: Date, days: number): DailyBucket[] {
  const todayStart = startOfDay(now).getTime()
  const DAY_MS = 24 * 3600_000
  const buckets: DailyBucket[] = []
  const byKey = new Map<number, DailyBucket>()

  for (let i = days - 1; i >= 0; i--) {
    const startMs = todayStart - i * DAY_MS
    const d = new Date(startMs)
    const bucket: DailyBucket = {
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      start: new Date(startMs),
      calls: 0,
      fails: 0,
      tokens: 0,
    }
    buckets.push(bucket)
    byKey.set(startMs, bucket)
  }

  // 只处理窗口内的样本（首个桶往前一天为界，容纳时区/夏令时造成的 1 天漂移）
  const lowerBound = (buckets[0]?.start.getTime() ?? todayStart) - DAY_MS
  for (const s of samples) {
    const t = s.createdAt instanceof Date ? s.createdAt.getTime() : new Date(s.createdAt).getTime()
    if (!Number.isFinite(t) || t < lowerBound) continue
    const bucket = byKey.get(startOfDay(new Date(t)).getTime())
    if (!bucket) continue
    bucket.calls++
    if (!s.ok) bucket.fails++
    bucket.tokens += s.totalTokens ?? 0
  }
  return buckets
}

/**
 * 近 24 小时按小时分桶（升序，固定 24 个桶）。
 * 跨小时/跨天的样本按其所在的本地小时归位，与仪表盘柱状图口径一致。
 */
export function bucketByHour(samples: LogSample[], now: Date, hours = 24): HourBucket[] {
  const buckets: HourBucket[] = []
  const byKey = new Map<string, HourBucket>()
  const nowMs = now.getTime()
  const HOUR_MS = 3600_000

  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(nowMs - i * HOUR_MS)
    const bucket: HourBucket = {
      hour: `${String(d.getHours()).padStart(2, '0')}:00`,
      calls: 0,
      fails: 0,
    }
    buckets.push(bucket)
    // key 含日期+小时：跨天时同名小时不会互相覆盖
    byKey.set(`${d.getFullYear()}-${d.getMonth()}-${d.getHours()}`, bucket)
  }

  const lowerBound = nowMs - hours * HOUR_MS
  for (const s of samples) {
    const t = s.createdAt instanceof Date ? s.createdAt.getTime() : new Date(s.createdAt).getTime()
    if (!Number.isFinite(t) || t < lowerBound) continue
    const d = new Date(t)
    const bucket = byKey.get(`${d.getFullYear()}-${d.getMonth()}-${d.getHours()}`)
    if (!bucket) continue
    bucket.calls++
    if (!s.ok) bucket.fails++
  }
  return buckets
}

/**
 * 渠道维度用量聚合。
 *
 * avgLatencyMs 只统计「成功且有延迟样本」的请求：
 * - 失败请求的延迟没有参考意义（网关超时上限 300s，一次超时就能把均值拉飞）
 * - 与 /api/channels 的横评统计口径保持一致，否则同一页两处数字会打架
 * 用「延迟求和 / 样本数」而不是「各组均值再平均」——后者在分组大小差异大时会明显偏移。
 */
export function aggregateByChannel(
  samples: Array<{ ok: boolean; channelName: string | null; latencyMs: number | null }>
): Record<string, ChannelUsage> {
  const acc = new Map<string, { calls: number; fails: number; latSum: number; latN: number }>()
  for (const s of samples) {
    const name = s.channelName || '（未知）'
    const u = acc.get(name) || { calls: 0, fails: 0, latSum: 0, latN: 0 }
    u.calls++
    if (!s.ok) u.fails++
    if (s.ok && typeof s.latencyMs === 'number' && Number.isFinite(s.latencyMs)) {
      u.latSum += s.latencyMs
      u.latN++
    }
    acc.set(name, u)
  }
  const out: Record<string, ChannelUsage> = {}
  for (const [name, u] of acc) {
    out[name] = {
      calls: u.calls,
      fails: u.fails,
      avgLatencyMs: u.latN > 0 ? Math.round(u.latSum / u.latN) : null,
    }
  }
  return out
}

/** 近 24h 模型调用分布 Top N（并列时按模型名排序，保证输出稳定） */
export function topModels(samples: Array<{ model: string }>, limit = 8): Array<{ model: string; calls: number }> {
  const counts = new Map<string, number>()
  for (const s of samples) counts.set(s.model, (counts.get(s.model) || 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([model, calls]) => ({ model, calls }))
}