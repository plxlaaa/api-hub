import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseMetadata } from '@/lib/metadata'

export const dynamic = 'force-dynamic'

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const tokens = await db.apiToken.findMany({ orderBy: { createdAt: 'desc' } })
  // 密钥用量：按密钥名聚合调用日志（次数/Token/最近调用）
  const usage = await db.requestLog.groupBy({
    by: ['tokenName'],
    _count: { _all: true },
    _sum: { totalTokens: true },
    _max: { createdAt: true },
  })
  const usageMap = new Map(usage.map((u) => [u.tokenName, u]))
  return Response.json(
    tokens.map((t) => {
      const u = usageMap.get(t.name)
      return {
        id: t.id,
        name: t.name,
        key: maskKey(t.key),
        enabled: t.enabled,
        quotaLimit: t.quotaLimit,
        quotaUsed: t.quotaUsed,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
        usage: u
          ? { calls: u._count._all, tokens: u._sum.totalTokens ?? 0, lastCallAt: u._max.createdAt }
          : { calls: 0, tokens: 0, lastCallAt: null },
      }
    })
  )
}

export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  const name = (body as Record<string, unknown> | null)?.name
  if (typeof name !== 'string' || !name.trim()) {
    return Response.json({ error: '密钥名称必填' }, { status: 400 })
  }
  // 配额：null/undefined = 不限；正整数 = 请求次数上限
  const rawQuota = (body as Record<string, unknown> | null)?.quotaLimit
  const quotaLimit =
    rawQuota === null || rawQuota === undefined || rawQuota === ''
      ? null
      : Number.isFinite(Number(rawQuota)) && Number(rawQuota) > 0
        ? Math.floor(Number(rawQuota))
        : null
  const key = `sk-gw-${randomBytes(24).toString('base64url')}`
  const m = parseMetadata((body as Record<string, unknown>).metadata)
  const token = await db.apiToken.create({ data: { name: name.trim(), key, quotaLimit, ...(m ? { metadata: m } : {}) } })
  // 创建时返回完整 key（仅此一次可见）
  return Response.json({ id: token.id, key: token.key })
}
