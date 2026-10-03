'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { Toaster } from 'sonner'
import Home from '@/components/app-shell'

/**
 * 应用入口：仅负责 QueryClient 与全局 Toast。
 * 外壳、导航与各 Tab 视图都在 @/components/app-shell 中。
 */
export default function Page() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            // 面板是运维工具：窗口重新聚焦时刷新，避免看到过期状态
            refetchOnWindowFocus: true,
            staleTime: 5_000,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <Home />
      <Toaster position="top-center" richColors closeButton />
    </QueryClientProvider>
  )
}
