import { isInitialized } from '@/lib/auth'
import { resolveRequestId, jsonOk } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  try {
    return jsonOk(
      {
        initialized: await isInitialized(),
        // 本地应用模式（GW_AUTH_DISABLED=1）：前端据此跳过登录表单直进管理台
        authDisabled: process.env.GW_AUTH_DISABLED === '1',
      },
      { requestId },
    )
  } catch {
    return jsonOk({ initialized: false, authDisabled: process.env.GW_AUTH_DISABLED === '1' }, { requestId })
  }
}
