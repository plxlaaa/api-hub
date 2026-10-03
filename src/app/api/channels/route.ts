import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeBaseUrl } from '@/lib/probe'
import { parseApiFormat } from '@/lib/adapters'
import { parseMetadata } from '@/lib/metadata'

export const dynamic = 'force-dynamic'

function parseModels(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((m) => String(m).trim()).filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean)
  }
  return []
}

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
        models: JSON.parse(c.models || '[]') as string[],
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
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: '请求体非法' }, { status: 400 })

  const { name, baseUrl, apiKey, models, remark, enabled, apiFormat, metadata } = body as Record<string, unknown>
  if (typeof name !== 'string' || !name.trim()) return Response.json({ error: '渠道名称必填' }, { status: 400 })
  if (typeof baseUrl !== 'string' || !normalizeBaseUrl(baseUrl.trim()).match(/^https?:\/\//)) {
    return Response.json({ error: 'Base URL 必须是有效地址（自动补全 https:// 前缀）' }, { status: 400 })
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) return Response.json({ error: 'API Key 必填' }, { status: 400 })

  const m = parseMetadata(metadata)
  const ch = await db.channel.create({
    data: {
      name: name.trim(),
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey: apiKey.trim(),
      apiFormat: parseApiFormat(apiFormat),
      models: JSON.stringify(parseModels(models)),
      remark: typeof remark === 'string' ? remark.trim() : null,
      enabled: enabled === false ? false : true,
      ...(m ? { metadata: m } : {}),
    },
  })
  return Response.json({ id: ch.id })
}
