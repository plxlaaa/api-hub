/**
 * 复制文本到剪贴板，带降级方案。
 * navigator.clipboard 仅在安全上下文（HTTPS / localhost）可用；
 * 通过 IP + HTTP 访问时需降级为 execCommand('copy')。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 首选：异步 Clipboard API（安全上下文）
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 权限被拒等场景继续走降级 */
    }
  }

  // 降级：隐藏 textarea + execCommand（非安全上下文可用，但需用户手势触发）
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    const selection = document.getSelection()
    const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    // 恢复用户先前的选区，避免页面滚动跳位
    if (savedRange && selection) {
      selection.removeAllRanges()
      selection.addRange(savedRange)
    }
    return ok
  } catch {
    return false
  }
}
