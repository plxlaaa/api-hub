import { probeAllChannels } from '@/lib/probe'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  await probeAllChannels()
  return Response.json({ ok: true })
}
