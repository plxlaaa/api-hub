import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  // 含逗号/引号/换行的字段加引号转义
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// 调用日志导出 CSV（带 BOM，Excel 直开不乱码；沿用现有筛选参数，最多 5000 条）
export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const url = new URL(req.url)
  const tokenName = url.searchParams.get('tokenName')
  const model = url.searchParams.get('model')
  const channelName = url.searchParams.get('channelName')
  const ok = url.searchParams.get('ok') // '1' 仅成功 | '0' 仅失败
  const logs = await db.requestLog.findMany({
    where: {
      ...(tokenName ? { tokenName: tokenName === '-' ? null : tokenName } : {}),
      ...(model ? { model } : {}),
      ...(channelName ? { channelName } : {}),
      ...(ok === '1' || ok === '0' ? { ok: ok === '1' } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  })

  const header = ['时间', '渠道', '对外模型', '上游模型', '结果', 'HTTP状态', '延迟ms', 'Tokens', '密钥', '流式', '错误']
  const rows = logs.map((l) => [
    l.createdAt.toISOString(),
    l.channelName,
    l.model,
    l.targetModel,
    l.ok ? '成功' : '失败',
    l.statusCode ?? '',
    l.latencyMs ?? '',
    l.totalTokens ?? '',
    l.tokenName ?? '',
    l.stream ? '是' : '否',
    l.error ?? '',
  ])
  const csv = '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="request-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
