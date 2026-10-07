import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { resolveRequestId, jsonOk, jsonServerError, jsonBadRequest } from '@/lib/api-response'
import { planImport, resolveChannelRefs, buildImportResult } from '@/lib/config-import'
import { checkUpstreamUrlWithDns, allowsInternalUrl } from '@/lib/url-safety'
import { normalizeChannelConfigs } from '@/lib/route-config'
import { invalidateRouteCache } from '@/lib/route-cache'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/config/import —— 导入配置（渠道 + 路由）
 *
 * ⚠️ 历史缺陷修复：本文件此前是 /api/channels/fetch-models 的整份复制粘贴，
 * 返回的是 { models } —— 而仪表盘、渠道页、CLI 三处调用方都把它当「导入结果」用，
 * 于是备份恢复功能整体失效（界面提示「导入完成」但实际什么都没导入）。
 * 现按 docs/API.md 的契约真正实现导入。
 *
 * 兼容两种请求形状（三处调用方历史写法不一，见 lib/config-import.ts 注释）：
 *   A) 裸配置体：直接 POST 导出的 JSON
 *   B) 包装体：{ mode: 'merge'|'replace', data: <配置体> }
 *
 * 语义：
 * - merge（默认）：按渠道名 / 路由 displayName 去重，已存在的跳过不动
 * - replace：先清空现有渠道与路由再导入（危险操作，会记 warn 日志）
 *
 * 安全：导入的 baseUrl 会成为服务端主动出网的目标，故必须过 SSRF 校验；
 * 指向内网的条目直接拒绝，而不是「导入成功、运行时才炸」。
 */
export async function POST(req: Request) {
  const requestId = resolveRequestId(req)
  const denied = await requireAdmin(req)
  if (denied) return denied

  const body = await req.json().catch(() => null)
  if (!body) return jsonBadRequest('请求体非法，需为导入的 JSON 或 { mode, data }', requestId)

  const plan = planImport(body)
  if (!plan) {
    return jsonBadRequest(
      '无法识别的导入格式：应为导出的配置 JSON（含 channels/routes），或 { mode, data } 包装',
      requestId
    )
  }
  const { mode, config, warnings } = plan
  if (config.channels.length === 0 && config.routes.length === 0) {
    return jsonBadRequest('导入文件里没有任何渠道或路由', requestId)
  }

  try {
    // replace 模式：先清空再插，避免「旧的还在、新的又进来」的重复数据
    if (mode === 'replace') {
      log.warn('配置导入为 replace 模式，将清空现有渠道与路由', { requestId })
      await db.channel.deleteMany({})
      await db.modelRoute.deleteMany({})
    }

    // ---- 渠道：按名字去重，逐条创建 ----
    let channelsAdded = 0
    let channelsSkipped = 0
    let channelsMissingKey = 0
    /** 渠道名 → 本地 id，供路由引用反查 */
    const nameToId = new Map<string, string>()
    for (const c of await db.channel.findMany({ select: { id: true, name: true } })) {
      nameToId.set(c.name, c.id)
    }

    for (const ch of config.channels) {
      // SSRF 校验：不通过就不导入这个渠道
      const checked = await checkUpstreamUrlWithDns(ch.baseUrl, allowsInternalUrl(ch.metadata) || allowsInternalUrl(ch.remark))
      if (!checked.ok) {
        warnings.push(`渠道「${ch.name}」地址不安全已跳过：${checked.reason}`)
        channelsSkipped++
        continue
      }
      // 导出时若未带 keys，密钥会为空 —— 合法，但要在结果里告诉用户去补填
      if (!ch.apiKey) channelsMissingKey++
      // 已存在同名渠道：跳过，不覆盖用户改过的密钥
      if (nameToId.has(ch.name)) {
        channelsSkipped++
        continue
      }
      const created = await db.channel.create({
        data: {
          name: ch.name,
          baseUrl: checked.url,
          apiKey: ch.apiKey,
          apiFormat: ch.apiFormat,
          models: JSON.stringify(ch.models),
          enabled: ch.enabled,
          remark: ch.remark,
          ...(ch.metadata ? { metadata: ch.metadata } : {}),
          // 导入的渠道一律从「未知」状态起步，等探测调度器给出真实结论
          status: 'unknown',
        },
        select: { id: true },
      })
      nameToId.set(ch.name, created.id)
      channelsAdded++
    }

    // ---- 路由：按 displayName 去重，渠道引用按名反查 id ----
    let routesAdded = 0
    let routesSkipped = 0
    let refsDropped = 0
    const existingRoutes = new Set(
      (await db.modelRoute.findMany({ select: { displayName: true } })).map((r) => r.displayName)
    )

    for (const rt of config.routes) {
      if (existingRoutes.has(rt.displayName)) {
        routesSkipped++
        continue
      }
      const { resolved, missing } = resolveChannelRefs(rt.channels, nameToId)
      if (missing.length > 0) {
        refsDropped += missing.length
        warnings.push(
          `路由「${rt.displayName}」引用了本机不存在的渠道：${missing.join('、')}（已剔除，其余渠道不受影响）`
        )
      }
      // 引用全部失效时不导入这条路由：一条没有任何渠道的路由只会在调用时
      // 返回 502，留着反而是垃圾数据
      if (resolved.length === 0 && rt.channels.length > 0) {
        warnings.push(`路由「${rt.displayName}」的渠道全部无法匹配，已跳过该路由`)
        routesSkipped++
        continue
      }
      const cfgs = normalizeChannelConfigs(resolved)
      const ids = resolved.map((r) => r.id)

      await db.modelRoute.create({
        data: {
          displayName: rt.displayName,
          targetModel: rt.targetModel,
          channelIds: JSON.stringify(ids),
          channelConfigs: JSON.stringify(cfgs ?? ids.map((id) => ({ id }))),
          strategy: rt.strategy,
          priceIn: rt.priceIn,
          priceOut: rt.priceOut,
          enabled: rt.enabled,
          remark: rt.remark,
          ...(rt.metadata ? { metadata: rt.metadata } : {}),
        },
      })
      routesAdded++
    }

    // 导入增删了大量路由，网关缓存必须立即失效（replace 模式更是全表重写）
    invalidateRouteCache()

    const result = buildImportResult({
      channelsAdded,
      channelsSkipped,
      routesAdded,
      routesSkipped,
      channelsMissingKey,
      refsDropped,
      warnings,
    })
    log.info('配置导入完成', {
      requestId,
      mode,
      channelsAdded,
      channelsSkipped,
      routesAdded,
      routesSkipped,
      refsDropped,
    })
    return jsonOk(result, { requestId })
  } catch (err) {
    log.error('配置导入失败', { requestId, error: err })
    return jsonServerError(requestId, err instanceof Error ? err.message : '导入失败')
  }
}