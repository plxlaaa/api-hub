import { db } from '@/lib/db'
import { upstreamUrl, altUpstreamUrl, probeChannelById } from '@/lib/probe'
import { parseChannelConfigs, type ChannelConfig } from '@/lib/route-config'
import { orderCandidates, type RouteStrategy } from '@/lib/route-order'
import type { OpenAIBody } from '@/lib/anthropic'
import { getAdapter, resolveChatEndpoint } from '@/lib/adapters'

const UPSTREAM_TIMEOUT_MS = 300_000 // 长回答 / 长流式给足时间
const MAX_REQUEST_LOGS = 2000

interface UpstreamBody {
  [key: string]: unknown
  model?: string
  stream?: boolean
}

function openAiError(message: string, type: string, status: number): Response {
  return Response.json({ error: { message, type, code: null } }, { status })
}

/** 转发失败联动熔断：真实调用连续失败达到阈值 → 自动摘除（探测恢复后自动加回） */
async function recordForwardFailure(channelId: string, errorMsg: string): Promise<void> {
  try {
    const [cbOn, cbThreshold] = await Promise.all([
      db.setting.findUnique({ where: { key: 'circuitBreaker' } }),
      db.setting.findUnique({ where: { key: 'cbThreshold' } }),
    ])
    if (cbOn?.value === 'off') return
    const updated = await db.channel.update({
      where: { id: channelId },
      data: { failStreak: { increment: 1 }, status: 'offline', lastError: errorMsg.slice(0, 300) },
      select: { failStreak: true, autoDisabled: true, name: true },
    })
    const threshold = Math.max(1, Number(cbThreshold?.value ?? 3) || 3)
    if (!updated.autoDisabled && updated.failStreak >= threshold) {
      await db.channel.update({
        where: { id: channelId },
        data: { autoDisabled: true, autoDisabledAt: new Date() },
      })
      console.warn(`[gateway] 渠道「${updated.name}」连续调用失败 ${updated.failStreak} 次，自动熔断摘除`)
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
    if (Math.random() < 0.05) {
      const count = await db.requestLog.count()
      if (count > MAX_REQUEST_LOGS) {
        const stale = await db.requestLog.findMany({
          orderBy: { createdAt: 'desc' },
          skip: MAX_REQUEST_LOGS,
          take: count - MAX_REQUEST_LOGS,
          select: { id: true },
        })
        await db.requestLog.deleteMany({ where: { id: { in: stale.map((l) => l.id) } } })
      }
    }
  } catch (err) {
    console.error('[gateway] logRequest failed:', err)
  }
}

/** 校验统一调用密钥，返回 token 记录或 null */
async function authenticate(key: string) {
  if (!key) return null
  const token = await db.apiToken.findUnique({ where: { key } })
  return token && token.enabled ? token : null
}

/**
 * 统一网关：POST /v1/chat/completions
 * 1. 统一 Key 鉴权  2. 模型显示名 → 路由解析
 * 3. 按渠道优先级逐个转发，非 2xx 自动故障转移到下一渠道
 * 4. 上游响应原样透传（含 SSE 流式）；每次尝试写入调用日志
 */
export async function handleChatCompletions(
  req: Request,
  opts?: { adminOverride?: boolean }
): Promise<Response> {
  // 1. 鉴权（管理员测试模式跳过统一 Key，不消耗配额）
  const adminOverride = Boolean(opts?.adminOverride)
  let token: { id: string; name: string; quotaLimit: number | null; quotaUsed: number }
  if (adminOverride) {
    token = { id: '', name: '（管理测试）', quotaLimit: null, quotaUsed: 0 }
  } else {
    const auth = req.headers.get('authorization') || ''
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const t = await authenticate(key)
    if (!t) {
      return openAiError('API Key 无效或已禁用（请使用网关统一 Key）', 'invalid_request_error', 401)
    }
    token = t
  }

  // 配额检查：超过上限返回 429
  if (token.quotaLimit !== null && token.quotaUsed >= token.quotaLimit) {
    return openAiError(
      `配额已用尽：该 Key 已达上限 ${token.quotaLimit} 次请求，请在管理台调整配额`,
      'insufficient_quota',
      429
    )
  }

  // 2. 解析请求体
  let body: UpstreamBody
  try {
    body = await req.json()
  } catch {
    return openAiError('请求体不是合法 JSON', 'invalid_request_error', 400)
  }
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
  if (!requestedModel) return openAiError('缺少 model 字段', 'invalid_request_error', 400)

  // 3. 路由解析：精确匹配 → 最长前缀通配（"gpt-*"）→ 兜底（"*"）
  const enabledRoutes = await db.modelRoute.findMany({ where: { enabled: true } })
  const exact = enabledRoutes.find((r) => r.displayName === requestedModel)
  const prefixHit = enabledRoutes
    .filter((r) => r.displayName.endsWith('*') && r.displayName.length > 1)
    .map((r) => ({ r, prefix: r.displayName.slice(0, -1) }))
    .filter((x) => requestedModel.startsWith(x.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]
  const fallback = enabledRoutes.find((r) => r.displayName === '*')
  const route = exact ?? prefixHit?.r ?? fallback ?? null
  if (!route) {
    return openAiError(`模型 "${requestedModel}" 不存在或未启用（可在管理台配置 "gpt-*" 前缀通配或 "*" 兜底路由承接未知模型）`, 'invalid_request_error', 404)
  }

  // 3. 渠道配置解析（渠道级模型映射 + 权重）；熔断中的渠道自动跳过
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
  const { ordered } = await orderCandidates(candidates, route.strategy as RouteStrategy)

  // 4. 逐渠道转发（故障转移；每个渠道用自己映射的模型名）
  const isStream = Boolean(body.stream)
  const failures: string[] = []

  for (const [tryIdx, { cfg, ch }] of ordered.entries()) {
    // 渠道级模型映射优先；路由 targetModel 为 "*" 时透传客户端请求的模型名（配合通配/兜底路由）
    const modelForChannel = cfg.model?.trim() || (route.targetModel === '*' ? requestedModel : route.targetModel)
    // 协议适配器：请求构造/头/响应转换全部由适配器负责（新协议注册即用，主流程零改动）
    const adapter = getAdapter(ch.apiFormat)
    const upstreamBody = adapter.buildRequestBody(body as OpenAIBody, modelForChannel)
    const start = Date.now()
    let res: Response
    const primaryUrl = upstreamUrl(ch.baseUrl, resolveChatEndpoint(adapter, modelForChannel, isStream))
    try {
      // cache:'no-store' 绕过 Next fetch 补丁的响应缓存层（其 clone 缓存会锁定 body，透传时报 disturbed）
      res = await fetch(primaryUrl, {
        method: 'POST',
        headers: adapter.buildHeaders(ch.apiKey),
        body: upstreamBody,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        cache: 'no-store',
      })
      // baseUrl 路径填错自愈：404 时用反向变体重试一次，成功则触发探测回写正确地址
      if (res.status === 404) {
        void res.body?.cancel().catch(() => {}) // 释放无用连接
        const altUrl = altUpstreamUrl(ch.baseUrl, resolveChatEndpoint(adapter, modelForChannel, isStream))
        if (altUrl !== primaryUrl) {
          const r2 = await fetch(altUrl, {
            method: 'POST',
            headers: adapter.buildHeaders(ch.apiKey),
            body: upstreamBody,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            cache: 'no-store',
          }).catch(() => null)
          if (r2?.ok) {
            res = r2
            void probeChannelById(ch.id) // 异步：把自愈出的 baseUrl 回写库
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error
        ? (err.name === 'TimeoutError' ? `上游超时（${UPSTREAM_TIMEOUT_MS / 1000}s）` : err.message)
        : String(err)
      failures.push(`[${ch.name}] ${msg}`)
      const latencyMs = Date.now() - start
      void recordForwardFailure(ch.id, msg)
      void logRequest({ channelName: ch.name, model: requestedModel, targetModel: modelForChannel, ok: false, latencyMs, tokenName: token.name, stream: isStream, attempt: tryIdx + 1, error: msg })
      continue
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      failures.push(`[${ch.name}] HTTP ${res.status} ${text}`)
      const latencyMs = Date.now() - start
      void recordForwardFailure(ch.id, `HTTP ${res.status} ${text}`)
      void logRequest({ channelName: ch.name, model: requestedModel, targetModel: modelForChannel, ok: false, statusCode: res.status, latencyMs, tokenName: token.name, stream: isStream, attempt: tryIdx + 1, error: `HTTP ${res.status} ${text}` })
      continue
    }

    // 成功 → 透传（非 openai 协议：适配器转换响应；流式经适配器 SSE 转换器）
    // 注意：Next dev 的 fetch 补丁会在 clone() 后锁定 res.body，透传必须避免 clone
    void recordForwardSuccess(ch.id)
    const latencyMs = Date.now() - start
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
    void (token.id
      ? db.apiToken
          .update({ where: { id: token.id }, data: { lastUsedAt: new Date(), quotaUsed: { increment: 1 } } })
          .catch(() => {})
      : Promise.resolve())
    void logRequest({ channelName: ch.name, model: requestedModel, targetModel: modelForChannel, ok: true, statusCode: res.status, latencyMs, totalTokens, tokenName: token.name, stream: isStream, attempt: tryIdx + 1 })
    const headers = new Headers()
    headers.set('Content-Type', contentType)
    headers.set('Cache-Control', 'no-cache')
    headers.set('X-Gateway-Channel', encodeURIComponent(ch.name))
    return new Response(resBody, { status: res.status, headers })
  }

  return openAiError(`所有渠道均失败 → ${failures.join(' | ')}`, 'api_error', 502)
}

/** GET /v1/models：返回所有启用的模型显示名（OpenAI 格式） */
export async function handleListModels(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization') || ''
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const token = await authenticate(key)
  if (!token) {
    return openAiError('API Key 无效或已禁用（请使用网关统一 Key）', 'invalid_request_error', 401)
  }
  const routes = await db.modelRoute.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } })
  return Response.json({
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
  })
}
