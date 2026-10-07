import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeChannelConfigs, normalizeStrategy } from '@/lib/route-config'
import { resolveRequestId, jsonOk, jsonBadRequest, jsonError } from '@/lib/api-response'
import { invalidateRouteCache } from '@/lib/route-cache'

export const dynamic = 'force-dynamic'

/** 价格字段：数字（美元/百万 token）或 null（未标注）；undefined=不更新 */
function normalizePrice(v: unknown): number | null | undefined {
  if (v === null) return null
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 1e6) / 1e6
  if (typeof v === 'string' && v.trim() === '') return null
  return undefined
}

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const requestId = resolveRequestId(req)
  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法', requestId)

  const route = await db.modelRoute.findUnique({ where: { id } })
  if (!route) return jsonError(404, '路由不存在', requestId)

  const data: Record<string, unknown> = {}
  if (typeof body.displayName === 'string' && body.displayName.trim()) {
    const dup = await db.modelRoute.findFirst({ where: { displayName: body.displayName.trim(), id: { not: id } } })
    if (dup) return jsonError(409, `模型显示名 "${body.displayName.trim()}" 已存在`, requestId)
    data.displayName = body.displayName.trim()
  }
  if (typeof body.targetModel === 'string' && body.targetModel.trim()) data.targetModel = body.targetModel.trim()

  // channelConfigs 优先；兼容只传 channelIds 的旧客户端（如开关按钮）
  const cfgs = normalizeChannelConfigs(body.channelConfigs)
  if (cfgs) {
    data.channelConfigs = JSON.stringify(cfgs)
    data.channelIds = JSON.stringify(cfgs.map((c) => c.id))
  } else if (Array.isArray(body.channelIds) && body.channelIds.length > 0) {
    data.channelIds = JSON.stringify(body.channelIds.map(String))
  }

  if (typeof body.strategy === 'string') data.strategy = normalizeStrategy(body.strategy)
  const priceIn = normalizePrice(body.priceIn)
  if (priceIn !== undefined) data.priceIn = priceIn
  const priceOut = normalizePrice(body.priceOut)
  if (priceOut !== undefined) data.priceOut = priceOut
  if (typeof body.remark === 'string' || body.remark === null) {
    data.remark = typeof body.remark === 'string' ? body.remark.trim() : null
  }
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled

  await db.modelRoute.update({ where: { id }, data })
  invalidateRouteCache()
  return jsonOk({ ok: true }, { requestId })
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const requestId = resolveRequestId(req)
  await db.modelRoute.delete({ where: { id } }).catch(() => null)
  invalidateRouteCache()
  return jsonOk({ ok: true }, { requestId })
}
