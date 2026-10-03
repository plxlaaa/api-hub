import { db } from '@/lib/db'
import { getAdapter, resolveChatEndpoint } from '@/lib/adapters'

export const PROBE_INTERVAL_MS = 60_000
const PROBE_TIMEOUT_MS = 10_000
const MAX_LOGS = 1000

/**
 * 规范化上游 URL：填到域名或 /v1 均可。
 * - 以 /v1、/v2... 或 /api 结尾 → 直接拼接 endpoint
 * - 否则自动追加 /v1 前缀
 */
export function upstreamUrl(baseUrl: string, endpoint: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  const ep = endpoint.replace(/^\/+/, '')
  // 端点自带版本目录（如 Gemini 的 v1beta/...）：去掉 base 尾部 /v1 后直接拼，不再补全
  if (/^v\d+[a-z]*\//.test(ep)) {
    base = base.replace(/\/v1$/i, '')
    return `${base}/${ep}`
  }
  if (!/\/(v\d+|api)$/i.test(base)) base += '/v1'
  return `${base}/${ep}`
}

/**
 * 备选 URL：主 URL 404 时用反向变体重试。
 * - base 已带 /v1、/v2、/api 前缀 → 去掉前缀裸拼（有的站根路径就是 API）
 * - base 无前缀（主 URL 已补 /v1）→ 裸拼
 */
