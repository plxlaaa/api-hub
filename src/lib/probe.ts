import { db } from '@/lib/db'
import { log } from '@/lib/logger'
import { getAdapter, resolveChatEndpoint } from '@/lib/adapters'
import { redactSecrets } from '@/lib/redact'
import { parseStringArray } from '@/lib/json-field'

export const PROBE_INTERVAL_MS = 60_000
const PROBE_TIMEOUT_MS = 10_000
const MAX_LOGS = 1000
/** 全量探测时的并发上限：SQLite 单写者，并发过高只会互相 SQLITE_BUSY */
const PROBE_CONCURRENCY = 4
/**
 * 熔断恢复冷却期：熔断后至少等这么久才允许探测把渠道加回来。
 * 没有冷却时会出现「上游抽风 → 网关熔断 → 探测成功 → 立刻加回 → 再熔断」的抖动，
 * 渠道在候选列表里反复进出，调用方频繁感知到失败转移。
 */
const BREAKER_RECOVER_COOLDOWN_MS = 5 * 60_000

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

/** 拉取上游 /models 的模型 id 列表（OpenAI 兼容格式 data[].id；复用探测的双 URL 自愈） */
export async function fetchUpstreamModels(
  baseUrl: string,
  apiKey: string,
  apiFormat?: string
): Promise<{ ok: boolean; models: string[]; error: string | null }> {
  const headers = getAdapter(apiFormat).buildHeaders(apiKey)
  const base = normalizeBaseUrl(baseUrl)
  const urls = [upstreamUrl(base, 'models')]
  const alt = altUpstreamUrl(base, 'models')
  if (alt !== urls[0]) urls.push(alt)

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!res.ok) continue
      const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null
      if (!body || !Array.isArray(body.data)) continue
      const models = body.data
        .map((m) => (typeof m?.id === 'string' ? m.id.trim() : ''))
        .filter(Boolean)
        .slice(0, 100) // 与导入解析同上限，防超大列表写爆字段
      return { ok: true, models, error: null }
    } catch {
      // 试下一个 URL 变体
    }
  }
  return { ok: false, models: [], error: '上游未返回可解析的模型列表' }
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
    // 探测只需要状态码；body 必须消费或取消，否则每个渠道每分钟泄漏一个 socket
    void res.body?.cancel().catch(() => {})
    return { ok: true, latencyMs, statusCode: res.status, error: null, fixedBaseUrl }
  }
  const text = res ? redactSecrets(await res.text().catch(() => ''), 300) : ''
  void res?.body?.cancel().catch(() => {})
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

  // failStreak 用原子自增，不用 ch.failStreak + 1 的陈旧读绝对值回写，
  // 否则会覆盖网关侧 recordForwardFailure 的 increment，导致失败计数丢失、熔断永不触发。
  const streakRow = await db.channel.update({
    where: { id: channelId },
    data: { failStreak: result.ok ? 0 : { increment: 1 } },
    select: { failStreak: true },
  })
  const failStreak = streakRow.failStreak
  let autoDisabled = ch.autoDisabled
  let autoDisabledAt = ch.autoDisabledAt

  // baseUrl 自愈回写：探测发现规范地址与库中不同（尾斜杠 / 缺协议 / 填错前缀）→ 持久化
  let fixedNote: string | null = null
  if (result.ok && result.fixedBaseUrl && result.fixedBaseUrl !== ch.baseUrl) {
    await db.channel.update({ where: { id: channelId }, data: { baseUrl: result.fixedBaseUrl } })
    fixedNote = `已自动补全 baseUrl：${ch.baseUrl} → ${result.fixedBaseUrl}`
    log.info('已自动补全 baseUrl', { channelId, channel: ch.name, from: ch.baseUrl, to: result.fixedBaseUrl })
  }

  if (breakerEnabled) {
    if (result.ok && ch.autoDisabled) {
      // 恢复：需满足冷却期，避免熔断在「探测成功 ↔ 调用失败」之间反复抖动
      const since = ch.autoDisabledAt ? Date.now() - ch.autoDisabledAt.getTime() : Infinity
      if (since >= BREAKER_RECOVER_COOLDOWN_MS) {
        // 条件更新：仅当仍处于熔断态才加回，与网关侧摘除操作互斥
        const r = await db.channel
          .updateMany({
            where: { id: channelId, autoDisabled: true },
            data: { autoDisabled: false, autoDisabledAt: null },
          })
          .catch(() => ({ count: 0 }))
        if (r.count > 0) {
          autoDisabled = false
          autoDisabledAt = null
          log.info('探测恢复，渠道自动重新启用', { channelId, channel: ch.name })
        }
      } else {
        log.info('探测已恢复但仍在熔断冷却期', {
          channelId,
          channel: ch.name,
          remainSec: Math.ceil((BREAKER_RECOVER_COOLDOWN_MS - since) / 1000),
        })
      }
    } else if (!result.ok && !ch.autoDisabled && failStreak >= threshold) {
      // 熔断：连续失败达到阈值，自动摘除（条件更新防并发重复摘除）
      const r = await db.channel
        .updateMany({
          where: { id: channelId, autoDisabled: false },
          data: { autoDisabled: true, autoDisabledAt: new Date() },
        })
        .catch(() => ({ count: 0 }))
      if (r.count > 0) {
        autoDisabled = true
        autoDisabledAt = new Date()
        log.warn('探测连续失败，渠道自动熔断摘除', { channelId, channel: ch.name, failStreak, threshold })
      }
    }
  }

  // autoDisabled/autoDisabledAt 已在上面条件更新里落库，这里只同步 status/延迟等探测结果；
  // 避免用陈旧的 autoDisabled 值把并发发生的熔断状态覆盖回去。
  await db.channel.update({
    where: { id: channelId },
    data: {
      status: result.ok ? 'online' : 'offline',
      latencyMs: result.latencyMs,
      lastCheckAt: new Date(),
      lastError: result.ok ? null : result.error,
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
    // 分批并发：SQLite 写并发受限，全量 Promise.allSettled 会互相 SQLITE_BUSY
    const queue = [...channels]
    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift()
        if (!item) return
        await probeChannelById(item.id).catch((err) => {
          log.error('渠道探测异常', { channelId: item.id, error: err })
        })
      }
    })
    await Promise.all(workers)
    // 日志裁剪与 gateway.pruneRequestLogs 同款 2 查询边界删除：
    // 旧写法 count() + findMany(skip) + deleteMany(IN 千级 id 列表)，
    // skip 在 SQLite 上要真实扫过丢弃前 N 行，IN 列表 SQL 文本巨大。
    // 现取「倒数第 MAX_LOGS 条」的时间戳做分界，一条 deleteMany 按 createdAt 删。
    const boundary = await db.probeLog.findFirst({
      orderBy: { createdAt: 'desc' },
      skip: MAX_LOGS,
      select: { createdAt: true },
    })
    if (boundary) {
      const { count } = await db.probeLog.deleteMany({ where: { createdAt: { lt: boundary.createdAt } } })
      if (count > 0) log.debug('探测日志已裁剪', { deleted: count, keep: MAX_LOGS })
    }
  } catch (err) {
    log.error('批量探测失败', { error: err })
  }
}

