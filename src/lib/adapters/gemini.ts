import { toGeminiRequest, geminiToOpenAIResponse, geminiSSEToOpenAI } from '@/lib/gemini'
import type { ProtocolAdapter } from '@/lib/adapters/types'

/**
 * Google Gemini 协议适配器。
 * 端点含模型名：POST {base}/v1beta/models/{model}:generateContent（流式 :streamGenerateContent?alt=sse）。
 * ⚠️ 未经真实 Gemini Key 实测（mock 验证通过），接入真实渠道后建议先跑一键对话测试确认。
 */
export const geminiAdapter: ProtocolAdapter = {
  format: 'gemini',
  chatEndpoint: (model: string) => `v1beta/models/${encodeURIComponent(model)}:generateContent`,
  chatStreamEndpoint: (model: string) => `v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
  buildHeaders(apiKey: string) {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    }
  },
  buildRequestBody(body, model) {
    return JSON.stringify(toGeminiRequest(body, model))
  },
  extractUsage(json) {
    const total = (json as { usageMetadata?: { totalTokenCount?: number } })?.usageMetadata?.totalTokenCount
    return typeof total === 'number' ? total : null
  },
  extractReply(json) {
    const g = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    return (g?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('') || '(空回复)'
  },
  transformResponse(text, model) {
    try {
      return JSON.stringify(geminiToOpenAIResponse(JSON.parse(text), model))
    } catch {
      return text
    }
  },
  transformStream(model) {
    return geminiSSEToOpenAI(model)
  },
}
