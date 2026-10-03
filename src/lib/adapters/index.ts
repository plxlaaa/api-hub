import { openaiAdapter } from '@/lib/adapters/openai'
import { anthropicAdapter } from '@/lib/adapters/anthropic'
import { geminiAdapter } from '@/lib/adapters/gemini'
import { parseApiFormat, isApiFormat, type ApiFormat, type ProtocolAdapter } from '@/lib/adapters/types'

export { parseApiFormat, isApiFormat }
export type { ApiFormat, ProtocolAdapter }

/**
 * 协议适配器注册表。
 * 新增协议三步：① 写 adapter 文件实现 ProtocolAdapter ② 在此注册 ③ 渠道 apiFormat 即可选。
 * 主流程（gateway/probe）只经 getAdapter 访问，不感知具体协议。
 */
const ADAPTERS: Record<ApiFormat, ProtocolAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
}

export function getAdapter(format: string | null | undefined): ProtocolAdapter {
  return ADAPTERS[parseApiFormat(format)] ?? openaiAdapter
}

/** 解析对话端点（支持字符串或含模型名的函数形式） */
export function resolveChatEndpoint(adapter: ProtocolAdapter, model: string, stream: boolean): string {
  if (stream && adapter.chatStreamEndpoint) return adapter.chatStreamEndpoint(model)
  const ep = adapter.chatEndpoint
  return typeof ep === 'function' ? ep(model) : ep
}

/** 全部已注册协议（渠道表单下拉用） */
export function listAdapters(): Array<{ value: ApiFormat; label: string }> {
  return [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'anthropic', label: 'Anthropic Messages' },
    { value: 'gemini', label: 'Google Gemini' },
  ]
}
