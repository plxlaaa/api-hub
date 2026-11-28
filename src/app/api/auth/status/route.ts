import { isInitialized } from '@/lib/auth'
import { isAuthDisabled } from '@/lib/local-app'
import { resolveRequestId, jsonOk } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  try {
    return jsonOk(
      {
        initialized: await isInitialized(),
        // 本地应用模式：前端据此跳过登录表单直进管理台
        authDisabled: isAuthDisabled(),
      },
      { requestId },
    )
  } catch {
    return jsonOk({ initialized: false, authDisabled: isAuthDisabled() }, { requestId })
  }
}
