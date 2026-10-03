import { clearedSessionCookie, jsonWithCookie } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** 登出：清除会话 Cookie（JWT 为无状态令牌，Cookie 清除即本浏览器失效） */
export async function POST(req: Request) {
  return jsonWithCookie({ ok: true }, clearedSessionCookie(req))
}
