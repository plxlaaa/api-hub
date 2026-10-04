export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 0) 先确保数据表与 PRAGMA 就绪：容器/全新安装时库是空文件，
    //    不先建表的话探测调度器与所有接口都会抛 P2021（table does not exist）
    try {
      const { dbReady } = await import('@/lib/db')
      await dbReady
    } catch (err) {
      console.error('[instrumentation] database bootstrap failed:', err)
    }
    // 1) 探针调度器（每 60s 全量探测渠道，驱动熔断恢复）
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