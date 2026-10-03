import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
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
    take: limit,
  })
  return Response.json(logs)
}

export async function DELETE(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  await db.requestLog.deleteMany({})
  return Response.json({ ok: true })
}
