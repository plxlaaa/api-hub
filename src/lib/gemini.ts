import type { OpenAIBody } from '@/lib/anthropic'

/**
 * Google Gemini API 格式转换（generateContent ↔ OpenAI chat.completion）。
 * 参考 anthropic.ts 的纯函数模式；⚠️ 未经真实 Gemini Key 实测，格式依据官方文档实现。
 */

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

/** OpenAI chat 请求 → Gemini generateContent 请求体 */
export function toGeminiRequest(openai: OpenAIBody, targetModel: string): Record<string, unknown> {
  const msgs = openai.messages ?? []
  const systemTexts = msgs.filter((m) => m.role === 'system').map((m) => extractText(m.content)).filter(Boolean)
  const contents = msgs
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: extractText(m.content) }],
    }))
  const gen: Record<string, unknown> = {}
  const maxTokens = openai.max_tokens ?? openai.max_completion_tokens
  if (maxTokens) gen.maxOutputTokens = maxTokens
  if (typeof openai.temperature === 'number') gen.temperature = openai.temperature
  if (typeof openai.top_p === 'number') gen.topP = openai.top_p
  if (openai.stop) gen.stopSequences = Array.isArray(openai.stop) ? openai.stop : [openai.stop]
  const req: Record<string, unknown> = { contents, generationConfig: gen }
  if (systemTexts.length > 0) req.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] }
  return req
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string }
    finishReason?: string
  }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
}

/** Gemini generateContent 响应 → OpenAI chat.completion 响应 */
export function geminiToOpenAIResponse(g: GeminiResponse, requestedModel: string): Record<string, unknown> {
  const cand = g.candidates?.[0]
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  const finish = cand?.finishReason === 'MAX_TOKENS' ? 'length' : cand?.finishReason === 'STOP' ? 'stop' : cand?.finishReason ? 'stop' : null
  const pt = g.usageMetadata?.promptTokenCount ?? 0
  const ct = g.usageMetadata?.candidatesTokenCount ?? 0
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
  }
}

function chunkJson(delta: Record<string, unknown>, finishReason: string | null, requestedModel: string, id: string): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/**
 * Gemini SSE 流（:streamGenerateContent?alt=sse）→ OpenAI SSE 流。
 * 每个 data: 事件是一个增量 GenerateContentResponse：取 candidates[0].content.parts[].text 拼 content chunk；
 * usageMetadata.candidatesTokenCount 出现时发 finish chunk。
 */
export function geminiSSEToOpenAI(requestedModel: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const streamId = `chatcmpl-${crypto.randomUUID()}`
  let roleSent = false

  const handleEvent = (json: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    let ev: GeminiResponse
    try {
      ev = JSON.parse(json)
    } catch {
      return
    }
    const parts = ev.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p) => p.text ?? '').join('')
    if (text) {
      if (!roleSent) {
        controller.enqueue(encoder.encode(chunkJson({ role: 'assistant', content: '' }, null, requestedModel, streamId)))
        roleSent = true
      }
      controller.enqueue(encoder.encode(chunkJson({ content: text }, null, requestedModel, streamId)))
    }
    if (ev.candidates?.[0]?.finishReason) {
      const fr = ev.candidates[0].finishReason === 'MAX_TOKENS' ? 'length' : 'stop'
      controller.enqueue(encoder.encode(chunkJson({}, fr, requestedModel, streamId)))
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line.startsWith('data:')) handleEvent(line.slice(5).trim(), controller)
        // 忽略空行/event: 行等
      }
    },
    flush(controller) {
      const line = buffer.trim()
      if (line.startsWith('data:')) handleEvent(line.slice(5).trim(), controller)
      // 对齐 OpenAI 客户端预期：流结束补 [DONE]
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    },
  })
}
