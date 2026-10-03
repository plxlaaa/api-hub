import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseApiFormat, isApiFormat } from '@/lib/adapters'

export const dynamic = 'force-dynamic'

/**
 * 一站式汇总（CLI / 仪表盘用）：
 * 渠道状态统计 + 今日/累计调用 + 密钥配额 + 各路由配置
 */
export async function GET(req: Request) {
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
    db.requestLog.groupBy({
      by: ['channelName', 'ok'],
      where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      _count: { _all: true },
      _avg: { latencyMs: true },
    }),
  ])

  const todayCalls = todayAgg.reduce((s, g) => s + g._count._all, 0)
  const todayFails = todayAgg.filter((g) => !g.ok).reduce((s, g) => s + g._count._all, 0)
  const channelUsage: Record<string, { calls: number; fails: number; avgLatencyMs: number | null }> = {}
  for (const g of byChannel) {
    const name = g.channelName || '（未知）'
    const u = (channelUsage[name] ??= { calls: 0, fails: 0, avgLatencyMs: null })
    u.calls += g._count._all
    if (!g.ok) u.fails += g._count._all
    if (g._avg.latencyMs != null) {
      // 加权平均近似：以本次组调用数为权
      const prev = u.avgLatencyMs ?? g._avg.latencyMs
      u.avgLatencyMs = (prev + g._avg.latencyMs) / 2
    }
  }

  return Response.json({
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
  })
}
