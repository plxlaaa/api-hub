import { isInitialized, setupAdmin, withSessionCookie, jsonWithCookie } from '@/lib/auth'
import { verifySetupToken, consumeSetupToken } from '@/lib/credentials'

export const dynamic = 'force-dynamic'

// 用户名规则：2-32 位，仅含字母/数字/中文/._-
const USERNAME_RE = /^[A-Za-z0-9_一-龥.\-]+$/

export async function POST(req: Request) {
  const { username, password, setupToken } = await req
    .json()
    .catch(() => ({ username: '', password: '', setupToken: '' }))
  const name = typeof username === 'string' ? username.trim() : ''
  if (name.length < 2 || name.length > 32) {
    return Response.json({ error: '用户名需 2-32 位' }, { status: 400 })
  }
  if (!USERNAME_RE.test(name)) {
    return Response.json({ error: '用户名仅含字母/数字/中文/._-' }, { status: 400 })
  }
  if (typeof password !== 'string' || password.length < 4) {
    return Response.json({ error: '管理密码至少 4 位' }, { status: 400 })
  }
  if (await isInitialized()) {
    return Response.json({ error: '管理员已设置，请直接登录' }, { status: 409 })
  }
  // 一次性设置令牌校验（防公网暴露时被抢注）：令牌只在本机 db/setup-token.txt / 控制台
  const ok = await verifySetupToken(typeof setupToken === 'string' ? setupToken : '')
  if (!ok) {
    return Response.json(
      { error: '设置令牌无效。请在本机查看 db/setup-token.txt（或服务器启动日志）后粘贴' },
      { status: 401 }
    )
  }
  const token = await setupAdmin(name, password)
  await consumeSetupToken() // 建号成功 → 令牌即焚
  return jsonWithCookie({ ok: true }, withSessionCookie(req, token))
}
