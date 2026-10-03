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
    return Response.json({ error: err instanceof Error ? err.message : '探测失败' }, { status: 404 })
  }
}
