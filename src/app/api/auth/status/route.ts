import { isInitialized } from '@/lib/auth'
import { resolveRequestId, jsonOk } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
  try {
    return jsonOk({ initialized: await isInitialized() }, { requestId })
  } catch {
    return jsonOk({ initialized: false }, { requestId })
  }
}
