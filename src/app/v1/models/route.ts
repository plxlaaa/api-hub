import { handleListModels } from '@/lib/gateway'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return handleListModels(req)
}