export function altUpstreamUrl(baseUrl: string, endpoint: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  const ep = endpoint.replace(/^\/+/, '')
  // 端点自带版本目录：备用地址就是裸拼（去不掉版本前缀）
  if (/^v\d+[a-z]*\//.test(ep)) return `${base}/${ep}`
  const m = base.match(/\/(v\d+|api)$/i)
  if (m) base = base.slice(0, base.length - m[0].length)
  return `${base}/${ep}`
}

/** 规范化 baseUrl（去尾斜杠、补协议），用于入库与回写 */
export function normalizeBaseUrl(input: string): string {
  let base = input.trim().replace(/\/+$/, '')
  if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`
  return base
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number | null
  statusCode: number | null
  error: string | null
  /** 自愈发现的新 baseUrl（与库中值不同时返回，调用方负责回写） */
  fixedBaseUrl?: string | null
  /** 自愈回写说明（已回写时返回，用于前端提示/探测日志） */
  fixedNote?: string | null
}

/** 探测单个上游：GET /models（轻量，不消耗对话额度）；鉴权头由协议适配器提供 */
export async function probeUpstream(baseUrl: string, apiKey: string, apiFormat?: string): Promise<ProbeResult> {
  const start = Date.now()
  const headers = getAdapter(apiFormat).buildHeaders(apiKey)
  const base = normalizeBaseUrl(baseUrl)
  const hasPrefix = /\/(v\d+|api)$/i.test(base)

  const attempt = async (url: string): Promise<{ res: Response | null; error: string | null }> => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      return { res, error: null }
    } catch (err) {
      const msg = err instanceof Error
        ? (err.name === 'TimeoutError' ? `探测超时（${PROBE_TIMEOUT_MS / 1000}s）` : err.message)
        : String(err)
      return { res: null, error: msg }
    }
  }

  // 1) 主 URL（规范化 + 自动补 /v1）
  const primary = upstreamUrl(base, 'models')
  let { res, error } = await attempt(primary)
  let ok = Boolean(res?.ok)
  let fixedBaseUrl: string | null = null

  // 2) 主失败 → 反向变体自愈（填错 /v1 或裸路径站），成功则报告新地址
  if (!ok) {
    const altBase = hasPrefix ? base.replace(/\/(v\d+|api)$/i, '') : base
    const alt = altUpstreamUrl(base, 'models')
    if (alt !== primary) {
      const r2 = await attempt(alt)
      if (r2.res?.ok) {
        res = r2.res
        error = null
        ok = true
        fixedBaseUrl = altBase
      }
    }
  }

  const latencyMs = Date.now() - start
  if (ok && res) {
    return { ok: true, latencyMs, statusCode: res.status, error: null, fixedBaseUrl }
  }
  const text = res ? (await res.text().catch(() => '')).slice(0, 300) : ''
  return { ok: false, latencyMs, statusCode: res?.status ?? null, error: text || error || '探测失败' }
}

/**
 * 探测并落库：更新渠道状态 + 写探测日志 + 熔断器判定
 * - 连续失败达到阈值（且熔断开启）→ 自动摘除（autoDisabled），恢复探测成功后自动加回
 * - 手动 enabled=false 的渠道不参与探测，也不参与熔断
 */
export async function probeChannelById(channelId: string): Promise<ProbeResult> {
  const ch = await db.channel.findUnique({ where: { id: channelId } })
  if (!ch) throw new Error('渠道不存在')
  const result = await probeUpstream(ch.baseUrl, ch.apiKey, ch.apiFormat)

  // 熔断器设置（关闭时仅记录状态，不摘除）
  const [cbOn, cbThreshold] = await Promise.all([
    db.setting.findUnique({ where: { key: 'circuitBreaker' } }),
    db.setting.findUnique({ where: { key: 'cbThreshold' } }),
  ])
  const breakerEnabled = cbOn?.value !== 'off' // 默认开启
  const threshold = Math.max(1, Number(cbThreshold?.value ?? 3) || 3)

  const failStreak = result.ok ? 0 : ch.failStreak + 1
  let autoDisabled = ch.autoDisabled
  let autoDisabledAt = ch.autoDisabledAt

  // baseUrl 自愈回写：探测发现规范地址与库中不同（尾斜杠 / 缺协议 / 填错前缀）→ 持久化
  let fixedNote: string | null = null
  if (result.ok && result.fixedBaseUrl && result.fixedBaseUrl !== ch.baseUrl) {
    await db.channel.update({ where: { id: channelId }, data: { baseUrl: result.fixedBaseUrl } })
    fixedNote = `已自动补全 baseUrl：${ch.baseUrl} → ${result.fixedBaseUrl}`
    console.log(`[probe] 渠道「${ch.name}」${fixedNote}`)
    result.fixedBaseUrl = result.fixedBaseUrl
  }

  if (breakerEnabled) {
    if (result.ok && ch.autoDisabled) {
      // 恢复：探测成功，自动加回
      autoDisabled = false
      autoDisabledAt = null
      console.log(`[probe] 渠道「${ch.name}」探测恢复，自动重新启用`)
    } else if (!result.ok && !ch.autoDisabled && failStreak >= threshold) {
      // 熔断：连续失败达到阈值，自动摘除
      autoDisabled = true
      autoDisabledAt = new Date()
      console.warn(`[probe] 渠道「${ch.name}」连续失败 ${failStreak} 次，自动熔断摘除`)
    }
  }

  await db.channel.update({
    where: { id: channelId },
    data: {
      status: result.ok ? 'online' : 'offline',
      latencyMs: result.latencyMs,
      lastCheckAt: new Date(),
      lastError: result.ok ? null : result.error,
      failStreak,
      autoDisabled,
      autoDisabledAt,
    },
  })
  await db.probeLog.create({
    data: {
      channelId,
      ok: result.ok,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      error: fixedNote ?? result.error,
    },
  })
  return { ...result, fixedNote }
}

/** 全量探测启用中的渠道，并清理历史日志 */
export async function probeAllChannels(): Promise<void> {
  try {
    const channels = await db.channel.findMany({ where: { enabled: true }, select: { id: true } })
    await Promise.allSettled(channels.map((c) => probeChannelById(c.id)))
    const count = await db.probeLog.count()
    if (count > MAX_LOGS) {
      const stale = await db.probeLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: MAX_LOGS,
        take: count - MAX_LOGS,
        select: { id: true },
      })
      await db.probeLog.deleteMany({ where: { id: { in: stale.map((l) => l.id) } } })
    }
  } catch (err) {
    console.error('[probe] probeAllChannels failed:', err)
  }
}

/** 定时探测调度器（globalThis 单例，防 dev 热重载重复启动） */
export function startProbeScheduler(): void {
  const g = globalThis as unknown as { __gwProbeTimer?: ReturnType<typeof setInterval>; __gwProbeStarted?: boolean }
  if (g.__gwProbeStarted) return
  g.__gwProbeStarted = true
  setTimeout(() => void probeAllChannels(), 5_000)
  g.__gwProbeTimer = setInterval(() => void probeAllChannels(), PROBE_INTERVAL_MS)
  console.log(`[probe] scheduler started (every ${PROBE_INTERVAL_MS / 1000}s)`)
}

// ---------- 渠道真实对话测试 ----------

export const CHAT_TEST_TIMEOUT_MS = 30_000

export interface ChatTestResult {
  ok: boolean
  model: string | null
  latencyMs: number | null
  reply: string | null
  totalTokens: number | null
  error: string | null
}

/** 向渠道发一条小消息，验证「真的能对话」（会消耗少量上游额度） */
export async function testChannelChat(channelId: string, model?: string): Promise<ChatTestResult> {
  const ch = await db.channel.findUnique({ where: { id: channelId } })
  if (!ch) throw new Error('渠道不存在')

  let models: string[] = []
  try {
    models = JSON.parse(ch.models || '[]')
  } catch {
    /* ignore */
  }
  const target = (model?.trim() || models[0] || '').trim()
  if (!target) {
    return { ok: false, model: null, latencyMs: null, reply: null, totalTokens: null, error: '渠道未配置支持模型，请先在渠道设置中填写' }
  }

  const start = Date.now()
  try {
    // 一键对话测试：请求体/头由协议适配器构造（anthropic 渠道自动转 /v1/messages + x-api-key）
    const adapter = getAdapter(ch.apiFormat)
    const testMsg = '你好！这是一条连通性测试消息，请用不超过15个字的简短回复。'
    const res = await fetch(upstreamUrl(ch.baseUrl, resolveChatEndpoint(adapter, target, false)), {
      method: 'POST',
      headers: adapter.buildHeaders(ch.apiKey),
      body: adapter.buildRequestBody({ model: target, messages: [{ role: 'user', content: testMsg }], max_tokens: 60, stream: false } as never, target),
      signal: AbortSignal.timeout(CHAT_TEST_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      return { ok: false, model: target, latencyMs, reply: null, totalTokens: null, error: `HTTP ${res.status} ${text}` }
    }
    const j = (await res.json().catch(() => ({}))) as unknown
    const reply = adapter.extractReply(j)
    const totalTokens = adapter.extractUsage(j)
    return { ok: true, model: target, latencyMs, reply, totalTokens, error: null }
  } catch (err) {
    const msg = err instanceof Error
      ? (err.name === 'TimeoutError' ? `对话测试超时（${CHAT_TEST_TIMEOUT_MS / 1000}s）` : err.message)
      : String(err)
    return { ok: false, model: target, latencyMs: Date.now() - start, reply: null, totalTokens: null, error: msg }
  }
}
