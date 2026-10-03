import { promises as fs, chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'

// 凭据文件位置：项目根目录下的 db/ 目录（与 SQLite 同目录，均为本机文件）
// 明文密码永不落盘，只存 scrypt 哈希；文件权限会收紧为仅当前用户可读写。
const CREDENTIALS_DIR = path.resolve(process.cwd(), 'db')
export const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, 'credentials.env')
export const SETUP_TOKEN_PATH = path.join(CREDENTIALS_DIR, 'setup-token.txt')
const DB_PASSWORD_KEY = 'adminPasswordHash'

export interface Credentials {
  username: string
  passwordHash: string // scrypt "salt:hash"
}

// 简单 KEY=VALUE 解析（不引入 dotenv 依赖，保持零额外体量）
function parse(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const k = line.slice(0, idx).trim()
    let v = line.slice(idx + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

export async function loadCredentials(): Promise<Credentials | null> {
  // 1) 优先读取本地凭据文件
  try {
    const data = parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'))
    if (data.ADMIN_USERNAME && data.ADMIN_PASSWORD_HASH) {
      return { username: data.ADMIN_USERNAME, passwordHash: data.ADMIN_PASSWORD_HASH }
    }
  } catch {
    // 文件不存在或损坏，进入迁移分支
  }
  // 2) 迁移：旧版把管理密码存在 SQLite，这里自动写到本地凭据文件（默认用户名 admin）
  //    保证已有部署在升级后不会被锁在登录页外。
  try {
    const row = await db.setting.findUnique({ where: { key: DB_PASSWORD_KEY } })
    if (row?.value) {
      const creds: Credentials = { username: 'admin', passwordHash: row.value }
      await saveCredentials(creds)
      return creds
    }
  } catch {
    // 忽略迁移失败（例如库尚未初始化）
  }
  return null
}

// 收紧文件权限：Linux/macOS → 600；Windows → icacls 仅当前用户可读写
function hardenPermissions(file: string): void {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME || process.env.USER || 'SYSTEM'
      execSync(`icacls "${file}" /inheritance:r /grant:r "${user}:(R,W)"`, { stdio: 'ignore' })
    } else {
      chmodSync(file, 0o600)
    }
  } catch {
    // 权限加固失败不阻断；文件内容本身只是哈希/一次性令牌
  }
}

export async function saveCredentials(creds: Credentials): Promise<void> {
  mkdirSync(CREDENTIALS_DIR, { recursive: true })
  const content = [
    '# API Hub 管理员凭据（本机文件，明文密码不落盘，仅存 scrypt 哈希）',
    `ADMIN_USERNAME=${creds.username}`,
    `ADMIN_PASSWORD_HASH=${creds.passwordHash}`,
    '',
  ].join('\n')
  await fs.writeFile(CREDENTIALS_PATH, content, { encoding: 'utf8', mode: 0o600 })
  hardenPermissions(CREDENTIALS_PATH)
}

// ---------- 一次性设置令牌（防抢注：首启生成，仅本机可见，建号后即焚） ----------

export async function getSetupToken(): Promise<string | null> {
  try {
    const t = (await fs.readFile(SETUP_TOKEN_PATH, 'utf8')).trim()
    return t || null
  } catch {
    return null
  }
}

/**
 * 服务器启动时调用：若尚未初始化管理员，则生成一次性设置令牌（落盘 + 控制台打印）。
 * 已初始化则清理可能残留的令牌。令牌只在本机可读，网络无法获取。
 */
export async function ensureSetupTokenOnBoot(): Promise<void> {
  const creds = await loadCredentials()
  if (creds) {
    await fs.rm(SETUP_TOKEN_PATH, { force: true }).catch(() => {})
    return
  }
  if (await getSetupToken()) return
  const token = randomBytes(24).toString('base64url') // 32 字符
  mkdirSync(CREDENTIALS_DIR, { recursive: true })
  await fs.writeFile(SETUP_TOKEN_PATH, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  hardenPermissions(SETUP_TOKEN_PATH)
  console.log(
    '\n[API Hub] ================================================\n' +
      '[API Hub] 首次设置令牌（仅本机可见，请在创建管理员账号时粘贴）：\n' +
      `[API Hub]   ${token}\n` +
      `[API Hub] 也可在文件 db/setup-token.txt 中查看。\n` +
      '[API Hub] ================================================\n'
  )
}

/** 常量时间校验设置令牌 */
export async function verifySetupToken(input: string): Promise<boolean> {
  const t = await getSetupToken()
  if (!t || !input) return false
  const a = Buffer.from(t)
  const b = Buffer.from(input.trim())
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 建号成功后焚毁令牌（一次性） */
export async function consumeSetupToken(): Promise<void> {
  await fs.rm(SETUP_TOKEN_PATH, { force: true }).catch(() => {})
}
