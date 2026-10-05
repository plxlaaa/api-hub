/**
 * 游标分页参数解析与游标编解码。
 *
 * 游标格式：`<ISO时间戳>|<id>`
 * 用时间 + 唯一 id 复合排序，而不是只用时间戳 —— 日志写入在毫秒级时间内可能
 * 并发多条（SQLite 单写者但仍会同毫秒），只按时间排序会出现「翻页时漏条/重条」。
 *
 * 游标做 Base64URL 编码：避免 id 里可能出现的分隔符与 JSON 转义问题，
 * 也让客户端把它当不透明字符串直接回传。
 */

export interface Pagination {
  /** 每页条数（已clamp 到 [1, MAX_LIMIT]） */
  limit: number
  /** 上一页末条的复合游标；首页为 undefined */
  cursor?: { createdAt: Date; id: string }
}

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500

/**
 * 解析 searchParams 里的 limit / cursor。
 *
 * 非法输入一律回退到默认值而不是报错：这是管理端读取接口，
 * 前端参数异常时应尽量返回数据而不是整个页面崩掉。
 */
export function parsePagination(params: URLSearchParams): Pagination {
  const rawLimit = Number(params.get('limit'))
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT

  const rawCursor = params.get('cursor')
  if (!rawCursor) return { limit }

  const decoded = decodeCursor(rawCursor)
  if (!decoded) return { limit }
  return { limit, cursor: decoded }
}

/** 解码游标；任何格式错误都返回 null（视为无游标，退回首页语义） */
export function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    // 用 base64url 解码，兼容标准 base64（部分客户端会自行补 padding）
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { t?: unknown; i?: unknown }
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string') return null
    const createdAt = new Date(parsed.t)
    // 显式校验时间有效性：new Date('garbage') 会得到 Invalid Date 而不抛异常
    if (Number.isNaN(createdAt.getTime())) return null
    return { createdAt, id: parsed.i }
  } catch {
    return null
  }
}

/** 编码游标（服务端产出 nextCursor 时用） */
export function encodeCursor(createdAt: Date, id: string): string {
  const json = JSON.stringify({ t: createdAt.toISOString(), i: id })
  return Buffer.from(json, 'utf8').toString('base64url')
}