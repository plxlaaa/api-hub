/**
 * Anthropic（Claude）原生格式适配层
 * 用户始终以 OpenAI 格式调用网关；转发到 apiFormat=anthropic 的渠道时：
 * 请求体 /v1/chat/completions → /v1/messages，响应再转回 OpenAI 格式（含 SSE 流式）。
 * 仅支持文本内容（多模态图片格式差异大，暂不转换）。
 */

export interface OpenAIMessage {
  role: string
  content: unknown
}

export interface OpenAIBody {
  model?: string
  messages?: OpenAIMessage[]
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
}

/** 提取 OpenAI content（string 或分块数组）中的纯文本 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: string }).text ?? '') : ''))
      .join('')
  }
  return ''
}

/** OpenAI 请求体 → Anthropic /v1/messages 请求体 */
export function toAnthropicRequest(openai: OpenAIBody, targetModel: string): Record<string, unknown> {
  const msgs = (openai.messages ?? []).filter((m) => m.role !== 'system')
  const systemTexts = (openai.messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => extractText(m.content))
    .filter(Boolean)
  const stops = Array.isArray(openai.stop) ? openai.stop : openai.stop ? [openai.stop] : undefined
  const req: Record<string, unknown> = {
    model: targetModel,
    max_tokens: openai.max_tokens ?? openai.max_completion_tokens ?? 4096,
    messages: msgs.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: extractText(m.content) })),
  }
  if (systemTexts.length > 0) req.system = systemTexts.join('\n\n')
  if (typeof openai.temperature === 'number') req.temperature = openai.temperature
  if (typeof openai.top_p === 'number') req.top_p = openai.top_p
  if (stops?.length) req.stop_sequences = stops
  if (openai.stream) req.stream = true
  return req
}

/** Anthropic /v1/messages 响应 → OpenAI chat.completion 响应 */
export function anthropicToOpenAIResponse(a: {
  id?: string
  model?: string
  content?: Array<{ type?: string; text?: string }>
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}, requestedModel: string): Record<string, unknown> {
  const text = (a.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  const finish = a.stop_reason === 'max_tokens' ? 'length' : a.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
  const promptTokens = a.usage?.input_tokens ?? 0
  const completionTokens = a.usage?.output_tokens ?? 0
  return {
    id: a.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

function chunkJson(delta: Record<string, unknown>, finishReason: string | null, requestedModel: string, id?: string): string {
  return `data: ${JSON.stringify({
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/**
 * Anthropic SSE 流 → OpenAI SSE 流 转换器。
 * 事件映射：message_start → role chunk；content_block_delta(text_delta) → content chunk；
 * message_delta → finish chunk + usage；message_stop → [DONE]；其余忽略。
 */
export function anthropicSSEToOpenAI(requestedModel: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const streamId = `chatcmpl-${crypto.randomUUID()}` // 整个流共用一个 id（对齐 OpenAI 行为）

  const handleEvent = (json: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    let ev: {
      type?: string
      delta?: { type?: string; text?: string; stop_reason?: string }
      message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      usage?: { input_tokens?: number; output_tokens?: number }
      error?: { message?: string }
    }
    try {
      ev = JSON.parse(json)
    } catch {
      return
    }
    switch (ev.type) {
      case 'message_start': {
        const it = ev.message?.usage?.input_tokens
        controller.enqueue(encoder.encode(chunkJson({ role: 'assistant', content: '' }, null, requestedModel, streamId)))
        if (typeof it === 'number' && it > 0) promptTokens = it
        break
      }
      case 'content_block_delta': {
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          controller.enqueue(encoder.encode(chunkJson({ content: ev.delta.text }, null, requestedModel, streamId)))
        }
        break
      }
      case 'message_delta': {
        const ot = ev.usage?.output_tokens
        if (typeof ot === 'number') completionTokens = ot
        const fr = ev.delta?.stop_reason === 'max_tokens' ? 'length' : 'stop'
        controller.enqueue(encoder.encode(chunkJson({}, fr, requestedModel, streamId)))
        break
      }
      case 'message_stop': {
        const usageLine = `data: ${JSON.stringify({
          id: streamId,
          object: 'chat.completion.chunk',
          model: requestedModel,
          choices: [],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        })}\n\n`
        controller.enqueue(encoder.encode(usageLine))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        break
      }
      case 'error': {
        const msg = ev.error?.message || '上游流式错误'
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: 'api_error' } })}\n\n`))
        break
      }
      default:
        break
    }
  }

  let promptTokens = 0
  let completionTokens = 0

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const json = trimmed.slice(5).trim()
        if (!json || json === '[DONE]') continue
        handleEvent(json, controller)
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data:')) {
        const json = trimmed.slice(5).trim()
        if (json && json !== '[DONE]') handleEvent(json, controller)
      }
    },
  })
}

/** Anthropic 渠道请求头 */
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
}
