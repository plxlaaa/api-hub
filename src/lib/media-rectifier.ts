/**
 * 图片降级整流器（学习自 cc-switch 的 media retry 思想）：
 * 上游 4xx 报「不支持视觉输入」时，先把请求体里的图片块降级为文字占位，
 * 对同渠道重试一次 —— 多数"故障"其实是请求不兼容，修一次就永久通，
 * 比盲目故障转移更省（换渠道后图片同样被拒）。
 *
 * 纪律（同 cc-switch per-provider retry flag）：
 *  - 每个渠道对每个请求最多整流一次，防止「降级后仍报错」陷入循环
 *  - 只对不计熔断的客户端侧错误（4xx）触发 —— 5xx/鉴权失败重试也没用
 */

/** 请求体形状：只关心 messages，其余原样保留 */
export interface RectifiableBody {
  messages?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/** 请求体里是否存在图片块（OpenAI 格式 image_url，含对象/字符串两种旧新写法） */
export function bodyHasImages(body: RectifiableBody): boolean {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((m) => {
    const content = m.content
    if (!Array.isArray(content)) return false
    return (content as Array<Record<string, unknown>>).some(
      (b) => b?.type === 'image_url' || b?.type === 'input_image'
    )
  })
}

/**
 * 把图片块降级为文字占位，返回新请求体（不改原对象）。
 * image_url / input_image（Responses 风格）都处理；同消息内文本保留。
 */
export function stripImages(body: RectifiableBody, placeholder = '[图片已省略：该上游不支持视觉输入]'): RectifiableBody {
  if (!Array.isArray(body.messages)) return body
  return {
    ...body,
    messages: body.messages.map((m) => {
      const content = m.content
      if (!Array.isArray(content)) return m
      const parts = content as Array<Record<string, unknown>>
      const hasImage = parts.some((b) => b?.type === 'image_url' || b?.type === 'input_image')
      if (!hasImage) return m
      const texts = parts
        .filter((b) => b?.type === 'text')
        .map((b) => String((b as { text?: unknown }).text ?? ''))
        .filter((t) => t.length > 0)
      return { ...m, content: [...texts, placeholder].join('\n') }
    }),
  }
}

/** 「图片不支持」错误特征词（中英，覆盖常见公益站/官方报错措辞） */
const IMAGE_REJECT_HINTS = [
  'image_url',
  'image_url is not',
  'does not support image',
  'image input',
  'image content',
  'vision',
  'multimodal',
  'multi-modal',
  'visual',
  '不支持图片',
  '不支持视觉',
  '不支持多模态',
  '图片输入',
  '图像',
]

/**
 * 该 4xx 响应是否为「图片被拒」：
 * 仅客户端侧错误码（400/422，含 415）+ 错误体命中特征词才触发整流。
 */
export function isImageRejection(statusCode: number, detail: string): boolean {
  if (statusCode !== 400 && statusCode !== 415 && statusCode !== 422) return false
  const lower = detail.toLowerCase()
  return IMAGE_REJECT_HINTS.some((h) => lower.includes(h))
}
