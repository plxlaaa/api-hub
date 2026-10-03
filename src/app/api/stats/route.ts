import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

interface HourBucket {
  hour: string
  calls: number
  fails: number
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start24h = new Date(now.getTime() - 24 * 3600_000)

  const [totalCalls, totalFails, todayCalls, todayFails, recent] = await Promise.all([
    db.requestLog.count(),
    db.requestLog.count({ where: { ok: false } }),
    db.requestLog.count({ where: { createdAt: { gte: startOfToday } } }),
    db.requestLog.count({ where: { ok: false, createdAt: { gte: startOfToday } } }),
    db.requestLog.findMany({
      where: { createdAt: { gte: start24h } },
      select: { ok: true, model: true, createdAt: true, channelName: true, latencyMs: true },
    }),
  ])

  // 近 7 日按天聚合（调用/失败/Token）——仪表盘周趋势图
  const daily: Array<{ date: string; calls: number; fails: number; tokens: number }> = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600_000)
    d.setHours(0, 0, 0, 0)
    const next = new Date(d.getTime() + 24 * 3600_000)
    const [calls, fails, tokens] = await Promise.all([
      db.requestLog.count({ where: { createdAt: { gte: d, lt: next } } }),
      db.requestLog.count({ where: { ok: false, createdAt: { gte: d, lt: next } } }),
      db.requestLog.aggregate({ where: { createdAt: { gte: d, lt: next } }, _sum: { totalTokens: true } }),
    ])
    daily.push({ date: `${d.getMonth() + 1}/${d.getDate()}`, calls, fails, tokens: tokens._sum.totalTokens ?? 0 })
  }

  // 近 24 小时按小时分桶
  const buckets: HourBucket[] = []
  const map = new Map<string, HourBucket>()
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600_000)
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getHours()}`
    const bucket = { hour: `${String(d.getHours()).padStart(2, '0')}:00`, calls: 0, fails: 0 }
    buckets.push(bucket)
    map.set(key, bucket)
  }
  for (const log of recent) {
    const d = log.createdAt
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getHours()}`
    const bucket = map.get(key)
    if (bucket) {
      bucket.calls++
      if (!log.ok) bucket.fails++
    }
  }

  // 近 24h 模型调用分布（Top 8）
  const byModel = new Map<string, number>()
  for (const log of recent) byModel.set(log.model, (byModel.get(log.model) || 0) + 1)
  const topModels = [...byModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([model, calls]) => ({ model, calls }))

  return Response.json({
    total: { calls: totalCalls, fails: totalFails },
    today: { calls: todayCalls, fails: todayFails },
    hourly: buckets,
    daily7: daily,
    topModels,
    channelUsage: buildChannelUsage(recent),
  })
}

/** 近 24h 渠道维度用量（调用/失败/平均延迟）——仪表盘渠道卡展示 */
function buildChannelUsage(
  recent: Array<{ ok: boolean; createdAt: Date; latencyMs: number | null; channelName: string | null }>,
): Record<string, { calls: number; fails: number; avgLatencyMs: number | null }> {
  const acc = new Map<string, { calls: number; fails: number; latSum: number; latN: number }>()
  for (const log of recent) {
    const name = log.channelName || '（未知）'
    const u = acc.get(name) || { calls: 0, fails: 0, latSum: 0, latN: 0 }
    u.calls++
    if (!log.ok) u.fails++
    if (typeof log.latencyMs === 'number') { u.latSum += log.latencyMs; u.latN++ }
    acc.set(name, u)
  }
  const out: Record<string, { calls: number; fails: number; avgLatencyMs: number | null }> = {}
  for (const [name, u] of acc) {
    out[name] = { calls: u.calls, fails: u.fails, avgLatencyMs: u.latN > 0 ? Math.round(u.latSum / u.latN) : null }
  }
  return out
}
