import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseMetadata } from '@/lib/metadata'
import { resolveRequestId, jsonOk, jsonBadRequest } from '@/lib/api-response'
import { Validator, validationResponse } from '@/lib/validate'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

export async function GET(req: Request) {
  const requestId = resolveRequestId(req)
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
  return jsonOk(
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
    }),
    { requestId }
  )
}

export async function POST(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied
  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法', requestId)

  const v = new Validator(body)
  const name = v.string('name', { required: true, max: 80 })
  // 配额：缺省/空 = 不限；正整数 = 请求次数上限
  const quotaLimit = v.integer('quotaLimit', { min: 1, max: 100_000_000 })
  const metadata = v.object('metadata')
  if (v.failed()) return validationResponse(v)

  const key = `sk-gw-${randomBytes(24).toString('base64url')}`
  const m = parseMetadata(metadata)
  const token = await db.apiToken.create({ data: { name, key, quotaLimit: quotaLimit ?? null, ...(m ? { metadata: m } : {}) } })
  log.info('统一密钥已创建', { requestId, tokenId: token.id, name, quotaLimit: quotaLimit ?? null })
  // 创建时返回完整 key（仅此一次可见）
  return jsonOk({ id: token.id, key: token.key }, { requestId })
}
