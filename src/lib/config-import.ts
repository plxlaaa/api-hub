/**
 * 配置导入的纯函数归一化层（零 IO，可直接单测）。
 *
 * 背景：/api/config/import 此前被误写成 fetch-models 的副本，配置恢复功能整体失效。
 * 修复时发现导入有三种调用方，期望的请求形状与响应字段各不相同：
 *   1) 仪表盘：直接 POST 裸配置体 → 期望 { channelsAdded, channelsSkipped, routesAdded, routesSkipped, channelsMissingKey }
 *   2) 渠道页：POST { mode, data }        → 期望 { importedChannels, importedRoutes }
 *   3) CLI   ：POST { data, mode }        → 只看人类可读文案
 * 所以这里既要「兼容两种请求形状」，也要「返回三组字段的并集」，否则修好一处仍会弄坏另两处。
 *
 * 导出侧（/api/config/export）把渠道 id 转成了渠道名以便跨环境导入，
 * 因此 channelConfigs[].name 需要按名字反查回本地 id；查不到的渠道直接剔除，
 * 而不是静默塞一个空引用（那会让路由在运行时才炸）。
 */

/** 导入模式：merge=保留现有、按名字去重；replace=先清空现有渠道与路由 */
export type ImportMode = 'merge' | 'replace'

export interface NormalizedChannel {
  name: string
  baseUrl: string
  apiKey: string
  apiFormat: string
  models: string[]
  enabled: boolean
  remark: string | null
  metadata: Record<string, string | number | boolean> | null
}

export interface NormalizedChannelRef {
  /** 导出文件里的渠道名（或本身就是 id 的老格式） */
  name: string
  model?: string
  weight?: number
  quality?: number
  percent?: number
  activeHours?: string
}

export interface NormalizedRoute {
  displayName: string
  targetModel: string
  strategy: string
  priceIn: number | null
  priceOut: number | null
  enabled: boolean
  remark: string | null
  metadata: Record<string, string | number | boolean> | null
  channels: NormalizedChannelRef[]
}

export interface NormalizedConfig {
  channels: NormalizedChannel[]
  routes: NormalizedRoute[]
  /** 导入文件声明的版本，用于向前兼容提示 */
  version: number | null
}

export interface ImportPlan {
  mode: ImportMode
  config: NormalizedConfig
  /** 归一化过程中的可读告警（不阻断导入，但要让用户知道哪里被调整过） */
  warnings: string[]
}

/** 与 lib/route-config.ts 的合法策略集合同源，避免导入时写进非法策略名 */
const STRATEGY_NAMES = new Set([
  'priority',
  'weighted',
  'speed',
  'quality',
  'stability',
  'cost',
  'sticky',
  'percent',
])

const SUPPORTED_VERSION = 1
/** 单次导入的规模上限：导入体来自用户上传的文件，过大直接拒绝防内存打爆 */
const MAX_CHANNELS = 500
const MAX_ROUTES = 1000
const MAX_NAME_LEN = 80
const MAX_URL_LEN = 500
const MAX_KEY_LEN = 500

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 时段窗口格式校验（与 route-config.parseActiveHours 同规则：HH:MM-HH:MM，分钟 < 60） */
function validActiveHours(v: string): boolean {
  const m = /^\s*(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})\s*$/.exec(v)
  if (!m) return false
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return sh <= 23 && eh <= 23 && sm <= 59 && em <= 59
}

/** metadata 只接受扁平的基础类型值（与 parseMetadata 约束一致），深度嵌套直接丢弃 */
function normalizeMetadata(v: unknown): Record<string, string | number | boolean> | null {
  const src = asRecord(v)
  const out: Record<string, string | number | boolean> = {}
  for (const [k, val] of Object.entries(src)) {
    const key = k.trim()
    if (!key || key.length > 40) continue
    if (typeof val === 'string' && val.length <= 200) out[key] = val
    else if (typeof val === 'number' && Number.isFinite(val)) out[key] = val
    else if (typeof val === 'boolean') out[key] = val
  }
  return Object.keys(out).length > 0 ? out : null
}

/** models 兼容两种形态：数组，或导出文件里的 JSON 字符串 */
function normalizeModels(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 500)
  }
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean).slice(0, 500)
    } catch {
      /* 落到裸列表解析 */
    }
    return v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500)
  }
  return []
}

