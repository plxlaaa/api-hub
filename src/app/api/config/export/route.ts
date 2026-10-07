import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseChannelConfigs } from '@/lib/route-config'
import { parseApiFormat } from '@/lib/adapters'
import { parseStringArray } from '@/lib/json-field'
import { resolveRequestId, jsonOk } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

/**
 * 配置备份：导出渠道 + 路由为 JSON 文件。
 * - 渠道引用在导出时统一转为「渠道名」（导入时按名重建 id 关联，跨环境可用）
 * - apiKey 可选包含（默认脱敏不导出，带 keys=1 才写入——备份文件含敏感信息请妥善保管）
 * - 往返无损：percent / activeHours / metadata 等字段必须一并导出，
 *   否则「导出→导入」会把用户精心配置的百分比分流与时段窗口悄悄抹掉
 */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const url = new URL(req.url)
  const withKeys = url.searchParams.get('keys') === '1'

  const [channels, routes] = await Promise.all([
    db.channel.findMany({ orderBy: { createdAt: 'asc' } }),
    db.modelRoute.findMany({ orderBy: { createdAt: 'asc' } }),
  ])

  const idToName = new Map(channels.map((c) => [c.id, c.name]))
  return jsonOk(
    {
      kind: 'api-hub-config',
      version: 1,
      exportedAt: new Date().toISOString(),
      withKeys,
      channels: channels.map((c) => ({
        name: c.name,
        baseUrl: c.baseUrl,
        // 用 parseApiFormat 而非手写三元：手写会把 gemini 错标成 openai，
        // 导致「导出→导入」往返后 Gemini 渠道协议丢失
        apiFormat: parseApiFormat(c.apiFormat),
        models: parseStringArray(c.models),
        enabled: c.enabled,
        remark: c.remark,
        metadata: c.metadata ?? null,
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
        metadata: r.metadata ?? null,
        // 渠道级配置：id 转渠道名（已删除的渠道保留原名，导入时按名匹配不到会跳过该渠道项）
        // percent / activeHours 必须导出：漏了会让百分比分流与时段窗口在往返后静默失效
        channelConfigs: parseChannelConfigs(r).map((cfg) => ({
          name: idToName.get(cfg.id) || cfg.id,
          model: cfg.model || '',
          weight: cfg.weight ?? 1,
          quality: cfg.quality ?? 5,
          percent: cfg.percent ?? 100,
          activeHours: cfg.activeHours || '',
        })),
      })),
    },
    {
      requestId,
      headers: {
        'Content-Disposition': `attachment; filename="api-hub-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    }
  )
}
