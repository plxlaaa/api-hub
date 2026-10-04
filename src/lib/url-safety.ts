/**
 * 上游地址（baseUrl）安全校验 —— 防 SSRF。
 *
 * baseUrl 是管理员填写的字符串，随后由服务端 fetch 主动出网请求。若允许任意地址，
 * 管理员（或拿到管理会话的人）可以让服务器请求内网服务、云元数据接口（169.254.169.254
 * 取云厂商临时凭据）等敏感目标。虽属「自己配自己」的部署，但管理会话可能因 XSS /
 * Cookie 泄露被他人利用，边界不能只靠信任。
 *
 * 策略：默认拒绝私有网段与危险协议；确有内网自建渠道的场景用 metadata.allowInternal
 * 显式放行（管理台渠道备注里可写 allowInternal: true）。
 */

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\./i,
  /^metadata$/i,
]

/**
 * 危险协议黑名单：file: / gopher: / data: / ftp: / dict: 等。
 *
 * 必须在校验「是否补 https:// 前缀」之前拦掉，否则 `file:///etc/passwd` 会被
 * 补成 `https://file:///etc/passwd` —— new URL() 解析后 hostname 竟成了 "file"，
 * 协议检查形同虚设（实测确认过这个绕过路径）。
 */
const DANGEROUS_SCHEME_RE = /^\s*(file|gopher|data|ftp|dict|ldap|ldapjs|sftp|ssh|netdoc|jar|mailto|about|blob)\s*:/i

/**
 * 是否「已有显式协议」。
 *
 * 不能简单判断 `raw.includes('://')` —— 像 `http://`（有协议但无主机）、
 * `foo://bar` 这类畸形输入都会被误判。更稳的做法是探测任意 `xxx:` 前缀：
 * 只要冒号前是合法 scheme 的一部分，就认为用户写了协议（哪怕写错了），
 * 此时不该再补 https://，而应交给下面的协议校验去报错。
 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+\-.]*:/i

export type UrlCheckResult =
  | { ok: true; url: string }
  | { ok: false; reason: string }

/**
 * 校验并规范化上游地址。
 * @param input 用户填写的 baseUrl
 * @param allowInternal 是否显式允许内网地址（来自渠道 metadata）
 */
export function checkUpstreamUrl(input: string, allowInternal = false): UrlCheckResult {
  let raw = (input || '').trim().replace(/\/+$/, '')
  if (!raw) return { ok: false, reason: '地址为空' }

  // 1) 先拦危险协议（必须在补协议前缀之前，否则 file:///etc/passwd 会被
  //    补成 https://file:///etc/passwd，hostname 竟解析成 "file" 而绕过检查）
  if (DANGEROUS_SCHEME_RE.test(raw)) {
    const scheme = raw.match(DANGEROUS_SCHEME_RE)?.[1] || ''
    return { ok: false, reason: `不支持的协议 ${scheme}:（仅允许 http/https）` }
  }

  // 2) 用户写了任意协议就按原样解析（协议对不对由下面判定）；
  //    没写才补 https://。用 HAS_SCHEME_RE 而非 includes('://')，否则
  //    "http://" 这类「有协议无主机」的畸形输入会被补成 https://http://。
  if (!HAS_SCHEME_RE.test(raw)) raw = `https://${raw}`

  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: '不是合法 URL' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `不支持的协议 ${u.protocol.replace(':', '')}:（仅允许 http/https）` }
  }
  if (!u.hostname) return { ok: false, reason: '缺少主机名' }

  // 3) 主机名合法性：hostname 为空/含非法字符都要拒绝
  //    （覆盖 "https://file:///x" → hostname="file"、双斜杠、含空格等）
  const host = u.hostname.toLowerCase()
  const isIPv6 = host.startsWith('[')
  if (!isIPv6 && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)) {
    return { ok: false, reason: `主机名不合法：${host || '(空)'}` }
  }

  if (!allowInternal) {
    for (const re of PRIVATE_HOST_PATTERNS) {
      if (re.test(host)) {
        return {
          ok: false,
          reason: `内网地址 ${host} 被拒绝（防止 SSRF）。若确需内网渠道，请在该渠道备注中加 allowInternal: true`,
        }
      }
    }
  }
  return { ok: true, url: raw }
}

/** 从渠道 metadata 读取 allowInternal 开关 */
export function allowsInternalUrl(metadata: unknown): boolean {
  const m = (metadata ?? {}) as Record<string, unknown>
  return m.allowInternal === true || m.allowInternal === 'true' || m.allowInternal === 1
}