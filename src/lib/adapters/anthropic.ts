import { toAnthropicRequest, anthropicToOpenAIResponse, anthropicSSEToOpenAI } from '@/lib/anthropic'
import type { ProtocolAdapter } from '@/lib/adapters/types'

/** Anthropic Messages 协议适配器：请求转 Anthropic 格式，响应（流/非流）转回 OpenAI 格式 */
export const anthropicAdapter: ProtocolAdapter = {
  format: 'anthropic',
  chatEndpoint: 'messages',
  buildHeaders(apiKey: string) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  },
  buildRequestBody(body, model) {
    return JSON.stringify(toAnthropicRequest(body, model))
  },
  extractUsage(json) {
    const u = (json as { usage?: { input_tokens?: number; output_tokens?: number } })?.usage
    const total = (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0)
    return total || null
  },
  extractReply(json) {
    const j = json as { content?: Array<{ type?: string; text?: string }> }
    return (j?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') || '(空回复)'
  },
  transformResponse(text, model) {
    try {
      return JSON.stringify(anthropicToOpenAIResponse(JSON.parse(text), model))
    } catch {
      return text // 转换失败原样透传，不影响主流程
    }
  },
  transformStream(model) {
    return anthropicSSEToOpenAI(model)
  },
}
