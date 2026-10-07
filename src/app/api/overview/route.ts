import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseApiFormat } from '@/lib/adapters'
import { resolveRequestId, jsonOk } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

/**
 * 一站式汇总（CLI / 仪表盘用）：
 * 渠道状态统计 + 今日/累计调用 + 密钥配额 + 各路由配置
 */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied

  const [channels, routes, tokens, todayAgg, totalAgg, byChannel] = await Promise.all([
    db.channel.findMany({
      orderBy: { createdAt: 'asc' },
      select: { name: true, enabled: true, autoDisabled: true, status: true, latencyMs: true, apiFormat: true, failStreak: true, lastError: true },
    }),
    db.modelRoute.findMany({
      orderBy: { createdAt: 'asc' },
      select: { displayName: true, targetModel: true, enabled: true, channelConfigs: true },
    }),
    db.apiToken.findMany({
      orderBy: { createdAt: 'asc' },
      select: { name: true, enabled: true, quotaLimit: true, quotaUsed: true, lastUsedAt: true },
    }),
    db.requestLog.groupBy({
      by: ['ok'],
      where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      _count: { _all: true },
    }),
    db.requestLog.aggregate({ _count: { _all: true } }),
    // 渠道维度今日用量（调用数/失败数/平均延迟）
    //延迟用 _sum 而非 _avg：groupBy 会按 (channelName, ok) 拆成多组，
    // 各组 _avg 再平均 = 「组均值的均值」，组大小差异大时明显偏移。
    // 记_sum + 计数，内存里做真正的加权平均。
    db.requestLog.groupBy({
      by: ['channelName', 'ok'],
      where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      _count: { _all: true },
      _sum: { latencyMs: true },
    }),
  ])

  const todayCalls = todayAgg.reduce((s, g) => s + g._count._all, 0)
  const todayFails = todayAgg.filter((g) => !g.ok).reduce((s, g) => s + g._count._all, 0)
  // 累加器带延迟求和与样本数，用于内存加权平均
  const acc = new Map<string, { calls: number; fails: number; latSum: number; latN: number }>()
  for (const g of byChannel) {
    const name = g.channelName || '（未知）'
    const u = acc.get(name) ?? { calls: 0, fails: 0, latSum: 0, latN: 0 }
    u.calls += g._count._all
    if (!g.ok) u.fails += g._count._all
    // 与 /api/channels、/api/stats 口径统一：仅成功请求计入延迟均值
    // （失败请求延迟无参考意义，网关超时上限 300s，单次超时即可把均值拉飞）
    if (g.ok && g._sum.latencyMs != null) {
      u.latSum += g._sum.latencyMs
      u.latN += g._count._all
    }
    acc.set(name, u)
  }
  const channelUsage: Record<string, { calls: number; fails: number; avgLatencyMs: number | null }> = {}
  for (const [name, u] of acc) {
    channelUsage[name] = {
      calls: u.calls,
      fails: u.fails,
      avgLatencyMs: u.latN > 0 ? Math.round(u.latSum / u.latN) : null,
    }
  }

  return jsonOk({
    channels: channels.map((c) => ({ ...c, apiFormat: parseApiFormat(c.apiFormat) })),
    routes,
    tokens,
    channelUsage,
    stats: {
      today: { calls: todayCalls, fails: todayFails },
      totalCalls: totalAgg._count._all,
      channelsOnline: channels.filter((c) => c.enabled && c.status === 'online').length,
      channelsDown: channels.filter((c) => c.enabled && (c.status === 'offline' || c.autoDisabled)).length,
    },
    generatedAt: new Date().toISOString(),
  }, { requestId })
}
