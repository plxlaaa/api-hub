import { db } from '@/lib/db'
import { upstreamUrl, altUpstreamUrl, probeChannelById } from '@/lib/probe'
import { parseChannelConfigs, type ChannelConfig } from '@/lib/route-config'
import { orderCandidates, type RouteStrategy } from '@/lib/route-order'
import type { OpenAIBody } from '@/lib/anthropic'
import { getAdapter, resolveChatEndpoint } from '@/lib/adapters'
import { redactSecrets } from '@/lib/redact'
import { hitRateLimit } from '@/lib/rate-limit'
import { log, withRequestId } from '@/lib/logger'
import { resolveRequestId, openAiError } from '@/lib/api-response'
import { resolveRoute, shouldTripBreaker } from '@/lib/route-resolver'
import { getEnabledRoutes, invalidateRouteCache, logCacheHitOnce } from '@/lib/route-cache'

const UPSTREAM_TIMEOUT_MS = 300_000 // 长回答 / 长流式给足时间
const MAX_REQUEST_LOGS = 2000
/** 请求体大小上限：聊天请求正常在百 KB 级，10MB 足够宽松又能挡住超大 body 打内存 */
const MAX_BODY_BYTES = 10 * 1024 * 1024
/** 单把统一 Key 的默认限速（次/分钟）。可在 metadata.rateLimitPerMin 单独覆盖，0 = 不限 */
const DEFAULT_RATE_LIMIT_PER_MIN = 60

interface UpstreamBody {
  [key: string]: unknown
  model?: string
  stream?: boolean
}

/** 转发失败联动熔断：真实调用连续失败达到阈值 → 自动摘除（探测恢复后自动加回）。
 *  trip=false 时只记录 lastError 不累计 failStreak（用于客户端侧/瞬时错误，判定见 shouldTripBreaker）。 */
async function recordForwardFailure(channelId: string, errorMsg: string, trip = true): Promise<void> {
  try {
    if (!trip) {
      await db.channel
        .update({ where: { id: channelId }, data: { lastError: redactSecrets(errorMsg, 300) } })
        .catch(() => {})
      return
    }
    const [cbOn, cbThreshold] = await Promise.all([
      db.setting.findUnique({ where: { key: 'circuitBreaker' } }),
      db.setting.findUnique({ where: { key: 'cbThreshold' } }),
    ])
    if (cbOn?.value === 'off') return
    // 原子自增，避免与探测侧的陈旧读-绝对值回写互相覆盖
    const updated = await db.channel.update({
      where: { id: channelId },
      data: { failStreak: { increment: 1 }, lastError: redactSecrets(errorMsg, 300) },
      select: { failStreak: true, autoDisabled: true, name: true },
    })
    const threshold = Math.max(1, Number(cbThreshold?.value ?? 3) || 3)
    if (!updated.autoDisabled && updated.failStreak >= threshold) {
      // 条件更新：只有仍处于「未熔断」状态才摘除，防止与探测侧并发重复摘除
      await db.channel
        .updateMany({
          where: { id: channelId, autoDisabled: false },
          data: { autoDisabled: true, autoDisabledAt: new Date() },
        })
        .catch(() => {})
      log.warn('渠道连续调用失败，已自动熔断摘除', {
        channelId: channelId,
        channel: updated.name,
        failStreak: updated.failStreak,
        threshold,
      })
    }
  } catch {
    /* 熔断联动失败不影响转发主流程 */
  }
}

/** 转发成功：清零失败计数（熔断中的渠道不会被选中，恢复仍由探测驱动） */
async function recordForwardSuccess(channelId: string): Promise<void> {
  try {
    await db.channel.updateMany({ where: { id: channelId, failStreak: { not: 0 } }, data: { failStreak: 0 } })
  } catch {
    /* 忽略 */
  }
}

