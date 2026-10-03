import { db } from '@/lib/db'
import { isApiFormat } from '@/lib/adapters'
import { requireAdmin } from '@/lib/auth'
import { normalizeBaseUrl } from '@/lib/probe'

export const dynamic = 'force-dynamic'

function parseModels(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((m) => String(m).trim()).filter(Boolean)
  if (typeof raw === 'string') return raw.split(/[\n,]/).map((m) => m.trim()).filter(Boolean)
  return []
}

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: '请求体非法' }, { status: 400 })

  const ch = await db.channel.findUnique({ where: { id } })
  if (!ch) return Response.json({ error: '渠道不存在' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
  if (typeof body.baseUrl === 'string') {
    const nb = normalizeBaseUrl(body.baseUrl)
    if (!nb.match(/^https?:\/\//)) {
      return Response.json({ error: 'Base URL 必须是有效地址（自动补全 https:// 前缀）' }, { status: 400 })
    }
    data.baseUrl = nb
  }
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) data.apiKey = body.apiKey.trim()
  if (isApiFormat(body.apiFormat)) data.apiFormat = body.apiFormat
  if (body.models !== undefined) data.models = JSON.stringify(parseModels(body.models))
  if (typeof body.remark === 'string' || body.remark === null) data.remark = typeof body.remark === 'string' ? body.remark.trim() : null
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled
  // 手动启用渠道时清除熔断状态与失败计数
  if (body.enabled === true) {
    data.autoDisabled = false
    data.failStreak = 0
    data.autoDisabledAt = null
  }
  // 修改了连接信息后重置探测状态
  if (data.baseUrl || data.apiKey || data.apiFormat) {
    data.status = 'unknown'
    data.latencyMs = null
    data.lastError = null
    data.failStreak = 0
  }

  await db.channel.update({ where: { id }, data })
  return Response.json({ ok: true })
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  await db.channel.delete({ where: { id } }).catch(() => null)
  return Response.json({ ok: true })
}
