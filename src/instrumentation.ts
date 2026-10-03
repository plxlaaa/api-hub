export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startProbeScheduler } = await import('@/lib/probe')
      startProbeScheduler()
    } catch (err) {
      console.error('[instrumentation] probe scheduler failed to start:', err)
    }
  }
}
