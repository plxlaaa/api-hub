import { SignJWT, jwtVerify } from 'jose'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { loadCredentials, saveCredentials } from '@/lib/credentials'
import { checkRateLimit, hitRateLimit, resetRateLimit } from '@/lib/rate-limit'
import { resolveRequestId, jsonUnauthorized } from '@/lib/api-response'

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
  if (!token) return unauthorized(req)
  try {
    // 显式限定算法：不给 algorithms 时 jwtVerify 会按 token 头里的 alg 尝试验签，
    // 存在算法混淆风险（如 alg=none 或非对称算法误配）
    await jwtVerify(token, await getJwtSecret(), { algorithms: ['HS256'] })
    return null
  } catch {
    return unauthorized(req)
  }
}

/** 401 统一出口：带 X-Request-Id 响应头与 requestId 字段，便于客户端报错与服务端日志对上 */
export function unauthorized(req?: Request): Response {
  return jsonUnauthorized(req ? resolveRequestId(req) : undefined)
}

// ---------- 初始化 / 登录 ----------

export async function setupAdmin(username: string, password: string): Promise<string> {
  await saveCredentials({ username, passwordHash: hashPassword(password) })
  return signAdminToken()
}

// ---------- 登录防爆破（同宝塔/1Panel 策略：连续失败 5 次锁定 10 分钟） ----------

const LOCK_THRESHOLD = 5
const LOCK_WINDOW_MS = 10 * 60_000

function clientKey(req: Request): string {
  // 只信 x-real-ip（反向代理覆盖写入，客户端无法伪造）。
  // 刻意不信任 x-forwarded-for：任何人都能自带该头，随意改首段 IP 即可绕过锁定，
  // 限流就形同虚设。Caddyfile 已配置 header_up X-Real-IP {remote_host}。
  const realIp = req.headers.get('x-real-ip') || ''
  return (realIp.split(',')[0].trim() || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local').slice(0, 64)
}

/** 检查该 IP 是否被锁定；返回剩余秒数（0 = 未锁定） */
export function loginLockRemaining(req: Request): number {
  const r = checkRateLimit(`login:${clientKey(req)}`, { windowMs: LOCK_WINDOW_MS, max: LOCK_THRESHOLD })
  return r.ok ? 0 : Math.ceil(r.retryAfterMs / 1000)
}

export function recordLoginFailure(req: Request): void {
  // 滑动窗口：窗口内第 5 次失败即触发锁定，无需额外维护计数器
  hitRateLimit(`login:${clientKey(req)}`, { windowMs: LOCK_WINDOW_MS, max: LOCK_THRESHOLD })
}

export function recordLoginSuccess(req: Request): void {
  resetRateLimit(`login:${clientKey(req)}`)
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
