import { probeUpstream, upstreamUrl } from '@/lib/probe'
import { getAdapter, parseApiFormat } from '@/lib/adapters'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonError, jsonBadRequest } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

/** 一键拉取上游 /models 模型列表（保存渠道前也可用：只需 baseUrl + apiKey + apiFormat） */
export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const requestId = resolveRequestId(req)
  const { baseUrl, apiKey, channelId, apiFormat } = (await req.json().catch(() => ({}))) as Record<string, unknown>

  let url = typeof baseUrl === 'string' ? baseUrl : ''
  let key = typeof apiKey === 'string' ? apiKey : ''
  let fmt = typeof apiFormat === 'string' ? apiFormat : undefined

  if (channelId) {
    const ch = await db.channel.findUnique({ where: { id: String(channelId) } })
    if (!ch) return jsonError(404, '渠道不存在', requestId)
    url = url || ch.baseUrl
    key = key || ch.apiKey
    fmt = fmt ?? ch.apiFormat
  }

  if (!/^https?:\/\//.test(url.trim())) {
    return jsonError(400, 'Base URL 必须以 http:// 或 https:// 开头', requestId)
  }

  const format = parseApiFormat(fmt)
  const headers = getAdapter(format).buildHeaders(key)
  const result = await probeUpstream(url, key, format)
  if (!result.ok) {
    return jsonError(502, `拉取失败：${result.error ?? '未知错误'}`, requestId)
  }
  try {
    const res = await fetch(upstreamUrl(url, 'models'), {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (data.data || []).map((m) => String(m.id)).filter(Boolean).sort()
    return Response.json({ models })
  } catch (err) {
    return jsonError(502, err instanceof Error ? err.message : '解析失败', requestId)
  }
}
