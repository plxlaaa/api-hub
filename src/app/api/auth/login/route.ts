import { isInitialized, loginAdmin, loginLockRemaining } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (!(await isInitialized())) {
    return Response.json({ error: '尚未初始化，请先设置管理密码' }, { status: 409 })
  }
  const locked = loginLockRemaining(req)
  if (locked > 0) {
    return Response.json(
      { error: `失败次数过多，已锁定，请 ${Math.ceil(locked / 60)} 分钟后再试` },
      { status: 429, headers: { 'Retry-After': String(locked) } }
    )
  }
  const { password } = await req.json().catch(() => ({ password: '' }))
  const token = typeof password === 'string' ? await loginAdmin(req, password) : null
  if (!token) return Response.json({ error: '密码错误' }, { status: 401 })
  return Response.json({ token })
}
