import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** 读取网关设置（只暴露非敏感项） */
export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const rows = await db.setting.findMany({
    where: { key: { in: ['circuitBreaker', 'cbThreshold'] } },
  })
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return Response.json({
    circuitBreaker: map.circuitBreaker !== 'off', // 默认开启
    cbThreshold: Math.max(1, Number(map.cbThreshold ?? 3) || 3),
  })
}

export async function PUT(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: '请求体非法' }, { status: 400 })

  const updates: Array<{ key: string; value: string }> = []
  if (typeof body.circuitBreaker === 'boolean') {
    updates.push({ key: 'circuitBreaker', value: body.circuitBreaker ? 'on' : 'off' })
  }
  if (body.cbThreshold !== undefined) {
    const n = Number(body.cbThreshold)
    if (!Number.isFinite(n) || n < 1) return Response.json({ error: '阈值必须 ≥ 1' }, { status: 400 })
    updates.push({ key: 'cbThreshold', value: String(Math.floor(n)) })
  }
  if (updates.length === 0) return Response.json({ error: '无可更新字段' }, { status: 400 })

  for (const u of updates) {
    await db.setting.upsert({ where: { key: u.key }, update: { value: u.value }, create: { key: u.key, value: u.value } })
  }
  return Response.json({ ok: true })
}
