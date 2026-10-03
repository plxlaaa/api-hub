import type { Metadata } from 'next'
import { SquareClient } from './square-client'

export const metadata: Metadata = {
  title: '模型广场 · API Hub',
  description: '可用模型、渠道实时状态与价格一览。',
}

export default function SquarePage() {
  return <SquareClient />
}
