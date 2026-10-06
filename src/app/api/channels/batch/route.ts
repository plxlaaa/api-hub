import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeBaseUrl } from '@/lib/probe'
import { resolveRequestId, jsonBadRequest } from '@/lib/api-response'

export const dynamic = 'force-dynamic'

// 批量导入渠道：一行一个渠道，竖线分隔
// 格式：名称 | baseUrl | apiKey | 模型列表(逗号分隔,可选) | apiFormat(可选 openai/anthropic)
// 示例：克劳德2 | https://xxx.com/v1 | sk-xxx | claude-sonnet-4, claude-opus-4 | anthropic
export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const requestId = resolveRequestId(req)
  const body = await req.json().catch(() => null)
  const text = typeof (body as Record<string, unknown> | null)?.text === 'string' ? (body as { text: string }).text : ''
  if (!text.trim()) return jsonBadRequest('导入内容为空', requestId)

  // 已有渠道名集合（同名跳过，避免重复建渠道）
  const existing = new Set((await db.channel.findMany({ select: { name: true } })).map((c) => c.name))

  const lines = text.split(/\r?\n/)
  const created: string[] = []
  const skipped: Array<{ line: number; name: string; reason: string }> = []
  const failed: Array<{ line: number; error: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue // 空行忽略
    const lineNo = i + 1
    const parts = raw.split('|').map((s) => s.trim())
    const [name, baseUrl, apiKey, modelsRaw, formatRaw] = parts

    if (parts.length < 3) {
      failed.push({ line: lineNo, error: `格式需至少 3 段：名称 | baseUrl | apiKey（当前 ${parts.length} 段）` })
      continue
    }
    if (!name) { failed.push({ line: lineNo, error: '名称为空' }); continue }
    if (existing.has(name)) { skipped.push({ line: lineNo, name, reason: '同名渠道已存在' }); continue }
    if (!normalizeBaseUrl(baseUrl).match(/^https?:\/\//)) { failed.push({ line: lineNo, error: 'baseUrl 无效' }); continue }
    if (!apiKey) { failed.push({ line: lineNo, error: 'apiKey 为空' }); continue }

    const models = (modelsRaw || '')
      .split(/[,，]/)
      .map((m) => m.trim())
      .filter(Boolean)
    const apiFormat = formatRaw === 'anthropic' ? 'anthropic' : 'openai'

    try {
      await db.channel.create({
        data: {
          name,
          baseUrl: normalizeBaseUrl(baseUrl),
          apiKey,
          apiFormat,
          models: JSON.stringify(models),
        },
      })
      existing.add(name)
      created.push(name)
    } catch (e) {
      failed.push({ line: lineNo, error: e instanceof Error ? e.message : '写入失败' })
    }
  }

  return Response.json({ created, skipped, failed })
}