/** 记录调用日志（异步，不阻塞响应；偶尔顺带清理旧日志） */
async function logRequest(data: {
  channelName: string
  model: string
  targetModel: string
  ok: boolean
  statusCode?: number | null
  latencyMs?: number | null
  totalTokens?: number | null
  tokenName?: string | null
  stream?: boolean
  attempt?: number
  error?: string | null
}): Promise<void> {
  try {
    await db.requestLog.create({
      data: {
        channelName: data.channelName,
        model: data.model,
        targetModel: data.targetModel,
        ok: data.ok,
        statusCode: data.statusCode ?? null,
        latencyMs: data.latencyMs ?? null,
        totalTokens: data.totalTokens ?? null,
        tokenName: data.tokenName ?? null,
        stream: data.stream ?? false,
        attempt: data.attempt ?? 1,
        error: data.error ?? null,
      },
    })
    // 概率触发清理（1/20）：高频路径上每条都 count/排序会明显拖慢写入，
    // 且清理只需最终收敛，无需每次精确。
    if (Math.random() < 0.05) await pruneRequestLogs()
  } catch (err) {
    log.error('写入调用日志失败', { error: err })
  }
}

/**
 * 裁剪调用日志到 MAX_REQUEST_LOGS 条。
 *
 * 只取「倒数第 MAX_REQUEST_LOGS 条」那一条的时间戳作为分界，再用一条
 * deleteMany 按 createdAt 之前删除。此前是
 * `count()` + `findMany({ skip: MAX })` + `deleteMany({ id: { in: [...] } })`：
 * 1) count() 每次全表扫；
 * 2) skip 2000 行在 SQLite 上要真实扫过并丢弃前 2000 行；
 * 3) deleteMany 的 IN 列表可能上千个 id，SQL 文本巨大且易触及变量数上限。
 * 现固定为 2 条查询，开销与表大小基本无关。
 */
async function pruneRequestLogs(): Promise<void> {
  try {
    // 倒数第 MAX_REQUEST_LOGS 条；返回 null 表示未超上限，无需清理
    const boundary = await db.requestLog.findFirst({
      orderBy: { createdAt: 'desc' },
      skip: MAX_REQUEST_LOGS,
      select: { createdAt: true },
    })
    if (!boundary) return
    const { count } = await db.requestLog.deleteMany({
      where: { createdAt: { lt: boundary.createdAt } },
    })
    if (count > 0) log.debug('调用日志已裁剪', { deleted: count, keep: MAX_REQUEST_LOGS })
  } catch (err) {
    // 清理失败不影响主流程，后续随机触发时会重试
    log.warn('调用日志清理失败（继续运行）', { error: err })
  }
}

/** 校验统一调用密钥，返回 token 记录或 null */
async function authenticate(key: string) {
  if (!key) return null
  const token = await db.apiToken.findUnique({ where: { key } })
  return token && token.enabled ? token : null
}

/** 读取单把 Key 的限速阈值（次/分钟）；metadata.rateLimitPerMin，缺省 60，0 或非法 = 不限 */
function rateLimitPerMin(metadata: unknown): number {
  const m = (metadata ?? {}) as Record<string, unknown>
  const v = Number(m.rateLimitPerMin)
  if (!Number.isFinite(v) || v <= 0) return v === 0 ? 0 : DEFAULT_RATE_LIMIT_PER_MIN
  return Math.floor(v)
}

/**
 * 原子扣减配额并占用一次限速额度：一条 updateMany 同时完成「检查未超额」+「计数 +1」。
 * 并发下不会超发（SQLite 单写者语义保证 updateMany 的条件判断与写入是原子的）。
 *
 * @returns 成功返回 null；超配额返回 { kind:'quota' }；超限速返回
 *   { kind:'rate', retryAfterSec } —— 重试秒数取自限流器实测剩余窗口，
 *   而不是写死：写死会让客户端提前重试并再次被拒，形成重试风暴。
 */
