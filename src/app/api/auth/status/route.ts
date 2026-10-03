import { isInitialized } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return Response.json({ initialized: await isInitialized() })
  } catch {
    return Response.json({ initialized: false })
  }
}
