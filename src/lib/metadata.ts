/**
 * metadata Json 扩展字段：各实体的自定义配置空间（分组/标签/白名单等）。
 * 约束：仅接受「扁平对象、值为基础类型」，深度限制 2 层、单值 <=200 字符，防止滥用成垃圾场。
 * 未来新特性优先用 metadata 承载实验配置，验证稳定后再升级为正式字段。
 */
export function parseMetadata(v: unknown): Record<string, string | number | boolean> | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, string | number | boolean> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!k.trim() || k.length > 40) return null
    if (typeof val === 'string') {
      if (val.length > 200) return null
      out[k.trim()] = val
    } else if (typeof val === 'number' && Number.isFinite(val)) {
      out[k.trim()] = val
    } else if (typeof val === 'boolean') {
      out[k.trim()] = val
    } else {
      return null // 嵌套对象/数组暂不支持，保持简单
    }
  }
  return Object.keys(out).length > 0 ? out : null
}
