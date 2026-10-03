import { isInitialized, setupAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: '' }))
  if (typeof password !== 'string' || password.length < 4) {
    return Response.json({ error: '管理密码至少 4 位' }, { status: 400 })
  }
  if (await isInitialized()) {
    return Response.json({ error: '管理密码已设置，请直接登录' }, { status: 409 })
  }
  const token = await setupAdmin(password)
  return Response.json({ token })
}
