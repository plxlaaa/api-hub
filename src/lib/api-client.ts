export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * 统一 fetch：会话走 HttpOnly Cookie（浏览器同源自动携带，无需也不能在 JS 里读取）。
 * 401 表示未登录/会话过期，抛出由上层跳登录页。
 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const res = await fetch(path, { ...options, headers, credentials: 'same-origin' })
  if (res.status === 401) {
    throw new ApiError('登录已过期，请重新登录', 401)
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status)
  return data
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** 游标分页响应信封（与后端 /api/request-logs 的返回结构一致） */
export interface Paginated<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
  total?: number
}

/**
 * 取分页列表并摊平为数组。
 *
 * 后端日志接口返回 { items, nextCursor } 信封（游标分页），前端多数场景只想渲染
 * 当前这一页，故提供此helper 直接摊平，避免每个调用点都写 .items ?? []。
 */
export async function apiList<T>(path: string, options: RequestInit = {}): Promise<T[]> {
  const data = await api<Paginated<T> | T[]>(path, options)
  if (Array.isArray(data)) return data
  return data.items ?? []
}

/** Token 数量人性化显示：1234 → 1.2k，5678901 → 5.7M */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`
  return `${n} tok`
}
