import { handleChatCompletions } from '@/lib/gateway'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request) {
  return handleChatCompletions(req)
}
