/**
 * 结构化日志（零外部依赖，仅用Node 内置能力）。
 *
 * 现状问题：各模块直接用 console.log/warn/error 打印纯文本，缺三个能力：
 * 1) 无级别 —— 无法按级别过滤，systemd/journalctl 只能全量收；
 * 2) 无请求标识 —— 一条请求触发多次日志（转发/熔断/写日志）时无法串联排查；
 * 3) 无兜底脱敏 —— 手工调用 redactSecrets 容易漏，一漏就把上游 Key 写进日志文件。
 *
 * 这里统一收敛：级别化+ JSON 行输出 + 自动脱敏 + 请求 ID 透传。
 *
 * 环境变量：
 * - LOG_LEVEL=debug|info|warn|error|silent （默认 info；排障时调 debug）
 * - LOG_FORMAT=json|text   （默认 json；终端阅读用 text 更顺，采集用 json）
 * - LOG_SILENT=1   彻底静默（测试用，避免污染断言输出）
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { redactSecrets } from './redact.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

function envLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL || '').toLowerCase()
  return v in LEVEL_WEIGHT ? (v as LogLevel) : 'info'
}

/** 运行时可改（测试与排障用），初始取环境变量 */
let currentLevel: LogLevel = envLevel()
let currentFormat: 'json' | 'text' = process.env.LOG_FORMAT === 'text' ? 'text' : 'json'

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

export function setLogFormat(format: 'json' | 'text'): void {
  currentFormat = format
}

/** 单个字段值的最大长度，防止把整个响应体塞进日志 */
const MAX_FIELD_LEN = 500

/** 是否彻底静默（测试环境避免污染输出） */
function isSilent(): boolean {
  return process.env.LOG_SILENT === '1'
}

/**
 * 递归裁剪 + 脱敏任意字段值。
 * 保证「写进日志的内容不会泄漏上游密钥」——这是 redactSecrets 手工调用最常漏的点。
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return redactSecrets(value, MAX_FIELD_LEN)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return redactSecrets(`${value.name}: ${value.message}`, MAX_FIELD_LEN)
  // 深度上限 3 层：再深通常说明数据结构本身有问题，截断比无限展开安全
  if (depth >= 3) return '[deep]'
  if (Array.isArray(value)) {
    const out = value.slice(0, 20).map((v) => sanitize(v, depth + 1))
    if (value.length > 20) out.push(`…共 ${value.length} 项`)
    return out
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let n = 0
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 30) {
        out['…'] = '字段过多已截断'
        break
      }
      out[k] = sanitize(v, depth + 1)
    }
    return out
  }
  return redactSecrets(String(value), MAX_FIELD_LEN)
}

/** 文本格式下渲染结构化字段 */
function renderTextFields(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
  return parts.length ? ` ${parts.join(' ')}` : ''
}

function emit(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void {
  if (isSilent()) return
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return

  const safeFields = fields ? (sanitize(fields) as Record<string, unknown>) : undefined
  const ts = new Date().toISOString()
  const safeMsg = redactSecrets(msg, MAX_FIELD_LEN)

  if (currentFormat === 'text') {
    const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${safeMsg}${safeFields ? renderTextFields(safeFields) : ''}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    return
  }

  const line = JSON.stringify({ ts, level, msg: safeMsg, ...(safeFields ?? {}) })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** 对外日志器：log.info('消息', { channelId, latencyMs }) */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
}

// ============================================================
// 请求 ID：把一次请求产生的所有日志串起来
// ============================================================

const als = new AsyncLocalStorage<{ requestId: string }>()

/** 生成短请求 ID（8 位十六进制，够定位且不撑爆日志） */
export function newRequestId(): string {
  return randomBytes(4).toString('hex')
}

/** 在请求作用域内执行，期间所有log.* 调用都会自动带上 requestId */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return als.run({ requestId }, fn)
}

/** 取当前请求 ID；不在请求作用域内返回 undefined */
export function currentRequestId(): string | undefined {
  return als.getStore()?.requestId
}