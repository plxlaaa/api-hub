import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk, jsonError } from '@/lib/api-response'
import { parsePagination, encodeCursor } from '@/lib/pagination'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/logs —— 探测日志（游标分页）
 *
 * 默认仍取 60 条（保持前端首屏观感不变），但支持 ?limit= 与 ?cursor= 翻页，
 * 探测日志写入频繁（每渠道定时探测），固定 60 条无法回溯历史。
 */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  // 未显式传 limit 时用 60（探测日志密度高，前端只需最近若干条）
  if (!url.searchParams.get('limit')) url.searchParams.set('limit', '60')
  const { limit, cursor } = parsePagination(url.searchParams)

  try {
    const rows = await db.probeLog.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor, skip: 1 } : {}),
      include: { channel: { select: { name: true } } },
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]

    return jsonOk(
      {
        items: page.map((l) => ({
          id: l.id,
          channelName: l.channel.name,
          ok: l.ok,
          latencyMs: l.latencyMs,
          statusCode: l.statusCode,
          error: l.error,
          createdAt: l.createdAt,
        })),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
      },
      { requestId }
    )
  } catch (err) {
    log.error('探测日志查询失败', { requestId, error: err })
    return jsonError(500, '查询探测日志失败', requestId)
  }
}