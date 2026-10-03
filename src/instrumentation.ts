export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 1) 探针调度器（原有逻辑，保持不变）
    try {
      const { startProbeScheduler } = await import('@/lib/probe')
      startProbeScheduler()
    } catch (err) {
      console.error('[instrumentation] probe scheduler failed to start:', err)
    }
    // 2) 首次设置令牌：未初始化管理员时生成并打印到控制台（防公网暴露被抢注）
    try {
      const { ensureSetupTokenOnBoot } = await import('@/lib/credentials')
      await ensureSetupTokenOnBoot()
    } catch (err) {
      console.error('[instrumentation] setup token bootstrap failed:', err)
    }
  }
}
