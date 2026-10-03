'use client'

import { useTheme } from 'next-themes'
import { useSyncExternalStore } from 'react'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

const emptySubscribe = () => () => {}
// SSR 时为 false（渲染占位图标），客户端挂载后为 true，避免水合不一致
const useMounted = () => useSyncExternalStore(emptySubscribe, () => true, () => false)

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useMounted()

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="切换主题">
        <Sun className="h-4 w-4 opacity-0" />
      </Button>
    )
  }

  const isDark = resolvedTheme === 'dark'
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-9 w-9"
      aria-label={isDark ? '切换到亮色模式' : '切换到暗色模式'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}
