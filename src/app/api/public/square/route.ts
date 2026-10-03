import { db } from '@/lib/db'
import { parseChannelConfigs } from '@/lib/route-config'

export const dynamic = 'force-dynamic'

/** 模型广场公开数据：无鉴权；只返回脱敏信息（不含 baseUrl/apiKey） */
export async function GET() {
  const [routes, channels] = await Promise.all([
    db.modelRoute.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } }),
    db.channel.findMany({ select: { id: true, name: true, enabled: true, status: true, latencyMs: true, lastCheckAt: true } }),
  ])
  const byId = new Map(channels.map((c) => [c.id, c]))

  const models = routes.map((r) => {
    const cfgs = parseChannelConfigs(r)
    const chs = cfgs.map((c) => byId.get(c.id)).filter((c): c is NonNullable<typeof c> => Boolean(c) && c!.enabled)
    const online = chs.filter((c) => c.status === 'online')
    return {
      name: r.displayName,
      description: r.remark,
      priceIn: r.priceIn,
      priceOut: r.priceOut,
      strategy: r.strategy,
      channels: chs.map((c) => ({
        name: c.name,
        status: c.status,
        latencyMs: c.latencyMs,
        lastCheckAt: c.lastCheckAt,
      })),
      onlineCount: online.length,
      channelCount: chs.length,
      updatedAt: r.updatedAt,
    }
  })

  const visibleChannels = channels.filter((c) => c.enabled)
  return Response.json({
    models,
    stats: {
      modelCount: models.length,
      channelTotal: visibleChannels.length,
      channelOnline: visibleChannels.filter((c) => c.status === 'online').length,
    },
    generatedAt: new Date().toISOString(),
  })
}
