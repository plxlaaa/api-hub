import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

/** 登录态探测：Cookie 有效返回 { ok:true, username }，否则 401。前端据此决定显示面板还是登录页。 */
export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { loadCredentials } = await import('@/lib/credentials')
  const creds = await loadCredentials()
  return jsonOk({ ok: true, username: creds?.username ?? null }, { requestId })
}
