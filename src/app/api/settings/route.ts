import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk, jsonBadRequest } from '@/lib/api-response'
import { Validator, validationResponse } from '@/lib/validate'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/** 读取网关设置（只暴露非敏感项） */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const rows = await db.setting.findMany({
    where: { key: { in: ['circuitBreaker', 'cbThreshold', 'alertWebhookUrl'] } },
  })
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return jsonOk(
    {
      circuitBreaker: map.circuitBreaker !== 'off', // 默认开启
      cbThreshold: Math.max(1, Number(map.cbThreshold ?? 3) || 3),
      alertWebhookUrl: map.alertWebhookUrl ?? '',
    },
    { requestId }
  )
}

export async function PUT(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法', requestId)

  const v = new Validator(body)
  const circuitBreaker = v.boolean('circuitBreaker')
  const cbThreshold = v.integer('cbThreshold', { min: 1, max: 100 })
  const alertWebhookUrl = v.string('alertWebhookUrl', { max: 500, required: false })
  if (v.failed()) return validationResponse(v)

  const updates: Array<{ key: string; value: string }> = []
  if (circuitBreaker !== undefined) {
    updates.push({ key: 'circuitBreaker', value: circuitBreaker ? 'on' : 'off' })
  }
  if (cbThreshold !== undefined) {
    updates.push({ key: 'cbThreshold', value: String(cbThreshold) })
  }
  if (alertWebhookUrl !== undefined) {
    const url = alertWebhookUrl.trim()
    if (url && !/^https?:\/\//.test(url)) return jsonBadRequest('webhook 地址必须是 http(s) URL', requestId)
    updates.push({ key: 'alertWebhookUrl', value: url })
  }
  if (updates.length === 0) return jsonBadRequest('无可更新字段', requestId)

  for (const u of updates) {
    await db.setting.upsert({ where: { key: u.key }, update: { value: u.value }, create: { key: u.key, value: u.value } })
  }
  log.info('网关设置已更新', { requestId, fields: updates.map((u) => u.key).join(',') })
  return jsonOk({ ok: true }, { requestId })
}
