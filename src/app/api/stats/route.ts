import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk, jsonError } from '@/lib/api-response'
import { log } from '@/lib/logger'
import { startOfDay, bucketByDay, bucketByHour, aggregateByChannel, topModels } from '@/lib/log-stats'

export const dynamic = 'force-dynamic'

/**
 * GET /api/stats —— 仪表盘统计
 *
 * 性能：原先为「近 7 日趋势」逐日循环，每天 3 次 count/aggregate = 21 次查询。
 * SQLite 单写者模型下这些串行查询会和网关转发、探测写日志抢写锁，
 * 而仪表盘每 8 秒轮询一次，开销可观。
 *
 * 现改为两条查询拿全量：
 *   1) 近 7 天窗口的 groupBy（求总量）
 *   2) 同窗口的明细（只 select 参与统计的字段）
 * 日趋势 / 24 小时柱状 / 渠道用量 / 模型 Top 全部在内存分桶（见 lib/log-stats.ts，纯函数可单测）。
 * 查询数 21 → 2。
 *
 * 口径说明：total/today 取自同一 7 天窗口，与趋势图同源，
 * 避免出现「卡片数字与图表对不上」的历史问题。
 */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied

  const now = new Date()
  const todayStart = startOfDay(now)
  const windowStart = new Date(todayStart.getTime() - 6 * 24 * 3600_000)
  const last24hMs = now.getTime() - 24 * 3600_000

  try {
    const [totalAgg, recent] = await Promise.all([
      db.requestLog.groupBy({
        by: ['ok'],
        _count: { _all: true },
        where: { createdAt: { gte: windowStart } },
      }),
      db.requestLog.findMany({
        where: { createdAt: { gte: windowStart } },
        select: {
          ok: true,
          model: true,
          createdAt: true,
          channelName: true,
          latencyMs: true,
          totalTokens: true,
        },
      }),
    ])

    let totalCalls = 0
    let totalFails = 0
    for (const g of totalAgg) {
      totalCalls += g._count._all
      if (!g.ok) totalFails += g._count._all
    }

    let todayCalls = 0
    let todayFails = 0
    const last24h: typeof recent = []
    for (const s of recent) {
      if (s.createdAt >= todayStart) {
        todayCalls++
        if (!s.ok) todayFails++
      }
      if (s.createdAt.getTime() >= last24hMs) last24h.push(s)
    }

    const daily = bucketByDay(recent, now, 7)
    const hourly = bucketByHour(last24h, now, 24)

    return jsonOk(
      {
        total: { calls: totalCalls, fails: totalFails },
        today: { calls: todayCalls, fails: todayFails },
        hourly,
        daily7: daily.map(({ date, calls, fails, tokens }) => ({ date, calls, fails, tokens })),
        topModels: topModels(last24h, 8),
        channelUsage: aggregateByChannel(last24h),
      },
      { requestId }
    )
  } catch (err) {
    log.error('统计查询失败', { requestId, error: err })
    return jsonError(500, '查询统计数据失败', requestId)
  }
}