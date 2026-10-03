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
    const total = (json as { usage?: { total_tokens?: number } })?.usage?.total_tokens
    return typeof total === 'number' ? total : null
  },
  extractReply(json: unknown) {
    return (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '(空回复)'
  },
}
