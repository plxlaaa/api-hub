import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk, jsonError } from '@/lib/api-response'
import { parsePagination, encodeCursor } from '@/lib/pagination'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * GET /api/request-logs —— 调用日志（游标分页）
 *
 * 从 `take: limit` 改为游标分页的原因：
 * - offset 分页在深翻页时 SQLite 要扫过并丢弃前 N 行，日志表上千行后越翻越慢；
 * - 日志是「只增不改」的追加流，按 createdAt + id 复合排序天然适合游标，
 *   翻页结果稳定（不会因新日志插入而重复或漏掉同一条）。
 *
 * 兼容性：未传 cursor 时 items 就是最新 limit 条，与从前行为一致，旧前端不受影响。
 * 注意响应体形状变了（数组 → { items, nextCursor }），前端需同步读取 items。
 */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied

  const url = new URL(req.url)
  const { limit, cursor } = parsePagination(url.searchParams)

  const tokenName = url.searchParams.get('tokenName')
  const model = url.searchParams.get('model')
  const channelName = url.searchParams.get('channelName')
  const ok = url.searchParams.get('ok') // '1' 仅成功| '0' 仅失败

  const where = {
    ...(tokenName ? { tokenName: tokenName === '-' ? null : tokenName } : {}),
    ...(model ? { model } : {}),
    ...(channelName ? { channelName } : {}),
    ...(ok === '1' || ok === '0' ? { ok: ok === '1' } : {}),
  }

  try {
    // 取 limit+1 条判断是否还有下一页（避免多一次 count 查询）
    const rows = await db.requestLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor, skip: 1 } : {}),
    })

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]

    // total 全表count 在大表上不便宜，仅在显式请求时计算
    const total = url.searchParams.get('withTotal') === '1' ? await db.requestLog.count({ where }) : undefined

    return jsonOk(
      {
        items: page,
        // null 表示已到末页，前端据此隐藏「加载更多」
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        hasMore,
        ...(total !== undefined ? { total } : {}),
      },
      { requestId }
    )
  } catch (err) {
    log.error('调用日志查询失败', { requestId, error: err })
    return jsonError(500, '查询调用日志失败', requestId)
  }
}

export async function DELETE(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  await db.requestLog.deleteMany({})
  log.info('调用日志已清空', { requestId })
  return jsonOk({ ok: true }, { requestId })
}