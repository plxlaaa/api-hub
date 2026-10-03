import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const data: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
  // 配额：null = 不限；正整数 = 上限。清零用量请传 quotaReset=true
  if (body.quotaLimit === null || body.quotaLimit === '' || body.quotaLimit === undefined) data.quotaLimit = null
  else if (Number.isFinite(Number(body.quotaLimit)) && Number(body.quotaLimit) > 0) data.quotaLimit = Math.floor(Number(body.quotaLimit))
  if (body.quotaReset === true) data.quotaUsed = 0
  if (Object.keys(data).length === 0) return Response.json({ error: '无可更新字段' }, { status: 400 })
  await db.apiToken.update({ where: { id }, data }).catch(() => null)
  return Response.json({ ok: true })
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  await db.apiToken.delete({ where: { id } }).catch(() => null)
  return Response.json({ ok: true })
}
