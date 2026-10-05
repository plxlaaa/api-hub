/**
 * 统一 API 响应封装。
 *
 * 现状问题：各路由手写 `Response.json({ error: '...' }, { status: 400 })`，
 * 错误体形状不统一 —— 有的返回 { error: string }，有的返回 { error: { message, type } }
 * （OpenAI 兼容风格），客户端要按接口猜字段。日志也没有请求 ID，无法串联排查。
 *
 * 这里提供两层：
 * 1) 管理端风格：{ error: string, requestId?: string }
 * 2) OpenAI 兼容风格：{ error: { message, type, code } }（网关 /v1/* 必须用这种，
 *    否则 OpenAI SDK 解析报错）
 *
 * 两种都自动带上 requestId 与 X-Request-Id 响应头，便于把客户端报错与服务端日志对上。
 */

import { newRequestId } from './logger.ts'

/** 合法的请求 ID 字符集：字母数字与少量分隔符，够覆盖常见追踪系统（traceparent风格 W3C trace-id 亦可） */
const REQ_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

/**
 * 从请求头取上游传入的请求 ID，没有则新生成一个。
 *
 * 刻意「整段拒绝」而非截断：把超长/含非法字符的 ID 截短后放行，会让不同请求
 * 撞到同一个 ID，日志串联反而误导排障。宁可丢弃重生成。
 */
export function resolveRequestId(req: Request): string {
  const inbound = req.headers.get('x-request-id') || ''
  return REQ_ID_RE.test(inbound) ? inbound : newRequestId()
}

export interface ApiErrorBody {
  error: string
  requestId?: string
}

export interface OpenAiErrorBody {
  error: { message: string; type: string; code: string | null }
}

function baseHeaders(requestId?: string): Record<string, string> {
  return requestId ? { 'X-Request-Id': requestId } : {}
}

/** 管理端成功响应 */
export function jsonOk<T>(data: T, init?: ResponseInit & { requestId?: string }): Response {
  const { requestId, ...rest } = init ?? {}
  const headers = { 'Content-Type': 'application/json', ...baseHeaders(requestId), ...(rest.headers as Record<string, string> | undefined) }
  return new Response(JSON.stringify(data), { ...rest, headers })
}

/**
 * 管理端错误响应。
 * @param status HTTP 状态码
 * @param error  面向用户的中文错误说明
 * @param requestId 请求 ID（建议传入，便于排障）
 */
export function jsonError(status: number, error: string, requestId?: string): Response {
  const body: ApiErrorBody = requestId ? { error, requestId } : { error }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...baseHeaders(requestId) },
  })
}

/**
 * OpenAI 兼容错误响应（网关 /v1/* 使用）。
 * 客户端 SDK 依赖 { error: { message, type } } 结构解析错误，改动会破坏兼容性。
 */
export function openAiError(
  message: string,
  type: string,
  status: number,
  opts?: { code?: string | null; headers?: Record<string, string>; requestId?: string }
): Response {
  const body: OpenAiErrorBody = {
    error: { message, type, code: opts?.code ?? null },
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...baseHeaders(opts?.requestId),
      ...(opts?.headers ?? {}),
    },
  })
}

/** 401 未登录（管理端统一入口，配合 auth.unauthorized 使用） */
export function jsonUnauthorized(requestId?: string): Response {
  return jsonError(401, '未登录或登录已过期', requestId)
}

/** 400 请求体非法 */
export function jsonBadRequest(error: string, requestId?: string): Response {
  return jsonError(400, error, requestId)
}

/** 429 限流（带 Retry-After） */
export function jsonRateLimited(error: string, retryAfterSec: number, requestId?: string): Response {
  const body: ApiErrorBody = requestId ? { error, requestId } : { error }
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.max(1, Math.floor(retryAfterSec))),
      ...baseHeaders(requestId),
    },
  })
}

/** 500 内部错误（不泄漏堆栈细节，只给通用说明 + requestId） */
export function jsonServerError(requestId?: string, detail?: string): Response {
  return jsonError(500, detail ? `服务器内部错误：${detail}` : '服务器内部错误', requestId)
}