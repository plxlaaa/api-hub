import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeChannelConfigs, normalizeStrategy, parseChannelConfigs } from '@/lib/route-config'
import { parseMetadata } from '@/lib/metadata'
import { parseStringArray } from '@/lib/json-field'
import { resolveRequestId, jsonOk, jsonBadRequest, jsonError } from '@/lib/api-response'
import { invalidateRouteCache } from '@/lib/route-cache'

export const dynamic = 'force-dynamic'

/** 价格字段：数字（美元/百万 token）或 null（未标注） */
function normalizePrice(v: unknown): number | null | undefined {
  if (v === null) return null
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 1e6) / 1e6
  if (typeof v === 'string' && v.trim() === '') return null
  return undefined
}

export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const routes = await db.modelRoute.findMany({ orderBy: { createdAt: 'asc' } })
  // 每条路由的调用统计（按日志的对外模型名聚合；兜底路由透传的模型名各不相同，统计不到则显示 0）
  const names = routes.map((r) => r.displayName)
  const grouped = names.length
    ? await db.requestLog.groupBy({
        by: ['model', 'ok'],
        where: { model: { in: names } },
        _count: { _all: true },
        _max: { createdAt: true },
        _sum: { totalTokens: true },
      })
    : []
  const stats = new Map<string, { total: number; ok: number; tokens: number; lastUsedAt: Date | null }>()
  for (const g of grouped) {
    const s = stats.get(g.model) || { total: 0, ok: 0, tokens: 0, lastUsedAt: null as Date | null }
    s.total += g._count._all
    if (g.ok) s.ok += g._count._all
    s.tokens += g._sum.totalTokens ?? 0
    if (g._max.createdAt && (!s.lastUsedAt || g._max.createdAt > s.lastUsedAt)) s.lastUsedAt = g._max.createdAt
    stats.set(g.model, s)
  }
  return jsonOk(
    routes.map((r) => {
      const s = stats.get(r.displayName) || { total: 0, ok: 0, tokens: 0, lastUsedAt: null as Date | null }
      return {
        id: r.id,
        displayName: r.displayName,
        targetModel: r.targetModel,
        channelIds: parseStringArray(r.channelIds),
        channelConfigs: parseChannelConfigs(r),
        strategy: r.strategy,
        priceIn: r.priceIn,
        priceOut: r.priceOut,
        enabled: r.enabled,
        remark: r.remark,
        metadata: (r.metadata ?? null) as Record<string, string | number | boolean> | null,
        createdAt: r.createdAt,
        stats: { total: s.total, ok: s.ok, tokens: s.tokens, lastUsedAt: s.lastUsedAt },
      }
    }),
    { requestId }
  )
}

export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const requestId = resolveRequestId(req)
  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法', requestId)

  const { displayName, targetModel, channelIds, channelConfigs, remark, enabled, strategy, priceIn, priceOut, metadata } = body as Record<string, unknown>
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return jsonBadRequest('模型显示名必填', requestId)
  }
  if (typeof targetModel !== 'string' || !targetModel.trim()) {
    return jsonBadRequest('上游真实模型名必填', requestId)
  }
  // channelConfigs 优先；兼容旧的 channelIds
  const cfgs = normalizeChannelConfigs(channelConfigs)
    ?? normalizeChannelConfigs((Array.isArray(channelIds) ? channelIds : []).map((id) => ({ id })))
  if (!cfgs) return jsonBadRequest('至少选择一个渠道', requestId)

  const exists = await db.modelRoute.findUnique({ where: { displayName: displayName.trim() } })
  if (exists) return jsonError(409, `模型显示名 "${displayName.trim()}" 已存在`, requestId)

  const m = parseMetadata(metadata)
  const route = await db.modelRoute.create({
    data: {
      displayName: displayName.trim(),
      targetModel: targetModel.trim(),
      channelIds: JSON.stringify(cfgs.map((c) => c.id)),
      channelConfigs: JSON.stringify(cfgs),
      strategy: normalizeStrategy(strategy),
      priceIn: normalizePrice(priceIn) ?? null,
      priceOut: normalizePrice(priceOut) ?? null,
      remark: typeof remark === 'string' ? remark.trim() : null,
      enabled: enabled === false ? false : true,
      ...(m ? { metadata: m } : {}),
    },
  })
  // 网关转发读的是缓存表，新建路由必须立即失效，否则最长5秒内调用会404
  invalidateRouteCache()
  return jsonOk({ id: route.id }, { requestId })
}
