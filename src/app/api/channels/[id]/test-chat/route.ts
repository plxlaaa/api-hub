import { testChannelChat, upstreamUrl, CHAT_TEST_TIMEOUT_MS } from '@/lib/probe'
import { anthropicHeaders, toAnthropicRequest, anthropicToOpenAIResponse, anthropicSSEToOpenAI } from '@/lib/anthropic'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

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
    let models: string[] = []
    try {
      models = JSON.parse(ch.models || '[]') as string[]
    } catch {
      /* ignore */
    }
    const target = (typeof model === 'string' && model.trim()) || models[0] || ''
    if (!target) {
      return Response.json({ error: { message: '渠道未配置支持模型', type: 'invalid_request_error' } }, { status: 400 })
    }
    // anthropic 渠道：请求/响应双向转换，对管理员始终呈现 OpenAI 格式
    const isAnthropic = (ch.apiFormat || 'openai') === 'anthropic'
    const isStream = Boolean(body.stream)
    try {
      const res = await fetch(upstreamUrl(ch.baseUrl, isAnthropic ? 'messages' : 'chat/completions'), {
        method: 'POST',
        headers: isAnthropic ? anthropicHeaders(ch.apiKey) : { 'Content-Type': 'application/json', Authorization: `Bearer ${ch.apiKey}` },
        body: isAnthropic
          ? JSON.stringify(toAnthropicRequest(body as Parameters<typeof toAnthropicRequest>[0], target))
          : JSON.stringify({ ...body, model: target }),
        signal: AbortSignal.timeout(CHAT_TEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300)
        return Response.json({ error: { message: `HTTP ${res.status} ${text}`, type: 'upstream_error' } }, { status: 502 })
      }
      const headers = new Headers()
      headers.set('Content-Type', isAnthropic && isStream ? 'text/event-stream' : res.headers.get('content-type') || 'application/json')
      headers.set('X-Test-Channel', encodeURIComponent(ch.name))
      if (isAnthropic) {
        if (isStream) {
          return new Response(res.body?.pipeThrough(anthropicSSEToOpenAI(String(body.model || target))), { status: res.status, headers })
        }
        const text = await res.text()
        let converted = text
        try {
          converted = JSON.stringify(anthropicToOpenAIResponse(JSON.parse(text), String(body.model || target)))
        } catch {
          /* 转换失败原样返回 */
        }
        return new Response(converted, { status: res.status, headers })
      }
      return new Response(res.body, { status: res.status, headers })
    } catch (err) {
      const msg = err instanceof Error ? (err.name === 'TimeoutError' ? '上游超时' : err.message) : String(err)
      return Response.json({ error: { message: msg, type: 'upstream_error' } }, { status: 502 })
    }
  }

  // 旧逻辑：一键连通性测试（空 body）
  try {
    const result = await testChannelChat(id, typeof model === 'string' ? model : undefined)
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : '测试失败' }, { status: 404 })
  }
}