async function consumeQuotaAndRate(
  token: { id: string; quotaLimit: number | null },
  perMin: number
): Promise<{ kind: 'quota' } | { kind: 'rate'; retryAfterSec: number } | null> {
  if (perMin > 0) {
    const rl = hitRateLimit(`gw:${token.id}`, { windowMs: 60_000, max: perMin })
    if (!rl.ok) {
      // 向上取整并至少 1s，避免算出 0 秒让客户端立刻重试
      return { kind: 'rate', retryAfterSec: Math.max(1, Math.ceil(rl.retryAfterMs / 1000)) }
    }
  }
  if (token.quotaLimit === null) return null
  const res = await db.apiToken.updateMany({
    where: { id: token.id, quotaUsed: { lt: token.quotaLimit } },
    data: { quotaUsed: { increment: 1 }, lastUsedAt: new Date() },
  })
  if (res.count === 0) return { kind: 'quota' }
  return null
}

/**
 * 读取请求体并强制字节上限。
 * 不能直接用 req.text()/req.json()：content-length 可被伪造或缺失（chunked 传输），
 * 必须对实际读到的字节计数，超限立刻中断，避免超大 body 打满内存。
 */
async function readBodyWithLimit(req: Request, limit: number): Promise<string> {
  const body = req.body
  // 无 body 流（极端情况）→ 退化为空串，交给后续 JSON.parse 报错
  if (!body) return await req.text()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > limit) {
          // 超限：取消读取，不再消费剩余数据
          await reader.cancel().catch(() => {})
          throw new Error('__TOO_LARGE__')
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock?.()
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(merged)
}

/**
 * 统一网关：POST /v1/chat/completions
 * 1. 统一 Key 鉴权 + 限速 + 配额  2. 模型显示名 → 路由解析
 * 3. 按渠道优先级逐个转发，非 2xx 自动故障转移到下一渠道
 * 4. 上游响应原样透传（含 SSE 流式）；每次尝试写入调用日志
 */
export async function handleChatCompletions(
  req: Request,
  opts?: { adminOverride?: boolean }
): Promise<Response> {
  // 为本次请求分配 ID，并在整个处理链路（转发/熔断/写日志）内透传，
  // 这样一次调用产生的多条日志能被 requestId 串起来，便于排障。
  const requestId = resolveRequestId(req)
  const startedAt = Date.now()
  let res = await withRequestId(requestId, () => dispatchChatCompletions(req, opts, requestId))
  // 兜底补齐 X-Request-Id：下面各分支的错误响应有的带、有的不带，
  // 客户端若在早期失败（缺 model / 非法 JSON）就拿不到排障用的 ID。
  // 统一在这里补一次，已有同值则跳过（Headers.set 为覆盖写，值相同无副作用）。
  if (!res.headers.has('X-Request-Id')) {
    res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: withRequestIdHeader(res.headers, requestId) })
  }
  log.info('网关请求完成', {
    requestId,
    status: res.status,
    durationMs: Date.now() - startedAt,
    adminOverride: Boolean(opts?.adminOverride),
  })
  return res
}

/** 复制一份 Headers 并补上 X-Request-Id（不污染上游响应的原始头对象） */
function withRequestIdHeader(headers: Headers, requestId: string): Headers {
  const h = new Headers(headers)
  h.set('X-Request-Id', requestId)
  return h
}

