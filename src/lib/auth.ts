import { SignJWT, jwtVerify } from 'jose'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { loadCredentials, saveCredentials } from '@/lib/credentials'

const SETTING_JWT_SECRET = 'jwtSecret'
const TOKEN_EXPIRES = '30d'
const SESSION_COOKIE = 'ah_session'
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 30 天

// ---------- Setting 存取（仅用于 JWT 密钥等非用户凭据） ----------

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  // sqlite upsert 非原子（select→insert/update），并发首写会撞唯一键，改为 update 优先 + 冲突回退 create
  const updated = await db.setting
    .updateMany({ where: { key }, data: { value } })
    .catch(() => ({ count: 0 }))
  if (updated.count === 0) {
    await db.setting.create({ data: { key, value } }).catch(() => {})
  }
}

export async function isInitialized(): Promise<boolean> {
  return (await loadCredentials()) !== null
}

// ---------- 密码哈希（scrypt） ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

// ---------- JWT ----------

async function getJwtSecret(): Promise<Uint8Array> {
  let secret = await getSetting(SETTING_JWT_SECRET)
  if (!secret) {
    secret = randomBytes(32).toString('hex')
    await setSetting(SETTING_JWT_SECRET, secret)
  }
  return new TextEncoder().encode(secret)
}

export async function signAdminToken(): Promise<string> {
  return new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRES)
    .sign(await getJwtSecret())
}

// ---------- 会话 Cookie（HttpOnly，防 XSS 窃取；面板级做法） ----------

function isHttps(req: Request): boolean {
  const proto = (req.headers.get('x-forwarded-proto') || '').split(',')[0].trim()
  if (proto === 'https') return true
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/** 构造会话 Cookie：HttpOnly + SameSite=Lax，https 下追加 Secure */
export function sessionCookie(req: Request, token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
  ]
  if (isHttps(req)) parts.push('Secure')
  return parts.join('; ')
}

/** 清除会话 Cookie（登出） */
function clearSessionCookie(req: Request): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isHttps(req)) parts.push('Secure')
  return parts.join('; ')
}

/** 构造 JSON 响应并（可选）附带 Set-Cookie（显式传入 headers，避免 Set-Cookie 被 headers guard 拦截） */
export function jsonWithCookie(data: unknown, cookie?: string, status = 200): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers['Set-Cookie'] = cookie
  return new Response(JSON.stringify(data), { status, headers })
}

export function withSessionCookie(req: Request, token: string): string {
  return sessionCookie(req, token)
}

export function clearedSessionCookie(req: Request): string {
  return clearSessionCookie(req)
}

// ---------- 管理端鉴权 guard（Cookie 优先，兼容 Authorization 头） ----------

function tokenFromRequest(req: Request): string {
  const cookie = req.headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  const auth = req.headers.get('authorization') || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return ''
}

export async function requireAdmin(req: Request): Promise<Response | null> {
  const token = tokenFromRequest(req)
  if (!token) return unauthorized()
  try {
    await jwtVerify(token, await getJwtSecret())
    return null
  } catch {
    return unauthorized()
  }
}

export function unauthorized(): Response {
  return Response.json({ error: '未登录或登录已过期' }, { status: 401 })
}

// ---------- 初始化 / 登录 ----------

export async function setupAdmin(username: string, password: string): Promise<string> {
  await saveCredentials({ username, passwordHash: hashPassword(password) })
  return signAdminToken()
}

// ---------- 登录防爆破（同宝塔/1Panel 策略：连续失败 5 次锁定 10 分钟） ----------

const LOCK_THRESHOLD = 5
const LOCK_WINDOW_MS = 10 * 60_000
const loginAttempts = new Map<string, { count: number; firstAt: number; lockedUntil: number }>()

function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') || ''
  return (fwd.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local').slice(0, 64)
}

/** 检查该 IP 是否被锁定；返回剩余秒数（0 = 未锁定） */
export function loginLockRemaining(req: Request): number {
  const rec = loginAttempts.get(clientKey(req))
  if (!rec) return 0
  if (rec.lockedUntil > Date.now()) return Math.ceil((rec.lockedUntil - Date.now()) / 1000)
  return 0
}

export function recordLoginFailure(req: Request): void {
  const key = clientKey(req)
  const now = Date.now()
  const rec = loginAttempts.get(key)
  if (!rec || now - rec.firstAt > LOCK_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 })
    return
  }
  rec.count++
  if (rec.count >= LOCK_THRESHOLD) rec.lockedUntil = now + LOCK_WINDOW_MS
  // 顺手清理过期记录，防止 Map 无限增长
  if (loginAttempts.size > 1000) {
    for (const [k, v] of loginAttempts) {
      if (now - v.firstAt > LOCK_WINDOW_MS && v.lockedUntil < now) loginAttempts.delete(k)
    }
  }
}

export function recordLoginSuccess(req: Request): void {
  loginAttempts.delete(clientKey(req))
}

export async function loginAdmin(
  req: Request,
  username: string,
  password: string,
): Promise<string | null> {
  if (loginLockRemaining(req) > 0) return null
  const creds = await loadCredentials()
  if (!creds) return null
  const ok = creds.username === username && verifyPassword(password, creds.passwordHash)
  if (!ok) {
    recordLoginFailure(req)
    return null
  }
  recordLoginSuccess(req)
  return signAdminToken()
}
