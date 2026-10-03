import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const logs = await db.probeLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 60,
    include: { channel: { select: { name: true } } },
  })
  return Response.json(
    logs.map((l) => ({
      id: l.id,
      channelName: l.channel.name,
      ok: l.ok,
      latencyMs: l.latencyMs,
      statusCode: l.statusCode,
      error: l.error,
      createdAt: l.createdAt,
    }))
  )
}