/** 实际转发逻辑（由 handleChatCompletions 包装，注入 requestId 便于错误响应回传） */
async function dispatchChatCompletions(
  req: Request,
  opts: { adminOverride?: boolean } | undefined,
  requestId: string
): Promise<Response> {
  // 1. 鉴权（管理员测试模式跳过统一 Key，不消耗配额）
  const adminOverride = Boolean(opts?.adminOverride)
  let token: { id: string; name: string; quotaLimit: number | null; quotaUsed: number; metadata?: unknown }
  let perMin = 0
  if (adminOverride) {
    token = { id: '', name: '（管理测试）', quotaLimit: null, quotaUsed: 0 }
  } else {
    const auth = req.headers.get('authorization') || ''
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const t = await authenticate(key)
    if (!t) {
      //带上 requestId：鉴权失败同样要能与服务端日志对上（此前 401 唯独缺这个头）
      return openAiError('API Key 无效或已禁用（请使用网关统一 Key）', 'invalid_request_error', 401, { requestId })
    }
    token = t
    perMin = rateLimitPerMin(t.metadata)
  }

  // 2. 请求体大小上限：先看 content-length，再对流做实际字节计数（防 chunked 绕过）
  const declaredLen = Number(req.headers.get('content-length') || '0')
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return openAiError(
      `请求体过大（${(declaredLen / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_BODY_BYTES / 1024 / 1024}MB`,
      'invalid_request_error',
      413
    )
  }

  // 3. 解析请求体
  let rawBody: string
  try {
    rawBody = await readBodyWithLimit(req, MAX_BODY_BYTES)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === '__TOO_LARGE__') {
      return openAiError(
        `请求体过大，上限 ${MAX_BODY_BYTES / 1024 / 1024}MB`,
        'invalid_request_error',
        413
      )
    }
    return openAiError('请求体不是合法 JSON', 'invalid_request_error', 400)
  }
  let body: UpstreamBody
  try {
    body = JSON.parse(rawBody) as UpstreamBody
  } catch {
    return openAiError('请求体不是合法 JSON', 'invalid_request_error', 400)
  }
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
  if (!requestedModel) return openAiError('缺少 model 字段', 'invalid_request_error', 400)

  // 4. 限速 + 配额原子扣减（放在模型解析之后，避免无效请求白吃配额）
  if (!adminOverride) {
    const verdict = await consumeQuotaAndRate(token, perMin)
    if (verdict?.kind === 'quota') {
      return openAiError(
        `配额已用尽：该 Key 已达上限 ${token.quotaLimit} 次请求，请在管理台调整配额`,
        'insufficient_quota',
        429,
        { requestId }
      )
    }
    if (verdict?.kind === 'rate') {
      return openAiError(
        `请求过于频繁：该 Key 限速 ${perMin} 次/分钟，请 ${verdict.retryAfterSec} 秒后重试`,
        'rate_limit_error',
        429,
        // Retry-After 用实测剩余窗口，客户端 SDK（OpenAI/Anthropic）据此自动退避
        { headers: { 'Retry-After': String(verdict.retryAfterSec) }, requestId }
      )
    }
  }

  // 5. 路由解析 v2（route-resolver）：精确 → 正则（re:xxx）→ 最长前缀（gpt-*）→ 兜底（*），
  //    同特异性按metadata.priority 决胜；密钥准入（allow/denyTokens）不通过则自动降级到下一候选
  //    路由表读多写少，走短 TTL 缓存（路由增删改时主动失效，见 lib/route-cache.ts）
  const enabledRoutes = await getEnabledRoutes()
  logCacheHitOnce()
  const resolved = resolveRoute(enabledRoutes, requestedModel, { tokenName: token.name })
  if (resolved.kind === 'none') {
    return openAiError(resolved.reason, 'invalid_request_error', 404)
  }
  if (resolved.kind === 'denied') {
    return openAiError(resolved.reason, 'permission_error', 403)
  }
  const route = resolved.route
  const routeMeta = (route.metadata ?? {}) as Record<string, unknown>
  // 故障转移上限：metadata.maxAttempts 限制最多试几个渠道（默认不限，全部候选）
  const maxAttemptsRaw = Number(routeMeta.maxAttempts)
  const maxAttempts = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw >= 1 ? Math.floor(maxAttemptsRaw) : Infinity
  if (resolved.reason !== '精确匹配') {
    log.info('路由命中', { requested: requestedModel, route: route.displayName, via: resolved.reason })
  }

  // 6. 渠道配置解析（渠道级模型映射 + 权重）；熔断中的渠道自动跳过
  const cfgs = parseChannelConfigs(route)
  if (cfgs.length === 0) {
    return openAiError(`模型 "${requestedModel}" 未配置渠道`, 'api_error', 502)
  }
  const channels = await db.channel.findMany({
    where: { id: { in: cfgs.map((c) => c.id) }, enabled: true, autoDisabled: false },
  })
  const byId = new Map(channels.map((c) => [c.id, c]))
  const candidates = cfgs
    .map((cfg) => ({ cfg, ch: byId.get(cfg.id) }))
    .filter((x): x is { cfg: ChannelConfig; ch: NonNullable<typeof x.ch> } => Boolean(x.ch))

  if (candidates.length === 0) {
    return openAiError(`模型 "${requestedModel}" 没有可用渠道（均已禁用或熔断中）`, 'api_error', 502)
  }

  // 负载均衡策略：按策略生成尝试顺序（与预览 API 共用同一实现）
  const { ordered } = await orderCandidates(candidates, route.strategy as RouteStrategy, {
    tokenKey: token.id || undefined,
    model: requestedModel,
  })

  // 7. 逐渠道转发（故障转移；每个渠道用自己映射的模型名）
  const isStream = Boolean(body.stream)
  const failures: string[] = []

  for (const [tryIdx, { cfg, ch }] of ordered.entries()) {
    // 故障转移上限：metadata.maxAttempts 限制最多实际尝试的渠道数（省时省日志，防止坏请求烧穿全部渠道）
    if (tryIdx >= maxAttempts) {
      log.info('已达路由故障转移上限，停止尝试更多渠道', { route: route.displayName, maxAttempts, tried: tryIdx })
      break
    }
    // 渠道级模型映射优先；路由 targetModel 为 "*" 时透传客户端请求的模型名（配合通配/兜底路由）
    const modelForChannel = cfg.model?.trim() || (route.targetModel === '*' ? requestedModel : route.targetModel)
    // 协议适配器：请求构造/头/响应转换全部由适配器负责（新协议注册即用，主流程零改动）
    const adapter = getAdapter(ch.apiFormat)
    const upstreamBody = adapter.buildRequestBody(body as OpenAIBody, modelForChannel)
    const start = Date.now()
    let res: Response
    const primaryUrl = upstreamUrl(ch.baseUrl, resolveChatEndpoint(adapter, modelForChannel, isStream))
    // 客户端断开时立刻中止上游请求：否则用户关页面后上游 SSE 仍会跑完，白烧上游额度并长期占连接。
    // AbortSignal.any 同时保留超时保护（任一信号触发即取消）。
    const upstreamSignal = AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
    try {
      // cache:'no-store' 绕过 Next fetch 补丁的响应缓存层（其 clone 缓存会锁定 body，透传时报 disturbed）
      res = await fetch(primaryUrl, {
        method: 'POST',
        headers: adapter.buildHeaders(ch.apiKey),
        body: upstreamBody,
        signal: upstreamSignal,
        cache: 'no-store',
      })
      // baseUrl 路径填错自愈：404 时用反向变体重试一次，成功则触发探测回写正确地址
      if (res.status === 404) {
        const altUrl = altUpstreamUrl(ch.baseUrl, resolveChatEndpoint(adapter, modelForChannel, isStream))
        if (altUrl !== primaryUrl) {
          // 关键：先把 404 的响应体读完留存，再释放连接。
          // 若直接 cancel，后续读 text() 会拿到空串，排障时只会看到「HTTP 404」而无任何线索。
          const notFoundBody = await res.text().catch(() => '')
          const altSignal = AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
          const r2 = await fetch(altUrl, {
            method: 'POST',
            headers: adapter.buildHeaders(ch.apiKey),
            body: upstreamBody,
            signal: altSignal,
            cache: 'no-store',
          }).catch(() => null)
          if (r2?.ok) {
            res = r2
            void probeChannelById(ch.id) // 异步：把自愈出的 baseUrl 回写库
          } else {
            // 变体重试也失败：把原始 404 的响应体挂回 res，让下面的错误分支能读到真实原因
            res = new Response(notFoundBody || '404 Not Found', { status: 404 })
          }
        } else {
          // 无变体可试：消费掉 body 释放连接
          void res.body?.cancel().catch(() => {})
        }
      }
    } catch (err) {
      // 客户端主动断开不是错误，无需重试后续渠道（用户已经不关心结果了）
      if (req.signal.aborted) {
        log.info('客户端已断开，中止对上游的转发', { channel: ch.name, model: requestedModel })
        return new Response(null, { status: 499 })
      }
      const msg = err instanceof Error
        ? (err.name === 'TimeoutError' ? `上游超时（${UPSTREAM_TIMEOUT_MS / 1000}s）` : redactSecrets(err.message, 200))
        : redactSecrets(err, 200)
      failures.push(`[${ch.name}] ${msg}`)
      const latencyMs = Date.now() - start
      void recordForwardFailure(ch.id, msg)
      void logRequest({ channelName: ch.name, model: requestedModel, targetModel: modelForChannel, ok: false, latencyMs, tokenName: token.name, stream: isStream, attempt: tryIdx + 1, error: msg })
      continue
    }

    if (!res.ok) {
      // 智能熔断：只有渠道侧问题（5xx/401/403/408）才累计 failStreak；
      // 客户端侧（400/422）、模型映射（404）、瞬时（429）只记 lastError 不惩罚渠道。
      const trip = shouldTripBreaker(res.status)
      // 上游错误体可能回显 Key（如 "Invalid API key: sk-xxx"）或暴露内网地址，
      // 必须脱敏后再进日志与返回体，避免把上游凭据泄漏给任何持有网关 Key 的调用方。
      const raw = await res.text().catch(() => '')
      const detail = redactSecrets(raw, 200)
      const msg = `HTTP ${res.status}${detail ? ` ${detail}` : ''}`
      failures.push(`[${ch.name}] ${msg}`)
      const latencyMs = Date.now() - start
      void recordForwardFailure(ch.id, msg, trip)
      void logRequest({ channelName: ch.name, model: requestedModel, targetModel: modelForChannel, ok: false, statusCode: res.status, latencyMs, tokenName: token.name, stream: isStream, attempt: tryIdx + 1, error: msg })
      continue
    }

    // 成功 → 透传（非 openai 协议：适配器转换响应；流式经适配器 SSE 转换器）
    // 注意：Next dev 的 fetch 补丁会在 clone() 后锁定 res.body，透传必须避免 clone
    void recordForwardSuccess(ch.id)
    const latencyMs = Date.now() - start // 首字节延迟（TTFB）
    let totalTokens: number | null = null
    let resBody: ReadableStream<Uint8Array> | null = res.body
    let contentType = res.headers.get('content-type') || 'application/json'
    if (isStream && adapter.transformStream) {
      resBody = res.body?.pipeThrough(adapter.transformStream(requestedModel)) ?? null
      contentType = 'text/event-stream'
    } else if (!isStream) {
      const text = await res.text()
      try {
        totalTokens = adapter.extractUsage(JSON.parse(text))
      } catch {
        /* usage 提取失败不影响转发 */
      }
      const converted = adapter.transformResponse ? adapter.transformResponse(text, requestedModel) : text
      resBody = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(converted))
          c.close()
        },
      })
    }

    // 配额已在入口原子扣减（consumeQuotaAndRate），此处不再重复自增，只补 lastUsedAt。
    // 管理员测试模式 token.id 为空，不落库。
    if (!adminOverride && token.id) {
      void db.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
    }

    const logBase = {
      channelName: ch.name,
      model: requestedModel,
      targetModel: modelForChannel,
      statusCode: res.status,
      tokenName: token.name,
      stream: isStream,
    }

    if (isStream && resBody) {
      // 流式：拿到上游响应头时还不知道「最终是否正常结束、用了多少 token」。
      // 套一层观察流：读到 done 时补写成功日志（含完整耗时与 usage），
      // 读取抛错或客户端中断时记录失败原因 —— 否则流式失败在日志里完全不可见。
      let seen = 0
      let streamTokens: number | null = null
      let streamText = ''
      let settled = false
      const reader = resBody.getReader()
      resBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              settled = true
              controller.close()
              void logRequest({
                ...logBase,
                ok: true,
                latencyMs: Date.now() - start, // 流式：记录完整耗时而非 TTFB
                totalTokens: streamTokens,
                attempt: tryIdx + 1,
              })
              return
            }
            if (value) {
              seen += value.byteLength
              // 尝试从 SSE 增量里捞 usage（OpenAI 兼容协议在末帧带 usage）
              if (streamTokens === null && value.byteLength < 64 * 1024) {
                try {
                  streamText += new TextDecoder().decode(value)
                  const m = streamText.match(/"usage"\s*:\s*\{[^{}]*\}/g)
                  if (m?.length) {
                    const u = JSON.parse(m[m.length - 1].replace(/"usage"\s*:\s*/, ''))
                    const total = Number(u.total_tokens ?? (Number(u.prompt_tokens ?? 0) + Number(u.completion_tokens ?? 0)))
                    if (Number.isFinite(total) && total > 0) streamTokens = total
                  }
                  // 只保留尾部，避免长回答无限增长
                  if (streamText.length > 32 * 1024) streamText = streamText.slice(-8 * 1024)
                } catch {
                  /* 解析失败不影响转发 */
                }
              }
              controller.enqueue(value)
            }
          } catch (err) {
            settled = true
            const msg = redactSecrets(`流式中断：${err instanceof Error ? err.message : String(err)}`, 200)
            log.warn('流式传输中断', { channel: ch.name, bytesSent: seen, error: msg })
            try {
              controller.error(err)
            } catch {
              /* 流可能已关闭 */
            }
            void logRequest({ ...logBase, ok: false, latencyMs: Date.now() - start, attempt: tryIdx + 1, error: msg })
          }
        },
        async cancel(reason) {
          // 客户端主动断开：取消上游读取，避免上游继续生成烧额度
          if (settled) return
          settled = true
          await reader.cancel(reason).catch(() => {})
          log.info('客户端中断流式响应', { channel: ch.name, bytesSent: seen })
          void logRequest({
            ...logBase,
            ok: false,
            latencyMs: Date.now() - start,
            attempt: tryIdx + 1,
            error: '客户端中断',
          })
        },
      })
    } else {
      void logRequest({ ...logBase, ok: true, latencyMs, totalTokens, attempt: tryIdx + 1 })
    }

    const headers = new Headers()
    headers.set('Content-Type', contentType)
    headers.set('Cache-Control', 'no-cache')
    headers.set('X-Gateway-Channel', encodeURIComponent(ch.name))
    // 回传请求 ID：客户端报障时截图/日志里就能直接定位到服务端那几条日志
    headers.set('X-Request-Id', requestId)
    return new Response(resBody, { status: res.status, headers })
  }

  return openAiError(`所有渠道均失败 → ${failures.join(' | ')}`, 'api_error', 502)
}

/** GET /v1/models：返回所有启用的模型显示名（OpenAI 格式） */
export async function handleListModels(req: Request): Promise<Response> {
  const requestId = resolveRequestId(req)
  const auth = req.headers.get('authorization') || ''
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const token = await authenticate(key)
  if (!token) {
    return openAiError('API Key 无效或已禁用（请使用网关统一 Key）', 'invalid_request_error', 401, { requestId })
  }
  const routes = await getEnabledRoutes()
  return new Response(
    JSON.stringify({
      object: 'list',
      // 纯兜底路由 "*" 不进模型列表（客户端无需看见）；前缀通配（如 gpt-*）保留展示
      data: routes
        .filter((r) => r.displayName !== '*')
        .map((r) => ({
          id: r.displayName,
          object: 'model',
          created: Math.floor(r.createdAt.getTime() / 1000),
          owned_by: 'api-gateway',
        })),
    }),
    // 与转发接口保持一致：成功响应也回传 X-Request-Id，便于客户端全链路对账
    { headers: withRequestIdHeader(new Headers({ 'Content-Type': 'application/json' }), requestId) }
  )
}
