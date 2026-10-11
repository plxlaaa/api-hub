import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { normalizeBaseUrl, fetchUpstreamModels } from '@/lib/probe'
import { resolveRequestId, jsonBadRequest, jsonOk } from '@/lib/api-response'
import { parseImportLines } from '@/lib/channel-import'

export const dynamic = 'force-dynamic'

/** 并发上限：导入的站可能不少，全并发会瞬时打满出口连接 */
const PROBE_CONCURRENCY = 4

// 聚合批量导入：一行一个渠道（竖线完整格式或 baseUrl,key 速记），
// 建渠道后并发拉取各站 /models 回写模型列表，返回聚合报告（哪些站活、各有哪些模型）。
// 报告供前端「一键建路由」使用（POST /api/routes/auto），完成 粘贴→渠道→路由 的全聚合。
export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const requestId = resolveRequestId(req)
  const body = await req.json().catch(() => null)
  const text = typeof (body as Record<string, unknown> | null)?.text === 'string' ? (body as { text: string }).text : ''
  if (!text.trim()) return jsonBadRequest('导入内容为空', requestId)

  const { channels, failed } = parseImportLines(text)

  // 同名跳过（保留现有渠道），名称冲突时自动加后缀避免整行丢失
  const existing = new Set((await db.channel.findMany({ select: { name: true } })).map((c) => c.name))
  const created: Array<{ id: string; name: string; baseUrl: string; apiKey: string; apiFormat: string; models: string[] }> = []
  const skipped: Array<{ line: number; name: string; reason: string }> = []
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i]
    const lineNo = i + 1
    let name = ch.name
    if (existing.has(name)) {
      // 速记格式会从域名生成重名（同站两把 Key），自动加序号而不是丢弃
      let n = 2
      while (existing.has(`${ch.name}~${n}`)) n++
      name = `${ch.name}~${n}`
      skipped.push({ line: lineNo, name: ch.name, reason: `同名，已自动命名为 ${name}` })
    }
    try {
      const row = await db.channel.create({
        data: {
          name,
          baseUrl: normalizeBaseUrl(ch.baseUrl),
          apiKey: ch.apiKey,
          apiFormat: ch.apiFormat,
          models: JSON.stringify(ch.models),
        },
      })
      existing.add(name)
      created.push({ id: row.id, name, baseUrl: row.baseUrl, apiKey: row.apiKey, apiFormat: row.apiFormat, models: ch.models })
    } catch (e) {
      failed.push({ line: lineNo, error: e instanceof Error ? e.message : '写入失败' })
    }
  }

  // 并发拉取各站模型列表（有并发上限），成功则回写渠道 models 字段
  const report: Array<{ id: string; name: string; alive: boolean; models: string[]; error: string | null }> = []
  for (let i = 0; i < created.length; i += PROBE_CONCURRENCY) {
    const batch = created.slice(i, i + PROBE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (ch) => {
        const r = await fetchUpstreamModels(ch.baseUrl, ch.apiKey, ch.apiFormat)
        if (r.ok && r.models.length > 0) {
          // 回写实时模型列表（导入时手填的 models 只是初值，实测列表更可信）
          await db.channel.update({ where: { id: ch.id }, data: { models: JSON.stringify(r.models) } }).catch(() => null)
          return { id: ch.id, name: ch.name, alive: true, models: r.models, error: null }
        }
        // 拉取失败但手填过模型列表 → 渠道仍可用（探测可能被站限流），如实标注
        return { id: ch.id, name: ch.name, alive: false, models: ch.models, error: r.error }
      })
    )
    report.push(...results)
  }

  return jsonOk(
    {
      created: report.map((r) => r.name), // 兼容旧字段：所有建成功的渠道名
      skipped,
      failed,
      report, // 聚合报告：每渠道 存活/模型列表/错误
    },
    { requestId }
  )
}
