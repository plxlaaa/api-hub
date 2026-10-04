import { probeChannelById } from '@/lib/probe'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const { id } = await params
  try {
    const result = await probeChannelById(id)
    return Response.json(result)
  } catch (err) {
    // 只有「渠道不存在」才是 404；DB 锁 / 内部异常一律 500，
    // 否则真实故障会被伪装成「渠道不存在」，排障时被误导。
    const notFound = err instanceof Error && err.message === '渠道不存在'
    return Response.json(
      { error: err instanceof Error ? err.message : '探测失败' },
      { status: notFound ? 404 : 500 }
    )
  }
}