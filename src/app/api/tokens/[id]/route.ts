import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk, jsonBadRequest } from '@/lib/api-response'
import { parseMetadata } from '@/lib/metadata'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const requestId = resolveRequestId(req)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const data: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
  // 配额：null = 不限；正整数 = 上限。清零用量请传 quotaReset=true
  if (body.quotaLimit === null || body.quotaLimit === '' || body.quotaLimit === undefined) data.quotaLimit = null
  else if (Number.isFinite(Number(body.quotaLimit)) && Number(body.quotaLimit) > 0) data.quotaLimit = Math.floor(Number(body.quotaLimit))
  // metadata 三态（与 routes 一致）：undefined=不更新 / null=清空 / 对象=整体替换
  if (body.metadata === null) data.metadata = null
  else if (body.metadata !== undefined) {
    const m = parseMetadata(body.metadata)
    if (m === null) return jsonBadRequest('metadata 格式非法（仅支持扁平对象）', requestId)
    data.metadata = m
  }
  if (body.quotaReset === true) data.quotaUsed = 0
  if (Object.keys(data).length === 0) return jsonBadRequest('无可更新字段', requestId)
  await db.apiToken.update({ where: { id }, data }).catch(() => null)
  return jsonOk({ ok: true }, { requestId })
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const requestId = resolveRequestId(req)
  await db.apiToken.delete({ where: { id } }).catch(() => null)
  return jsonOk({ ok: true }, { requestId })
}
