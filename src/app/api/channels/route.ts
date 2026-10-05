import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeBaseUrl } from '@/lib/probe'
import { parseApiFormat } from '@/lib/adapters'
import { parseMetadata } from '@/lib/metadata'
import { parseStringArray } from '@/lib/json-field'
import { checkUpstreamUrl, allowsInternalUrl } from '@/lib/url-safety'
import { resolveRequestId, jsonOk, jsonBadRequest } from '@/lib/api-response'
import { Validator, validationResponse } from '@/lib/validate'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const channels = await db.channel.findMany({
    orderBy: { createdAt: 'asc' },
    select: { apiKey: false, id: true, name: true, baseUrl: true, apiFormat: true, models: true, enabled: true, autoDisabled: true, failStreak: true, autoDisabledAt: true, status: true, latencyMs: true, lastCheckAt: true, lastError: true, remark: true, metadata: true, createdAt: true },
  })
  // 渠道横评统计：按渠道名聚合全量调用日志（调用量/成功率/平均转发延迟/Token 消耗）
  const grouped = await db.requestLog.groupBy({
    by: ['channelName', 'ok'],
    _count: { _all: true },
    _sum: { totalTokens: true, latencyMs: true },
  })
  type Acc = { calls: number; ok: number; tokens: number; latSum: number; latN: number }
  const stats = new Map<string, Acc>()
  for (const g of grouped) {
    const name = g.channelName || '（未知）'
    const a = stats.get(name) || { calls: 0, ok: 0, tokens: 0, latSum: 0, latN: 0 }
    a.calls += g._count._all
    if (g.ok) a.ok += g._count._all
    a.tokens += g._sum.totalTokens ?? 0
    // latencyMs 求和仅为算均值（只统计 ok 的请求，失败请求延迟无参考意义）
    if (g.ok && g._sum.latencyMs) { a.latSum += g._sum.latencyMs; a.latN += g._count._all }
    stats.set(name, a)
  }
  // 近 24h 探测可用率（探测日志比调用日志密集，是渠道健康度的更好指标）
  const start24h = new Date(Date.now() - 24 * 3600_000)
  const probes = await db.probeLog.groupBy({
    by: ['channelId', 'ok'],
    where: { createdAt: { gte: start24h } },
    _count: { _all: true },
  })
  const uptime = new Map<string, { total: number; ok: number }>()
  for (const p of probes) {
    const u = uptime.get(p.channelId) || { total: 0, ok: 0 }
    u.total += p._count._all
    if (p.ok) u.ok += p._count._all
    uptime.set(p.channelId, u)
  }
  return Response.json(
    channels.map((c) => {
      const s = stats.get(c.name)
      const u = uptime.get(c.id)
      return {
        ...c,
        apiFormat: parseApiFormat(c.apiFormat),
        models: parseStringArray(c.models),
        hasKey: true,
        stats: s
          ? { calls: s.calls, ok: s.ok, tokens: s.tokens, avgLatencyMs: s.latN > 0 ? Math.round(s.latSum / s.latN) : null }
          : { calls: 0, ok: 0, tokens: 0, avgLatencyMs: null },
        uptime24h: u && u.total > 0 ? Math.round((u.ok / u.total) * 100) : null,
      }
    })
  )
}

export async function POST(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法', requestId)

  // 统一校验：一次收齐全部问题，长度上限防止超长字段入库
  const v = new Validator(body)
  const name = v.string('name', { required: true, max: 80 })
  const baseUrl = v.string('baseUrl', { required: true, max: 500 })
  const apiKey = v.string('apiKey', { required: true, max: 500 })
  const remark = v.optionalString('remark', { max: 500 })
  const models = v.stringArray('models', { max: 500, itemMax: 120 })
  const enabled = v.boolean('enabled')
  const apiFormat = v.enum('apiFormat', ['openai', 'anthropic', 'gemini'] as const)
  const metadata = v.object('metadata')
  if (v.failed()) return validationResponse(v)

  // SSRF 校验：baseUrl 会被服务端主动 fetch，内网/元数据地址默认拒绝
  const checkedUrl = checkUpstreamUrl(baseUrl, allowsInternalUrl(metadata) || allowsInternalUrl(remark))
  if (!checkedUrl.ok) return jsonBadRequest(checkedUrl.reason, requestId)

  const m = parseMetadata(metadata)
  const ch = await db.channel.create({
    data: {
      name,
      baseUrl: checkedUrl.url,
      apiKey,
      apiFormat: parseApiFormat(apiFormat),
      models: JSON.stringify(models),
      remark: remark ?? null,
      enabled: enabled === false ? false : true,
      ...(m ? { metadata: m } : {}),
    },
  })
  log.info('渠道已创建', { requestId, channelId: ch.id, name, apiFormat: parseApiFormat(apiFormat) })
  return jsonOk({ id: ch.id }, { requestId })
}
