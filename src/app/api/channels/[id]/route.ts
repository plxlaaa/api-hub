import { db } from '@/lib/db'
import { isApiFormat } from '@/lib/adapters'
import { requireAdmin } from '@/lib/auth'
import { checkUpstreamUrlWithDns, allowsInternalUrl } from '@/lib/url-safety'
import { resolveRequestId, jsonOk, jsonError, jsonBadRequest } from '@/lib/api-response'
import { Validator, validationResponse } from '@/lib/validate'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: Request, { params }: Params) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法', requestId)

  const ch = await db.channel.findUnique({ where: { id } })
  if (!ch) return jsonError(404, '渠道不存在', requestId)

  // PUT 为局部更新：未提供的字段保持不变，故全部用 optional 语义
  const v = new Validator(body)
  const name = v.optionalString('name', { max: 80 })
  const baseUrl = v.optionalString('baseUrl', { max: 500 })
  const apiKey = v.optionalString('apiKey', { max: 500 })
  const remark = v.optionalString('remark', { max: 500 })
  const apiFormat = v.optionalString('apiFormat')
  const enabled = v.boolean('enabled')
  const models = body.models !== undefined ? v.stringArray('models', { max: 500, itemMax: 120 }) : undefined
  if (v.failed()) return validationResponse(v)
  // 空字符串视为「不改」而非「清空」，避免误清
  if (apiFormat !== undefined && apiFormat !== '' && !isApiFormat(apiFormat)) {
    return jsonBadRequest('apiFormat 必须是 openai / anthropic / gemini', requestId)
  }

  const data: Record<string, unknown> = {}
  if (name) data.name = name
  if (baseUrl) {
    // SSRF 校验：allowInternal 取「本次提交或已存」的 metadata，避免误伤内网自建渠道
    const allowInternal =
      allowsInternalUrl(body.metadata) || allowsInternalUrl(body.remark) || allowsInternalUrl(ch.metadata)
    const checked = await checkUpstreamUrlWithDns(baseUrl, allowInternal)
    if (!checked.ok) return jsonBadRequest(checked.reason, requestId)
    data.baseUrl = checked.url
  }
  if (apiKey) data.apiKey = apiKey
  if (apiFormat) data.apiFormat = apiFormat
  if (models) data.models = JSON.stringify(models)
  if (remark !== undefined) data.remark = remark === '' ? null : remark
  if (enabled !== undefined) data.enabled = enabled
  // 手动启用渠道时清除熔断状态与失败计数
  if (enabled === true) {
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
  log.info('渠道已更新', { requestId, channelId: id, fields: Object.keys(data).join(',') })
  return jsonOk({ ok: true }, { requestId })
}

export async function DELETE(req: Request, { params }: Params) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  await db.channel.delete({ where: { id } }).catch(() => null)
  log.info('渠道已删除', { requestId, channelId: id })
  return jsonOk({ ok: true }, { requestId })
}