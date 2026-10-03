import type { Channel } from '@/types'
import type { StatusKind } from '@/components/metrics'

/**
 * 渠道状态 → 语义色/文案的单一映射。
 * 之前散落在各 Tab 的三元表达式里（且亮/暗两套硬编码色），
 * 这里统一到语义 token，暗色模式自动正确。
 */
export function channelStatus(c: Channel): { kind: StatusKind; label: string; live: boolean; hint: string } {
  if (c.autoDisabled) {
    return {
      kind: 'danger',
      label: '熔断中',
      live: false,
      hint: `连续失败 ${c.failStreak} 次，已自动摘除；探测恢复后自动加回`,
    }
  }
  if (!c.enabled) return { kind: 'idle', label: '停用', live: false, hint: '已停用，不参与路由' }
  switch (c.status) {
    case 'online':
      return { kind: 'ok', label: '在线', live: true, hint: '探测正常' }
    case 'offline':
      return {
        kind: 'danger',
        label: c.failStreak > 1 ? `离线（${c.failStreak} 连败）` : '离线',
        live: false,
        hint: c.lastError ?? '最近一次探测失败',
      }
    default:
      return { kind: 'warn', label: '未知', live: false, hint: c.lastError ?? '尚未探测' }
  }
}

/** 成功率分档：<80% 警告，<95% 提示 */
export function successKind(rate: number): StatusKind {
  if (rate >= 95) return 'ok'
  if (rate >= 80) return 'info'
  if (rate >= 50) return 'warn'
  return 'danger'
}

/** HTTP 状态码 → 语义色 */
export function httpKind(code: number | null | undefined): StatusKind {
  if (code == null) return 'idle'
  if (code >= 500) return 'danger'
  if (code >= 400) return 'warn'
  if (code >= 200 && code < 300) return 'ok'
  if (code >= 300) return 'info'
  return 'idle'
}

const FORMAT_LABEL: Record<Channel['apiFormat'], string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Claude 原生',
  gemini: 'Gemini 原生',
}

export function formatLabel(f: Channel['apiFormat']): string {
  return FORMAT_LABEL[f] ?? f
}
