import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeStrategy } from '@/lib/route-order'

export const dynamic = 'force-dynamic'

/** 价格字段：数字（美元/百万 token）或 null */
function normalizePrice(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 1e6) / 1e6
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v) * 1e6) / 1e6
  return null
}

/**
 * 配置恢复：从备份 JSON 导入渠道 + 路由。
 * - 同名渠道/同显示名路由 → 跳过（保留现有配置不覆盖）
 * - 路由的渠道引用按「渠道名」匹配本次导入/已存在的渠道；匹配不到的渠道项自动剔除
 * - apiKey 为空字符串的渠道（脱敏备份）导入后需手动补 Key
 */
export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body || body.kind !== 'api-hub-config' || !Array.isArray(body.channels) || !Array.isArray(body.routes)) {
    return Response.json({ error: '文件格式不正确（需要 api-hub-config 备份文件）' }, { status: 400 })
  }

  const result = { channelsAdded: 0, channelsSkipped: 0, routesAdded: 0, routesSkipped: 0, channelsMissingKey: 0 }

  // 1. 渠道：同名跳过
  const existingChannels = await db.channel.findMany({ select: { id: true, name: true } })
  const nameToId = new Map(existingChannels.map((c) => [c.name, c.id]))
  for (const c of body.channels) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name || !c?.baseUrl) continue
    if (nameToId.has(name)) {
      result.channelsSkipped++
      continue
    }
    const created = await db.channel.create({
      data: {
        name,
        baseUrl: String(c.baseUrl).trim(),
        apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
        apiFormat: c.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
        models: JSON.stringify(Array.isArray(c.models) ? c.models.filter((m: unknown) => typeof m === 'string') : []),
        enabled: c.enabled !== false,
        remark: typeof c.remark === 'string' && c.remark.trim() ? c.remark.trim() : null,
      },
    })
    if (!created.apiKey) result.channelsMissingKey++
    nameToId.set(name, created.id)
    result.channelsAdded++
  }

  // 2. 路由：同显示名跳过；渠道引用按名解析，解析不到的渠道项剔除
  const existingRoutes = await db.modelRoute.findMany({ select: { displayName: true } })
  const routeNames = new Set(existingRoutes.map((r) => r.displayName))
  for (const r of body.routes) {
    const displayName = typeof r?.displayName === 'string' ? r.displayName.trim() : ''
    if (!displayName || !r?.targetModel) continue
    if (routeNames.has(displayName)) {
      result.routesSkipped++
      continue
    }
    const cfgs = (Array.isArray(r.channelConfigs) ? r.channelConfigs : [])
      .map((c: { name?: unknown; model?: unknown; weight?: unknown; quality?: unknown }) => {
        const id = nameToId.get(typeof c.name === 'string' ? c.name : '')
        if (!id) return null
        return {
          id,
          model: typeof c.model === 'string' ? c.model.trim() : '',
          weight: Math.max(0, Math.min(100, Math.round(Number(c.weight) || 0))) || 1,
          quality: Math.max(1, Math.min(10, Math.round(Number(c.quality) || 5))),
        }
      })
      .filter(Boolean)
    if (cfgs.length === 0) continue // 没有任何可用渠道引用的路由跳过
    await db.modelRoute.create({
      data: {
        displayName,
        targetModel: String(r.targetModel).trim(),
        channelIds: JSON.stringify(cfgs.map((c: { id: string }) => c.id)),
        channelConfigs: JSON.stringify(cfgs),
        strategy: normalizeStrategy(r.strategy),
        priceIn: normalizePrice(r.priceIn),
        priceOut: normalizePrice(r.priceOut),
        remark: typeof r.remark === 'string' && r.remark.trim() ? r.remark.trim() : null,
        enabled: r.enabled !== false,
      },
    })
    routeNames.add(displayName)
    result.routesAdded++
  }

  return Response.json(result)
}
