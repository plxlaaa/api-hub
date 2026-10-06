import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeStrategy, orderCandidates, type Candidate } from '@/lib/route-order'
import { resolveRequestId, jsonBadRequest } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

// 策略排序预览：与网关转发共用 orderCandidates，保证"预览即实际行为"
// 入参：{ strategy, channelConfigs: [{id, model?, weight?, quality?}] }
export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const requestId = resolveRequestId(req)
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.channelConfigs) || body.channelConfigs.length === 0) {
    return jsonBadRequest('channelConfigs 不能为空', requestId)
  }
  const strategy = normalizeStrategy(body.strategy)
  const ids = (body.channelConfigs as Array<{ id?: unknown }>).map((c) => String(c.id)).filter(Boolean)
  const channels = await db.channel.findMany({ where: { id: { in: ids }, enabled: true, autoDisabled: false } })
  const byId = new Map(channels.map((c) => [c.id, c]))
  const candidates: Candidate[] = (body.channelConfigs as Array<{ id: string }>)
    .map((c) => ({ cfg: c, ch: byId.get(c.id) }))
    .filter((x): x is Candidate => Boolean(x.ch))

  // 已停用/熔断的渠道也要在预览中提示（它们在真实转发中会被跳过）
  const allById = await db.channel.findMany({ where: { id: { in: ids } } })
  const unavailable = allById
    .filter((c) => !c.enabled || c.autoDisabled)
    .map((c) => ({ id: c.id, name: c.name, reason: c.autoDisabled ? '熔断中' : '已停用' }))

  const { ordered, basis } = await orderCandidates(candidates, strategy)
  return Response.json({
    ordered: ordered.map((x) => ({
      id: x.ch.id,
      name: x.ch.name,
      status: x.ch.status,
      latencyMs: x.ch.latencyMs,
      model: x.cfg.model?.trim() || null,
      basis: basis.get(x.ch.id) || '',
    })),
    unavailable,
  }, { headers: { 'X-Request-Id': requestId } })
}
