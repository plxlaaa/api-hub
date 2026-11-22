import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk, jsonBadRequest } from '@/lib/api-response'
import { sendTestAlert } from '@/lib/alert-webhook'
import { Validator, validationResponse } from '@/lib/validate'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/** 管理台「测试推送」：向给定 URL 立即发一条测试告警，返回送达结果 */
export async function POST(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法', requestId)
  const v = new Validator(body)
  const url = v.string('url', { required: true, max: 500 })
  if (v.failed()) return validationResponse(v)
  if (!/^https?:\/\//.test(url)) return jsonBadRequest('webhook 地址必须是 http(s) URL', requestId)

  const r = await sendTestAlert(url)
  log.info('告警测试推送', { requestId, ok: r.ok, detail: r.detail })
  return jsonOk(r, { requestId })
}
