import { SignJWT, jwtVerify } from 'jose'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'

const SETTING_PASSWORD = 'adminPasswordHash'
const SETTING_JWT_SECRET = 'jwtSecret'
const TOKEN_EXPIRES = '30d'

// ---------- Setting 存取 ----------

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
  return (await getSetting(SETTING_PASSWORD)) !== null
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

// ---------- 管理端鉴权 guard ----------

export async function requireAdmin(req: Request): Promise<Response | null> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
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

export async function setupAdmin(password: string): Promise<string> {
  await setSetting(SETTING_PASSWORD, hashPassword(password))
  return signAdminToken()
}

// ---------- 登录防爆破（内存滑动窗口：连续失败 5 次锁定 15 分钟） ----------

const LOCK_THRESHOLD = 5
const LOCK_WINDOW_MS = 15 * 60_000
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

export async function loginAdmin(req: Request, password: string): Promise<string | null> {
  if (loginLockRemaining(req) > 0) return null
  const stored = await getSetting(SETTING_PASSWORD)
  const ok = stored !== null && verifyPassword(password, stored)
  if (!ok) {
    recordLoginFailure(req)
    return null
  }
  recordLoginSuccess(req)
  return signAdminToken()
}
