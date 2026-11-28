'use client'

import { useState } from 'react'
import { Download, Loader2, MoreVertical, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type ReleaseInfo = {
  android: { tag: string; apkUrl: string } | null
  server: string | null
}

/**
 * 右上角 ⋮ 菜单：检查更新。
 * 刻意不放登录态之后——手机端「登录前也要能查更新」（登录被卡住时唯一的自救入口）。
 * 前端直连 GitHub API（公开仓库，无需认证/CORS 允许），APK 下载走系统下载器。
 */
export function UpdateMenu() {
  const [checking, setChecking] = useState(false)
  const [info, setInfo] = useState<ReleaseInfo | null>(null)
  const [error, setError] = useState('')

  const check = async () => {
    setChecking(true)
    setError('')
    setInfo(null)
    try {
      const [androidRes, serverRes] = await Promise.allSettled([
        fetch('https://api.github.com/repos/plxlaaa/api-hub-android/releases/latest', { cache: 'no-store' }),
        fetch('https://api.github.com/repos/plxlaaa/api-hub/releases/latest', { cache: 'no-store' }),
      ])
      let next: ReleaseInfo = { android: null, server: null }
      if (androidRes.status === 'fulfilled' && androidRes.value.ok) {
        const d = await androidRes.value.json()
        const apk = (d.assets || []).find((a: { name: string }) => a.name === 'app-debug.apk')
        if (d.tag_name) next.android = { tag: d.tag_name, apkUrl: apk ? apk.browser_download_url : '' }
      }
      if (serverRes.status === 'fulfilled' && serverRes.value.ok) {
        const d = await serverRes.value.json()
        if (d.tag_name) next.server = d.tag_name
      }
      setInfo(next)
    } catch {
      setError('检查失败，请稍后再试')
    } finally {
      setChecking(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="touch-target-icon h-9 w-9"
          aria-label="更多菜单"
          title="更多菜单"
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem
          disabled={checking}
          onSelect={() => {
            void check()
          }}
          className="gap-2"
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          检查更新
        </DropdownMenuItem>

        {info && !checking && (
          <div className="border-t px-2 py-2 text-sm">
            {info.android ? (
              <div className="flex items-center justify-between gap-2 px-2 py-1">
                <div className="min-w-0">
                  <div className="font-medium">安卓应用 {info.android.tag}</div>
                  <div className="text-micro text-muted-foreground">下载安装包升级（系统浏览器完成）</div>
                </div>
                {info.android.apkUrl && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={info.android.apkUrl} download>
                      <Download className="h-3.5 w-3.5" />
                      下载
                    </a>
                  </Button>
                )}
              </div>
            ) : (
              <div className="px-2 py-1 text-muted-foreground">安卓版暂无发布</div>
            )}
            {info.server && (
              <div className="px-2 py-1 text-muted-foreground">网关最新版：{info.server}</div>
            )}
            {error && <div className="px-2 py-1 text-status-danger">{error}</div>}
          </div>
        )}
        {!info && !checking && error && (
          <div className="border-t px-3 py-2 text-sm text-status-danger">{error}</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
