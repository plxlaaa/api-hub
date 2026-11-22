/**
 * Webhook 告警推送（学习 one-api monitor.notifyRootUser 思想）：
 * 渠道被自动熔断摘除 / 半开恢复时向配置的 webhook URL 发 POST 通知。
 *
 * - Setting key: alertWebhookUrl（管理台设置区配置，空 = 不推送）
 * - fire-and-forget：10s 超时，失败只记日志，绝不影响转发主流程
 * - 内容脱敏沿用 redactSecrets（webhook 端可能是第三方服务）
 */
import { db } from '@/lib/db'
import { log } from '@/lib/logger'

const ALERT_WEBHOOK_TIMEOUT_MS = 10_000

export type AlertEvent = 'channel_disabled' | 'channel_recovered' | 'channel_probe_failed'

export interface AlertPayload {
  event: AlertEvent
  channel: string
  message: string
  ts: string
  gateway: string
}

/** 拉取已配置的 webhook URL（每次现读，改配置即时生效；无配置返回 null） */
async function getWebhookUrl(): Promise<string | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: 'alertWebhookUrl' } })
    const url = row?.value?.trim()
    return url && /^https?:\/\//.test(url) ? url : null
  } catch {
    return null
  }
}

/** 发送告警（内部工具，fire-and-forget） */
async function sendAlert(url: string, payload: AlertPayload): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS),
    })
    if (!res.ok) log.warn('告警 webhook 返回异常', { event: payload.event, status: res.status })
  } catch (err) {
    log.warn('告警 webhook 发送失败', { event: payload.event, error: err instanceof Error ? err.message : String(err) })
  }
}

/** 渠道事件告警入口：无 webhook 配置时静默跳过 */
export function notifyChannelEvent(event: AlertEvent, channelName: string, message: string): void {
  void (async () => {
    try {
      const url = await getWebhookUrl()
      if (!url) return
      const payload: AlertPayload = {
        event,
        channel: channelName,
        message,
        ts: new Date().toISOString(),
        gateway: 'api-hub',
      }
      await sendAlert(url, payload)
    } catch (err) {
      log.warn('告警流程异常', { event, error: err instanceof Error ? err.message : String(err) })
    }
  })()
}

/** 管理台「测试推送」按钮：立即发一条测试告警，返回是否可送达（非 2xx 也算发出） */
export async function sendTestAlert(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const payload: AlertPayload = {
      event: 'channel_recovered',
      channel: '（测试）',
      message: '这是一条 api-hub 告警测试推送，收到即代表链路通。',
      ts: new Date().toISOString(),
      gateway: 'api-hub',
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS),
    })
    return { ok: res.ok, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
