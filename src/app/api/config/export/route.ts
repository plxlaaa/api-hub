import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseChannelConfigs } from '@/lib/route-config'

export const dynamic = 'force-dynamic'

/**
 * 配置备份：导出渠道 + 路由为 JSON 文件。
 * - 渠道引用在导出时统一转为「渠道名」（导入时按名重建 id 关联，跨环境可用）
 * - apiKey 可选包含（默认脱敏不导出，带 keys=1 才写入——备份文件含敏感信息请妥善保管）
 */
export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const url = new URL(req.url)
  const withKeys = url.searchParams.get('keys') === '1'

  const [channels, routes] = await Promise.all([
    db.channel.findMany({ orderBy: { createdAt: 'asc' } }),
    db.modelRoute.findMany({ orderBy: { createdAt: 'asc' } }),
  ])

  const idToName = new Map(channels.map((c) => [c.id, c.name]))
  return Response.json(
    {
      kind: 'api-hub-config',
      version: 1,
      exportedAt: new Date().toISOString(),
      withKeys,
      channels: channels.map((c) => ({
        name: c.name,
        baseUrl: c.baseUrl,
        apiFormat: c.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
        models: JSON.parse(c.models || '[]'),
        enabled: c.enabled,
        remark: c.remark,
        apiKey: withKeys ? c.apiKey : '',
      })),
      routes: routes.map((r) => ({
        displayName: r.displayName,
        targetModel: r.targetModel,
        strategy: r.strategy,
        priceIn: r.priceIn,
        priceOut: r.priceOut,
        remark: r.remark,
        enabled: r.enabled,
        // 渠道级配置：id 转渠道名（已删除的渠道保留原名，导入时按名匹配不到会跳过该渠道项）
        channelConfigs: parseChannelConfigs(r).map((cfg) => ({
          name: idToName.get(cfg.id) || cfg.id,
          model: cfg.model || '',
          weight: cfg.weight ?? 1,
          quality: cfg.quality ?? 5,
        })),
      })),
    },
    {
      headers: {
        'Content-Disposition': `attachment; filename="api-hub-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    }
  )
}
