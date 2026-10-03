import type { OpenAIBody } from '@/lib/anthropic'

/** 渠道 API 协议格式（可扩展：新增协议在此注册） */
export type ApiFormat = 'openai' | 'anthropic' | 'gemini'

/**
 * 协议适配器：网关对上游协议的全部认知收敛于此接口。
 * 网关主流程只面向该接口编程，新增协议（如 azure-openai）= 新增一个适配器文件并注册，零改动主流程。
 */
export interface ProtocolAdapter {
  format: ApiFormat
  /**
   * 对话补全端点（相对 baseUrl）。
   * 字符串 = 固定路径；函数 = 端点含模型名（如 Gemini 的 models/{model}:generateContent）。
   */
  chatEndpoint: string | ((model: string) => string)
  /** 流式端点（缺省复用 chatEndpoint；Gemini 等协议流式是独立端点） */
  chatStreamEndpoint?: (model: string) => string
  /** 构造上游请求头 */
  buildHeaders(apiKey: string): Record<string, string>
  /** 构造上游请求体（含渠道级模型名映射） */
  buildRequestBody(body: OpenAIBody, model: string): string
  /** 从非流式响应 JSON 提取总 Token 数（提取失败返回 null，不影响转发） */
  extractUsage(json: unknown): number | null
  /** 从非流式响应 JSON 提取回复文本（一键对话测试用） */
  extractReply(json: unknown): string
  /** 非流式响应体转换（缺省 = 原样透传，openai 格式无需转换） */
  transformResponse?(text: string, model: string): string
  /** 流式响应转换器（缺省 = 原样透传 SSE） */
  transformStream?(model: string): TransformStream<Uint8Array, Uint8Array>
}

export function isApiFormat(v: unknown): v is ApiFormat {
  return v === 'openai' || v === 'anthropic' || v === 'gemini'
}

/** 解析渠道协议格式（未知值回退 openai） */
export function parseApiFormat(v: unknown): ApiFormat {
  return isApiFormat(v) ? v : 'openai'
}
