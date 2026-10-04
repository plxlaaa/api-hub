/**
 * 敏感信息脱敏（后端共用）。
 *
 * 上游返回的错误体常常回显调用方传入的凭据（例如 "Invalid API key: sk-xxx"），
 * 或包含内网地址。这些内容既会写进 RequestLog.error，也会拼进 502 响应体返回给网关调用方，
 * 等于把上游密钥泄漏给任何持有网关统一 Key 的人。统一在此处收敛处理。
 */

/** 掩码字符串，保留首尾少量字符便于肉眼定位，不足以被复用 */
function mask(secret: string): string {
  if (secret.length <= 8) return '***'
  return `${secret.slice(0, 3)}***${secret.slice(-2)}`
}

/**
 * 替换函数签名：与 String.replace 的回调一致（匹配串 + 捕获组）。
 * 捕获组数量各模式不同，用 rest 参数统一接收。
 */
type Replacer = (match: string, ...groups: string[]) => string

/** 常见密钥形态：sk-/sk-ant-/gsk_/AIza/eyJ(JWT) 等，长度 8 以上才处理，避免误伤普通单词 */
const KEY_PATTERNS: Array<[RegExp, Replacer]> = [
  // "Authorization: Bearer xxx" / "bearer xxx"：保留前缀，只掩码凭据本身
  [/\b(bearer\s+)([A-Za-z0-9._\-]{8,})/gi, (_m, p1, p2) => `${p1}${mask(p2)}`],
  // sk-xxx / sk-ant-xxx（OpenAI、Anthropic 风格）
  [/\bsk-[A-Za-z0-9_\-]{8,}/g, (m) => mask(m)],
  // Google API key
  [/\bAIza[A-Za-z0-9_\-]{10,}/g, (m) => mask(m)],
  // Google Cloud OAuth / 通用长 base64 串（>= 32 字符，规避短词误伤）
  [/\bya29\.[A-Za-z0-9._\-]{10,}/g, (m) => mask(m)],
  // 网关自身统一 Key
  [/\bsk-gw-[A-Za-z0-9_\-]{6,}/g, (m) => mask(m)],
  // JSON 里的 key 字段：{"api_key":"xxx"} / "authorization": "xxx"
  [/("?(?:api[_-]?key|apikey|access[_-]?token|authorization|password|secret)"?\s*[:=]\s*"?)([A-Za-z0-9._\-]{8,})"?/gi,
    (_m, p1, p2) => `${p1}"${mask(p2)}"`],
]

/** 内网/本机地址：这类信息对排障无用，且会暴露内网拓扑 */
const INTERNAL_URL_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost)(?::\d+)?/gi, 'http://<内网地址>'],
  [/https?:\/\/\[?::1\]?(?::\d+)?/gi, 'http://<内网地址>'],
  [/https?:\/\/0\.0\.0\.0(?::\d+)?/gi, 'http://<内网地址>'],
  // 私有网段与云元数据地址
  [/https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?/gi, 'http://<内网地址>'],
  [/https?:\/\/169\.254\.169\.254(?::\d+)?/g, 'http://<内网地址>'],
  // IPv6 私有 fe80::/fc00::
  [/https?:\/\/[fF][eE]80:[0-9a-fA-F:]*(:\d+)?/g, 'http://<内网地址>'],
  [/https?:\/\/[fF][cCdD][0-9a-fA-F]{2}:[0-9a-fA-F:]*(:\d+)?/g, 'http://<内网地址>'],
]

/**
 * 脱敏任意文本（上游错误体、异常消息等）。
 * 会掩码密钥形态并抹掉内网地址，长度超过 limit 时截断。
 */
export function redactSecrets(input: unknown, limit = 300): string {
  let s = input == null ? '' : typeof input === 'string' ? input : String(input)
  for (const [re, rep] of KEY_PATTERNS) s = s.replace(re, rep)
  for (const [re, rep] of INTERNAL_URL_PATTERNS) s = s.replace(re, rep)
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}