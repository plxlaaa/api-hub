export interface Channel {
  id: string
  name: string
  baseUrl: string
  apiFormat: 'openai' | 'anthropic' | 'gemini' // 接口格式：OpenAI 兼容 / Claude 原生 / Gemini 原生
  models: string[]
  enabled: boolean
  autoDisabled: boolean // 熔断器自动摘除中
  failStreak: number // 连续探测失败次数
  autoDisabledAt: string | null
  status: 'online' | 'offline' | 'unknown'
  latencyMs: number | null
  lastCheckAt: string | null
  lastError: string | null
  remark: string | null
  createdAt: string
  stats?: { calls: number; ok: number; tokens: number; avgLatencyMs: number | null }
  uptime24h?: number | null // 近 24h 探测可用率（%），null=暂无探测记录
}

export interface RouteChannelConfig {
  id: string
  model?: string // 该渠道实际模型名，缺省用路由 targetModel
  weight?: number // 权重策略下的随机权重，缺省 1
  quality?: number // 智商分 1-10，智商优先策略用，缺省 5
  percent?: number // 流量占比 0-100（百分比分流策略），0=只当后备
  activeHours?: string // 时段窗口 "HH:MM-HH:MM"，窗口外渠道退为后备
}

export type RouteStrategy = 'priority' | 'weighted' | 'speed' | 'quality' | 'stability' | 'cost' | 'sticky' | 'percent'

export interface ModelRoute {
  id: string
  displayName: string
  targetModel: string
  channelIds: string[]
  channelConfigs: RouteChannelConfig[]
  strategy: RouteStrategy
  priceIn: number | null
  priceOut: number | null
  enabled: boolean
  remark: string | null
  /** 扩展配置：priority / allowTokens / denyTokens / maxAttempts 等（token 名集为逗号分隔字符串） */
  metadata: Record<string, string | number | boolean> | null
  createdAt: string
  stats?: { total: number; ok: number; tokens: number; lastUsedAt: string | null }
}

export interface ApiTokenItem {
  id: string
  name: string
  key: string
  enabled: boolean
  quotaLimit: number | null // 请求次数上限，null=不限
  quotaUsed: number
  lastUsedAt: string | null
  createdAt: string
  metadata?: Record<string, string | number | boolean> | null // 扩展配置（如 rateLimitPerMin 单 Key 限速）
  usage?: { calls: number; tokens: number; lastCallAt: string | null }
}

export interface ProbeLogItem {
  id: string
  channelName: string
  ok: boolean
  latencyMs: number | null
  statusCode: number | null
  error: string | null
  createdAt: string
}

export interface RequestLogItem {
  id: string
  channelName: string
  model: string
  targetModel: string
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
  totalTokens: number | null
  tokenName: string | null // 发起请求的统一密钥名（管理员测试为空）
  stream: boolean
  attempt?: number // 第几次渠道尝试（故障转移时 2/3…，缺省视为 1）
  error: string | null
  createdAt: string
}

export interface Stats {
  total: { calls: number; fails: number }
  today: { calls: number; fails: number }
  hourly: Array<{ hour: string; calls: number; fails: number }>
  daily7?: Array<{ date: string; calls: number; fails: number; tokens: number }>
  topModels: Array<{ model: string; calls: number }>
  channelUsage?: Record<string, { calls: number; fails: number; avgLatencyMs: number | null }>
}

export interface ChatTestResult {
  ok: boolean
  model: string | null
  latencyMs: number | null
  reply: string | null
  totalTokens: number | null
  error: string | null
}

export interface ExportedConfig {
  version?: number
  app?: string
  exportedAt?: string
  channels?: Array<{
    id?: string
    name?: string
    baseUrl?: string
    apiKey?: string
    models?: string
    enabled?: boolean
    remark?: string | null
  }>
  routes?: Array<{
    displayName?: string
    targetModel?: string
    channelIds?: string
    channelConfigs?: string | RouteChannelConfig[]
    strategy?: RouteStrategy
    priceIn?: number | null
    priceOut?: number | null
    enabled?: boolean
    remark?: string | null
  }>
}