function normalizeChannels(raw: unknown, warnings: string[]): NormalizedChannel[] {
  if (!Array.isArray(raw)) return []
  if (raw.length > MAX_CHANNELS) {
    warnings.push(`渠道数量 ${raw.length} 超过上限 ${MAX_CHANNELS}，仅导入前 ${MAX_CHANNELS} 个`)
  }
  const out: NormalizedChannel[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, MAX_CHANNELS)) {
    const c = asRecord(item)
    const name = str(c.name, MAX_NAME_LEN)
    const baseUrl = str(c.baseUrl, MAX_URL_LEN)
    if (!name) {
      warnings.push('跳过一个缺少 name 的渠道条目')
      continue
    }
    if (!baseUrl) {
      warnings.push(`渠道「${name}」缺少 baseUrl，已跳过`)
      continue
    }
    // 同名渠道在文件内重复：后者不覆盖前者，避免导入结果取决于数组顺序
    if (seen.has(name)) {
      warnings.push(`渠道「${name}」在导入文件中重复，仅保留首个`)
      continue
    }
    seen.add(name)
    const apiFormat = str(c.apiFormat, 20) || 'openai'
    out.push({
      name,
      baseUrl,
      // 无密钥是合法情况（导出时用了不带 keys 的选项），导入后由用户补填
      apiKey: str(c.apiKey, MAX_KEY_LEN),
      apiFormat: ['openai', 'anthropic', 'gemini'].includes(apiFormat) ? apiFormat : 'openai',
      models: normalizeModels(c.models),
      enabled: c.enabled === undefined ? true : c.enabled !== false,
      remark: typeof c.remark === 'string' && c.remark.trim() ? c.remark.trim().slice(0, 500) : null,
      metadata: normalizeMetadata(c.metadata),
    })
  }
  return out
}

/**
 * 解析路由的渠道引用列表。
 * 导出文件里是 [{name, model, weight, quality}]（id 已转名），
 * 老文件/手工编辑可能是 channelIds（JSON 字符串数组）或 channelConfigs 的 JSON 字符串。
 */
function normalizeChannelRefs(raw: unknown, warnings: string[], routeLabel: string): NormalizedChannelRef[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) {
    list = raw
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch {
      warnings.push(`路由「${routeLabel}」的渠道列表不是合法 JSON，按空处理`)
      return []
    }
  }

  const out: NormalizedChannelRef[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item === 'string') {
      // 老格式：纯 id 数组
      const id = item.trim().slice(0, MAX_NAME_LEN)
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push({ name: id })
      }
      continue
    }
    const c = asRecord(item)
    const name = str(c.name, MAX_NAME_LEN) || str(c.id, MAX_NAME_LEN)
    if (!name) continue
    if (seen.has(name)) continue
    seen.add(name)
    const ref: NormalizedChannelRef = { name }
    const model = str(c.model, 120)
    if (model) ref.model = model
    const weight = num(c.weight)
    if (weight !== null && weight >= 0) ref.weight = Math.min(Math.round(weight), 100)
    const quality = num(c.quality)
    if (quality !== null && quality >= 1 && quality <= 10) ref.quality = Math.round(quality)
    const percent = num(c.percent)
    if (percent !== null && percent >= 0 && percent <= 100) ref.percent = Math.round(percent)
    const hours = str(c.activeHours, 32)
    if (hours && validActiveHours(hours)) ref.activeHours = hours
    out.push(ref)
  }
  return out
}

function normalizeRoutes(raw: unknown, warnings: string[]): NormalizedRoute[] {
  if (!Array.isArray(raw)) return []
  if (raw.length > MAX_ROUTES) {
    warnings.push(`路由数量 ${raw.length} 超过上限 ${MAX_ROUTES}，仅导入前 ${MAX_ROUTES} 条`)
  }
  const out: NormalizedRoute[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, MAX_ROUTES)) {
    const r = asRecord(item)
    const displayName = str(r.displayName, MAX_NAME_LEN)
    if (!displayName) {
      warnings.push('跳过一个缺少 displayName 的路由条目')
      continue
    }
    if (seen.has(displayName)) {
      warnings.push(`路由「${displayName}」在导入文件中重复，仅保留首个`)
      continue
    }
    seen.add(displayName)

    const strategyRaw = str(r.strategy, 20)
    if (strategyRaw && !STRATEGY_NAMES.has(strategyRaw)) {
      warnings.push(`路由「${displayName}」的策略 ${strategyRaw} 不受支持，已回退为 priority`)
    }
    // 渠道引用的来源，按优先级回退，覆盖三种常见写法：
    //   1) channelConfigs —— 本项目导出格式（含 weight/percent/activeHours 等明细）
    //   2) channels       —— 早期导出与用户手写配置，按「渠道名」引用
    //   3) channelIds     —— 老格式的纯 id 数组
    // 三者都缺失时按「无渠道」处理：导入后是一条空路由，调用时只会返回 502。
    let refs = normalizeChannelRefs(r.channelConfigs, warnings, displayName)
    if (refs.length === 0) refs = normalizeChannelRefs(r.channels, warnings, displayName)
    if (refs.length === 0) refs = normalizeChannelRefs(r.channelIds, warnings, displayName)

    // targetModel 缺失时回退为displayName（含兜底路由 "*"，它本来就该原样透传）
    const targetModel = str(r.targetModel, 120)
    out.push({
      displayName,
      targetModel: targetModel || displayName,
      strategy: STRATEGY_NAMES.has(strategyRaw) ? strategyRaw : 'priority',
      priceIn: num(r.priceIn),
      priceOut: num(r.priceOut),
      enabled: r.enabled === undefined ? true : r.enabled !== false,
      remark: typeof r.remark === 'string' && r.remark.trim() ? r.remark.trim().slice(0, 500) : null,
      metadata: normalizeMetadata(r.metadata),
      channels: refs,
    })
  }
  return out
}