/** 定时探测调度器（globalThis 单例，防 dev 热重载重复启动） */
export function startProbeScheduler(): void {
  const g = globalThis as unknown as { __gwProbeTimer?: ReturnType<typeof setInterval>; __gwProbeStarted?: boolean }
  if (g.__gwProbeStarted) return
  g.__gwProbeStarted = true
  setTimeout(() => void probeAllChannels(), 5_000)
  g.__gwProbeTimer = setInterval(() => void probeAllChannels(), PROBE_INTERVAL_MS)
  log.info('探测调度器已启动', { intervalSec: PROBE_INTERVAL_MS / 1000 })
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

  const models = parseStringArray(ch.models)
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
      const text = redactSecrets(await res.text().catch(() => ''), 200)
      return { ok: false, model: target, latencyMs, reply: null, totalTokens: null, error: `HTTP ${res.status}${text ? ` ${text}` : ''}` }
    }
    const j = (await res.json().catch(() => ({}))) as unknown
    const reply = adapter.extractReply(j)
    const totalTokens = adapter.extractUsage(j)
    return { ok: true, model: target, latencyMs, reply, totalTokens, error: null }
  } catch (err) {
    const msg = err instanceof Error
      ? (err.name === 'TimeoutError' ? `对话测试超时（${CHAT_TEST_TIMEOUT_MS / 1000}s）` : redactSecrets(err.message, 200))
      : redactSecrets(err, 200)
    return { ok: false, model: target, latencyMs: Date.now() - start, reply: null, totalTokens: null, error: msg }
  }
}
