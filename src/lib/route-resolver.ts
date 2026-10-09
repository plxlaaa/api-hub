/**
 * 路由匹配引擎 v2 —— 把「请求的模型名 + 调用方身份」解析为一条具体路由。
 *
 * 匹配顺序（特异性降级）：
 *   1. 精确匹配 displayName            特异性 1_000_000
 *   2. 正则路由 displayName="re:xxx"   特异性 500_000 + 模式长度（越具体越优先）
 *   3. 前缀通配 displayName="gpt-*"    特异性 300_000 + 前缀长度（最长前缀优先）
 *   4. 兜底路由 displayName="*"        特异性 0
 *
 * 每一层内再用 metadata.priority 决胜（数字大者胜，缺省 0），再平按创建时间。
 *
 * 密钥准入：路由 metadata.allowTokens（token 名白名单，空=不限）/ denyTokens（黑名单）。
 * 命中但被准入拒绝的路由会被跳过，继续尝试更低特异性的路由 —— 这样可以给不同
 * 密钥配不同的降级链（如「内部 Key 才能用 claude-*，外部 Key 落到兜底廉价渠道」）。
 * 全部命中路由都被拒 → denied（调用方应看到 403 而非 404，明确告知是被拦不是没这模型）。
 */

/** 路由解析所需的最小路由形状（ModelRoute / 预览 DTO 均可） */
export interface RoutableLike {
  displayName: string
  metadata?: unknown
  createdAt?: Date
}

export interface RouteMatchContext {
  /** 调用方统一密钥名（用于 allow/denyTokens 准入判断；管理测试传 '（管理测试）'） */
  tokenName?: string
}

export type RouteResolution<T extends RoutableLike> =
  | { kind: 'matched'; route: T; reason: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'none'; reason: string }

const SPEC_EXACT = 1_000_000
const SPEC_REGEX = 500_000
const SPEC_PREFIX = 300_000

/** 正则模式长度上限：防手滑写出超大模式拖慢热路径（管理台自用，无 ReDoS 攻击面） */
const MAX_REGEX_LEN = 100

interface Scored<T extends RoutableLike> {
  route: T
  spec: number
  priority: number
  createdAtMs: number
}

function routePriority(r: RoutableLike): number {
  const m = (r.metadata ?? {}) as Record<string, unknown>
  const v = Number(m.priority)
  return Number.isFinite(v) ? v : 0
}

/** metadata 里的 token 名集合：支持 string[]（数组）与逗号分隔字符串（API/UI 友好，兼容中英文逗号） */
function tokenList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  return []
}

/** 密钥准入检查：返回 true=放行 */
export function tokenAllowed(r: RoutableLike, tokenName?: string): boolean {
  const m = (r.metadata ?? {}) as Record<string, unknown>
  // denyTokens 黑名单优先于 allowTokens
  const deny = tokenList(m.denyTokens)
  if (tokenName && deny.includes(tokenName)) return false
  const allow = tokenList(m.allowTokens)
  if (allow.length === 0) return true // 空 = 不限
  return tokenName ? allow.includes(tokenName) : false
}

/**
 * 把一组路由解析为唯一命中。
 * 纯函数（除 Date.now 排序稳定化外无 IO），可直接单测。
 */
export function resolveRoute<T extends RoutableLike>(
  routes: T[],
  requestedModel: string,
  ctx: RouteMatchContext = {}
): RouteResolution<T> {
  const scored: Scored<T>[] = []

  for (const r of routes) {
    const name = r.displayName
    if (name === '*') {
      scored.push({ route: r, spec: 0, priority: routePriority(r), createdAtMs: r.createdAt?.getTime() ?? 0 })
      continue
    }
    if (name === requestedModel) {
      scored.push({ route: r, spec: SPEC_EXACT, priority: routePriority(r), createdAtMs: r.createdAt?.getTime() ?? 0 })
      continue
    }
    if (name.startsWith('re:') && name.length > 3) {
      const pattern = name.slice(3)
      if (pattern.length > MAX_REGEX_LEN) continue
      try {
        // 完整匹配语义：客户端请求的模型名应整体符合模式，而非局部包含
        if (new RegExp(pattern, 'i').test(requestedModel)) {
          scored.push({
            route: r,
            spec: SPEC_REGEX + pattern.length,
            priority: routePriority(r),
            createdAtMs: r.createdAt?.getTime() ?? 0,
          })
        }
      } catch {
        continue // 非法正则按未命中处理（预览侧会提示）
      }
      continue
    }
    if (name.endsWith('*') && name.length > 1) {
      const prefix = name.slice(0, -1)
      if (requestedModel.startsWith(prefix)) {
        scored.push({
          route: r,
          spec: SPEC_PREFIX + prefix.length,
          priority: routePriority(r),
          createdAtMs: r.createdAt?.getTime() ?? 0,
        })
      }
    }
  }

  if (scored.length === 0) {
    return { kind: 'none', reason: `模型 "${requestedModel}" 不存在或未启用（可配置 "gpt-*" 前缀通配、"re:xxx" 正则或 "*" 兜底路由承接）` }
  }

  // 特异性降序 → priority 降序 → 创建时间升序（老的先上，行为可预期）
  scored.sort((a, b) => b.spec - a.spec || b.priority - a.priority || a.createdAtMs - b.createdAtMs)

  // 按特异性顺序尝试准入；被拒的记下来，全被拒时报 403 语义
  const deniedHits: string[] = []
  for (const s of scored) {
    if (tokenAllowed(s.route, ctx.tokenName)) {
      return { kind: 'matched', route: s.route, reason: matchReason(s.route, requestedModel) }
    }
    deniedHits.push(s.route.displayName)
  }
  return {
    kind: 'denied',
    reason: `模型 "${requestedModel}" 命中的路由（${deniedHits.join('、')}）不允许当前密钥使用（路由配置了密钥准入名单）`,
  }
}

function matchReason(route: RoutableLike, requestedModel: string): string {
  const name = route.displayName
  if (name === requestedModel) return '精确匹配'
  if (name === '*') return '兜底路由'
  if (name.startsWith('re:')) return `正则 /${name.slice(3)}/i`
  return `前缀 "${name.slice(0, -1)}*"`
}

/**
 * 上游状态码是否应该计入熔断（failStreak）——「智能熔断」判定核心。
 *
 * 原则：只有「渠道自身的问题」才惩罚渠道，客户端造成的错误不背锅 ——
 * 否则一个写错请求体的客户端能把所有渠道连续打挂熔断。
 *
 *  - 计入（渠道侧问题）：5xx（上游崩）、401/403（该渠道 Key 失效/无权限）、408（上游超时）
 *  - 不计入：400/422（请求体本身错，换谁都是这个错）、404（通配路由发了上游没有的模型，
 *    多为模型映射配置问题，不该把渠道打挂）、429（上游限流是瞬时的，惩罚会误伤）
 */
export function shouldTripBreaker(statusCode: number): boolean {
  if (statusCode >= 500) return true
  return statusCode === 401 || statusCode === 403 || statusCode === 408
}
