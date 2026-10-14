import { handleChatCompletions } from '@/lib/gateway'
import {
  anthropicToOpenAIBody,
  openAIToAnthropicResponse,
  openAISSEToAnthropic,
  toAnthropicErrorResponse,
} from '@/lib/anthropic-inbound'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * POST /v1/messages —— 入站 Anthropic Messages 协议（Claude Code / Anthropic SDK 直连）。
 *
 * 客户端发 Anthropic 格式请求（x-api-key 鉴权 + messages 请求体），
 * 内部转换为 OpenAI 格式后重放进网关核心（handleChatCompletions），
 * 鉴权/白名单/配额/限速/路由/故障转移全部复用，响应再转回 Anthropic 格式。
 *
 * 协议链路（以 anthropic 渠道为例）：
 *   客户端(Anthropic) → 入站转 OpenAI → 网关核心 → 出站转 Anthropic → 上游
 *   上游(Anthropic) → 出站转回 OpenAI → 网关 → 入站转回 Anthropic → 客户端
 * 文本/工具调用/流式均支持；多模态图片块降级处理（与出站适配层策略一致）。
 */
export async function POST(req: Request): Promise<Response> {
  // 鉴权头兼容：Anthropic SDK 用 x-api-key，也接受 Authorization Bearer（OpenAI 习惯）。
  // 网关统一 Key 在两种头里都可用。
  const xKey = req.headers.get('x-api-key')?.trim() ?? ''
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const key = xKey || bearer
  if (!key) {
    return toAnthropicErrorResponse(
      { error: { message: '缺少 x-api-key（请使用网关统一 Key）', type: 'invalid_request_error' } },
      401,
    )
  }

  // 解析 Anthropic 请求体
  let aBody: unknown
  try {
    aBody = await req.json()
  } catch {
    return toAnthropicErrorResponse(
      { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } },
      400,
    )
  }

  const openai = anthropicToOpenAIBody(aBody as Parameters<typeof anthropicToOpenAIBody>[0])
  const isStream = Boolean(openai.stream)
  const requestedModel = typeof openai.model === 'string' ? openai.model : ''

  // 构造内部 OpenAI 请求：透传客户端的中断信号（关页面即断上游），
  // 并保留客户端带来的 x-request-id 便于全链路对账。
  const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` })
  const clientReqId = req.headers.get('x-request-id')
  if (clientReqId) headers.set('x-request-id', clientReqId)
  const internal = new Request('http://internal/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(openai),
    signal: req.signal,
  })

  const res = await handleChatCompletions(internal)

  // 错误响应：统一转 Anthropic 错误格式（SDK 才能展示真实原因而不是「解析失败」）
  if (!res.ok) {
    const j = await res.json().catch(() => null)
    return toAnthropicErrorResponse(j, res.status, res.headers.get('x-request-id'))
  }

  const reqId = res.headers.get('x-request-id')

  if (isStream) {
    if (!res.body) return toAnthropicErrorResponse(
      { error: { message: '上游返回空流', type: 'api_error' } }, 502, reqId,
    )
    return new Response(res.body.pipeThrough(openAISSEToAnthropic(requestedModel)), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        ...(reqId ? { 'X-Request-Id': reqId } : {}),
      },
    })
  }

  const o = (await res.json().catch(() => null)) as Parameters<typeof openAIToAnthropicResponse>[0]
  if (!o) {
    return toAnthropicErrorResponse(
      { error: { message: '上游响应无法解析', type: 'api_error' } }, 502, reqId,
    )
  }
  return new Response(JSON.stringify(openAIToAnthropicResponse(o, requestedModel)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(reqId ? { 'X-Request-Id': reqId } : {}),
    },
  })
}
