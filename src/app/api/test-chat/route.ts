import { handleChatCompletions } from '@/lib/gateway'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * 管理台对话测试：管理员身份直接走统一网关链路（路由/负载均衡/熔断/转发），
 * 不经过统一 Key 鉴权，也不消耗密钥配额。响应含流式。
 */
export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  return handleChatCompletions(req, { adminOverride: true })
}
