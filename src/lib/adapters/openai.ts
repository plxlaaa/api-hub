import type { ProtocolAdapter } from '@/lib/adapters/types'

/** OpenAI 兼容协议适配器：请求原样透传（仅替换模型名），响应无需转换 */
export const openaiAdapter: ProtocolAdapter = {
  format: 'openai',
  chatEndpoint: 'chat/completions',
  buildHeaders(apiKey: string) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }
  },
  buildRequestBody(body: Record<string, unknown>, model: string) {
    return JSON.stringify({ ...body, model })
  },
  extractUsage(json: unknown) {
    const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })?.usage
    if (!u || typeof u !== 'object') return { promptTokens: null, completionTokens: null, totalTokens: null }
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
    const prompt = n(u.prompt_tokens)
    const completion = n(u.completion_tokens)
    const total = n(u.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null)
    return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
  },
  extractReply(json: unknown) {
    return (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '(空回复)'
  },
}
