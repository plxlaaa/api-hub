/**
 * 库中以 JSON 字符串存放的数组字段的安全解析。
 *
 * Channel.models / ModelRoute.channelConfigs / ModelRoute.channelIds 都是
 * 「存成字符串的 JSON 数组」。历史数据、手工导入或磁盘损坏都可能让它不是合法 JSON，
 * 裸 JSON.parse 会抛异常并让整个列表接口 500 —— 这里统一降级为默认值。
 */

/** 解析字符串数组；非法 JSON 返回空数组 */
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean) : []
  } catch {
    // 退而求其次：允许用换行/逗号分隔的裸列表（与前端输入框格式一致）
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
}