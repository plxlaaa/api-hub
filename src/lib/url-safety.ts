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
 *
 * 两层校验：
 * - checkUpstreamUrl（同步，纯字面量）：保存/导入时的快速校验，可直接单测
 * - checkUpstreamUrlWithDns（异步，追加 DNS 解析）：额外挡住「域名解析到内网」的绕过
 */

import dns from 'node:dns'

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

/**
 * 判断一个已解析的 IP 字面量是否属于「不可出网」的目标。
 *
 * 与 PRIVATE_HOST_PATTERNS 的区别：那个只对 hostname 做字符串匹配，
 * 挡不住「域名解析到内网」的情况 —— 例如把 baseUrl 填成
 * `http://foo.example.com`，而该域名A 记录指向 127.0.0.1 或 169.254.169.254。
 * 这类绕过在真实渗透里最常见，所以补一层「按解析结果判断」。
 *
 * 覆盖：IPv4 回环/私有/链路本地/保留段、IPv6 回环与唯一本地地址、IPv4-mapped IPv6
 * （::ffff:127.0.0.1 这类混写写法是绕过 IPv4 校验的经典手法）。
 */
export function isBlockedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '')
  // IPv4-mapped IPv6：先剥掉 ::ffff: 前缀再按 IPv4 判，否则会漏过 ::ffff:127.0.0.1
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  const v4 = mapped ? mapped[1] : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(addr) ? addr : null

  if (v4) {
    const parts = v4.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false // 不是合法 IP，交给调用方处理
    const [a, b] = parts
    if (a === 127) return true // 回环
    if (a === 10) return true // 私有 10/8
    if (a === 172 && b >= 16 && b <= 31) return true // 私有 172.16/12
    if (a === 192 && b === 168) return true // 私有 192.168/16
    if (a === 169 && b === 254) return true // 链路本地（含云元数据 169.254.169.254）
    if (a === 0) return true // 「本网络」，0.0.0.0 会被当作当前主机
    if (a >= 224) return true // 组播与保留段
    return false
  }

  // IPv6
  if (addr === '::1' || addr === '::') return true
  // fe80::/10 链路本地、fc00::/7 唯一本地
  if (/^fe[89ab]/.test(addr)) return true
  if (/^f[cd]/.test(addr)) return true
  return false
}

/**
 * 校验上游地址并把「域名解析到内网」这一类绕过也挡住。
 *
 * 用在「管理端保存渠道 / 探测 / 拉模型列表」这类低频路径上——
 * 每次只做一次 DNS 解析，不在网关转发热路径上，所以没有性能顾虑。
 * 解析失败（离线环境、DNS 抖动）时放行：此时无法判定，
 * 交给后续真实请求去失败，比在保存阶段直接把人挡在门外更合理。
 *
 * @param input 用户填写的 baseUrl
 * @param allowInternal 是否显式允许内网地址（来自渠道 metadata/备注）
 */
export async function checkUpstreamUrlWithDns(input: string, allowInternal = false): Promise<UrlCheckResult> {
  const basic = checkUpstreamUrl(input, allowInternal)
  if (!basic.ok) return basic
  if (allowInternal) return basic // 已显式放行，不再解析

  let hostname: string
  try {
    hostname = new URL(basic.url).hostname
  } catch {
    return basic // checkUpstreamUrl 已保证可解析，这里兜底
  }
  // 纯 IP 字面量在上一层已按字符串规则拦过，无需再查 DNS
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) {
    return isBlockedIp(hostname)
      ? { ok: false, reason: `内网地址 ${hostname} 被拒绝（防止 SSRF）。若确需内网渠道，请在该渠道备注中加 allowInternal: true` }
      : basic
  }

  try {
    const records = await dns.promises.lookup(hostname, { all: true })
    const blocked = records.find((r) => isBlockedIp(r.address))
    if (blocked) {
      return {
        ok: false,
        reason: `域名 ${hostname} 解析到内网地址 ${blocked.address}，已拒绝（防止 SSRF 绕过）。若确需内网渠道，请在该渠道备注中加 allowInternal: true`,
      }
    }
  } catch {
    // DNS 解析失败不在这里阻断：保存阶段无法判定，交给真实请求失败并暴露真实原因
    return basic
  }
  return basic
}