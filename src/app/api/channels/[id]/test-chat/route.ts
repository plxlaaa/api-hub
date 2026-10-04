import { testChannelChat, upstreamUrl } from '@/lib/probe'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { getAdapter, resolveChatEndpoint } from '@/lib/adapters'
import { redactSecrets } from '@/lib/redact'
import { parseStringArray } from '@/lib/json-field'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** 手动测试的上游超时：比自动探测宽松得多（要跑真实回答），但仍需上限防止挂死 */
const TEST_TIMEOUT_MS = 120_000

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const { model } = body

  // 对话模式：带 messages 时直连该渠道转发（支持流式），不联动熔断（管理员手动测试）
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const ch = await db.channel.findUnique({ where: { id } })
    if (!ch) return Response.json({ error: { message: '渠道不存在', type: 'invalid_request_error' } }, { status: 404 })
    const models = parseStringArray(ch.models)
    const target = (typeof model === 'string' && model.trim()) || models[0] || ''
    if (!target) {
      return Response.json({ error: { message: '渠道未配置支持模型', type: 'invalid_request_error' } }, { status: 400 })
    }
    const isStream = Boolean(body.stream)
    // 三种协议统一走适配器：anthropic/gemini 自动转换请求与响应，
    // 对管理员始终呈现 OpenAI 格式（此前只处理了 anthropic，gemini 会发错协议体）
    const adapter = getAdapter(ch.apiFormat)
    const displayModel = String(body.model || target)
    try {
      const res = await fetch(upstreamUrl(ch.baseUrl, resolveChatEndpoint(adapter, target, isStream)), {
        method: 'POST',
        headers: adapter.buildHeaders(ch.apiKey),
        body: adapter.buildRequestBody(body as never, target),
        // 客户端断开时同样中止上游，避免手动测试挂着白烧额度
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(TEST_TIMEOUT_MS)]),
        cache: 'no-store',
      })
      if (!res.ok) {
        const text = redactSecrets(await res.text().catch(() => ''), 200)
        return Response.json(
          { error: { message: `HTTP ${res.status}${text ? ` ${text}` : ''}`, type: 'upstream_error' } },
          { status: 502 }
        )
      }
      const headers = new Headers()
      headers.set('Content-Type', isStream ? 'text/event-stream' : res.headers.get('content-type') || 'application/json')
      headers.set('X-Test-Channel', encodeURIComponent(ch.name))
      if (isStream) {
        const stream = adapter.transformStream ? res.body?.pipeThrough(adapter.transformStream(displayModel)) : res.body
        return new Response(stream, { status: res.status, headers })
      }
      const text = await res.text()
      if (!adapter.transformResponse) return new Response(text, { status: res.status, headers })
      let converted = text
      try {
        converted = adapter.transformResponse(text, displayModel)
      } catch {
        /* 转换失败原样返回 */
      }
      return new Response(converted, { status: res.status, headers })
    } catch (err) {
      if (req.signal.aborted) return new Response(null, { status: 499 })
      const msg =
        err instanceof Error
          ? (err.name === 'TimeoutError' ? `上游超时（${TEST_TIMEOUT_MS / 1000}s）` : redactSecrets(err.message, 200))
          : redactSecrets(err, 200)
      return Response.json({ error: { message: msg, type: 'upstream_error' } }, { status: 502 })
    }
  }

  // 旧逻辑：一键连通性测试（空 body）
  try {
    const result = await testChannelChat(id, typeof model === 'string' ? model : undefined)
    return Response.json(result)
  } catch (err) {
    // 渠道不存在 → 404；其余（DB 锁、文件系统异常等）→ 500，不要一律报 404 掩盖真实故障
    const notFound = err instanceof Error && err.message === '渠道不存在'
    return Response.json(
      { error: err instanceof Error ? err.message : '测试失败' },
      { status: notFound ? 404 : 500 }
    )
  }
}