/**
 * 兼容两种请求形状：
 *   A) 裸配置体：{ kind/version/channels/routes }
 *   B) 包装体  ：{ mode, data: <配置体> }
 * 判据：顶层存在 channels 或 routes 就认为是形状 A（配置体本身），
 * 否则找 data 字段。两者都不像则返回 null，由路由层回 400。
 */
export function extractImportPayload(body: unknown): { mode: ImportMode; data: unknown } | null {
  const root = asRecord(body)
  const looksLikeConfig =
    Array.isArray(root.channels) || Array.isArray(root.routes) || root.kind === 'api-hub-config'
  if (looksLikeConfig) {
    return { mode: root.mode === 'replace' ? 'replace' : 'merge', data: root }
  }
  const inner = root.data
  if (inner && typeof inner === 'object') {
    const innerRec = asRecord(inner)
    const mode: ImportMode = root.mode === 'replace' || innerRec.mode === 'replace' ? 'replace' : 'merge'
    return { mode, data: inner }
  }
  return null
}

/** 把任意形状的导入请求归一化为可执行的导入计划 */
export function planImport(body: unknown): ImportPlan | null {
  const payload = extractImportPayload(body)
  if (!payload) return null
  const data = asRecord(payload.data)
  const warnings: string[] = []

  const version = num(data.version)
  if (version !== null && version > SUPPORTED_VERSION) {
    warnings.push(
      `导入文件版本 v${version} 高于当前支持的 v${SUPPORTED_VERSION}，未知字段会被忽略`
    )
  }
  if (typeof data.kind === 'string' && data.kind !== 'api-hub-config') {
    warnings.push(`导入文件类型标识为「${data.kind}」，可能不是本工具导出的文件`)
  }

  const config: NormalizedConfig = {
    channels: normalizeChannels(data.channels, warnings),
    routes: normalizeRoutes(data.routes, warnings),
    version,
  }
  return { mode: payload.mode, config, warnings }
}

/**
 * 按渠道名把导入的渠道引用映射回本地 id。
 * 匹配不上的引用直接剔除并计数 —— 绝不写入悬空引用，
 * 否则路由会在真实调用时才报错（那时用户已经在生产环境了）。
 *
 * @param refs 导入文件里的渠道引用
 * @param nameToId 本地「渠道名 → 渠道 id」映射
 */
export function resolveChannelRefs(
  refs: NormalizedChannelRef[],
  nameToId: Map<string, string>
): { resolved: Array<NormalizedChannelRef & { id: string }>; missing: string[] } {
  const resolved: Array<NormalizedChannelRef & { id: string }> = []
  const missing: string[] = []
  for (const ref of refs) {
    const id = nameToId.get(ref.name)
    if (id) resolved.push({ ...ref, id })
    else missing.push(ref.name)
  }
  return { resolved, missing }
}

/** 导入结果：三组调用方所需字段的并集，一次返回避免前端各自适配 */
export interface ImportResult {
  ok: true
  channelsAdded: number
  channelsSkipped: number
  routesAdded: number
  routesSkipped: number
  channelsMissingKey: number
  /** 渠道页 / CLI 期望的简写字段 */
  importedChannels: number
  importedRoutes: number
  /** 被剔除的悬空渠道引用总数 */
  refsDropped: number
  warnings: string[]
}

export function buildImportResult(
  counts: Omit<ImportResult, 'ok' | 'importedChannels' | 'importedRoutes'>
): ImportResult {
  return {
    ok: true,
    ...counts,
    importedChannels: counts.channelsAdded,
    importedRoutes: counts.routesAdded,
  }
}