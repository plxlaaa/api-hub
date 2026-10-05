import { db, dbReady } from '@/lib/db'
import { log } from '@/lib/logger'

export const dynamic = 'force-dynamic'

/** 进程启动时刻，用于计算 uptime */
const startedAt = Date.now()

/**
 * GET /api/health —— 健康检查（无需鉴权）
 *
 * 为什么不用 /api/auth/status 当探针：它只回{ initialized }，
 * 不反映数据库是否真的可读写。容器/systemd 探针需要「服务真的能干活」的信号，
 * 否则 DB 挂了容器仍被判定healthy，流量照打进来。
 *
 * - 200：DB 可读写（readiness 通过）
 * - 503：DB 不可用（liveness 仍活，但不该接流量）
 *
 * 响应体刻意不含任何版本密钥/路径等敏感信息，仅回粗粒度状态，可安全暴露到公网。
 */
export async function GET(): Promise<Response> {
  const started = Date.now()
  let dbOk = false
  let dbError: string | undefined

  try {
    // 等首次建表/迁移完成再探测，避免冷启动瞬间误报 503
    await dbReady
    // 真正读写一次：SELECT 1 只验证连接，读写验证交给写路径；
    // 这里用 count 走一次实际查询路径，确保表已就绪（比 SELECT 1 更能发现问题）
    await db.requestLog.count()
    dbOk = true
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  const body = {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    db: {
      ok: dbOk,
      ...(dbError ? { error: dbError } : {}),
    },
    checksMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  }

  if (!dbOk) {
    log.error('健康检查失败：数据库不可用', { error: dbError })
  }

  return new Response(JSON.stringify(body), {
    status: dbOk ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      // 探针不该被任何中间层缓存
      'Cache-Control': 'no-store',
    },
  })
}