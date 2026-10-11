import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonBadRequest, jsonOk } from '@/lib/api-response'
import { invalidateRouteCache } from '@/lib/route-cache'

export const dynamic = 'force-dynamic'

/** 自动建路由上限：聚合导入可能拉回几十上百个模型，全建会刷爆路由表 */
const MAX_MODELS = 30

interface ChannelConfig {
  id: string
  model?: string
}

/** 解析路由的 channelConfigs 存储（JSON 字符串或已是数组） */
function parseChannelConfigs(v: unknown): ChannelConfig[] {
  if (Array.isArray(v)) return v as ChannelConfig[]
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v)
      return Array.isArray(arr) ? (arr as ChannelConfig[]) : []
    } catch {
      return []
    }
  }
  return []
}

// 聚合自动建路由：对给定渠道，按模型列表分组——多站同模型合并进同一路由
// （权重负载均衡 + 故障转移天然生效）；已存在的同名路由把新渠道追加进去（去重）。
// 这是「一次粘贴 → 渠道+路由全就绪」聚合链路的最后一环。
export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const requestId = resolveRequestId(req)
  const body = (await req.json().catch(() => null)) as { channelIds?: unknown } | null
  const channelIds = Array.isArray(body?.channelIds) ? (body!.channelIds as string[]) : []
  if (channelIds.length === 0) return jsonBadRequest('至少选择一个渠道', requestId)

  const channels = await db.channel.findMany({ where: { id: { in: channelIds } } })
  if (channels.length === 0) return jsonBadRequest('渠道不存在', requestId)

  // 聚合分组：模型 → 持有该模型的渠道 id 列表（去重）
  const map = new Map<string, string[]>()
  for (const c of channels) {
    let models: string[] = []
    try {
      models = JSON.parse(c.models || '[]')
    } catch {
      models = []
    }
    for (const m of models) {
      const list = map.get(m)
      if (list) {
        if (!list.includes(c.id)) list.push(c.id)
      } else {
        map.set(m, [c.id])
      }
    }
  }
  if (map.size === 0) return jsonBadRequest('所选渠道均无模型列表（先探测或手动填写）', requestId)

  // 已有路由：displayName → 记录（同名合并）
  const existingRoutes = await db.modelRoute.findMany()
  const byName = new Map(existingRoutes.map((r) => [r.displayName, r]))

  const createdRoutes: string[] = []
  const mergedRoutes: Array<{ route: string; added: string[] }> = []
  const limited: string[] = []

  // 多渠道共享的模型优先建（聚合价值最高），其次按名称排序保证结果稳定
  const sortedModels = [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))

  for (const [model, chIds] of sortedModels) {
    if (createdRoutes.length >= MAX_MODELS) {
      limited.push(model)
      continue
    }
    const exists = byName.get(model)
    if (exists) {
      // 合并：把新渠道 append 进 channelConfigs（去重），channelIds 同步重算
      const cfgs = parseChannelConfigs(exists.channelConfigs)
      const before = new Set(cfgs.map((c) => c.id))
      const added: string[] = []
      for (const id of chIds) {
        if (!before.has(id)) {
          cfgs.push({ id })
          added.push(id)
        }
      }
      if (added.length > 0) {
        await db.modelRoute.update({
          where: { id: exists.id },
          data: {
            channelConfigs: JSON.stringify(cfgs),
            channelIds: JSON.stringify(cfgs.map((c) => c.id)),
          },
        })
        mergedRoutes.push({ route: model, added: added.map((id) => channels.find((c) => c.id === id)?.name ?? id) })
      }
    } else {
      const cfgs = chIds.map((id) => ({ id }))
      await db.modelRoute.create({
        data: {
          displayName: model,
          targetModel: model,
          channelIds: JSON.stringify(cfgs.map((c) => c.id)),
          channelConfigs: JSON.stringify(cfgs),
          enabled: true,
        },
      })
      createdRoutes.push(model)
    }
  }

  if (createdRoutes.length > 0 || mergedRoutes.length > 0) invalidateRouteCache()

  return jsonOk(
    {
      created: createdRoutes,
      merged: mergedRoutes,
      limited,
      limit: MAX_MODELS,
    },
    { requestId }
  )
}
