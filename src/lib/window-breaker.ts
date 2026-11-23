/**
 * 滑动窗口成功率熔断（学习 one-api monitor/metric.go 思想）。
 *
 * 病灶：failStreak 连败计数抓不到「间歇性失败」渠道——
 * 成功-失败-成功-失败抖动的渠道连败永远到不了阈值，路由却频繁感知到失败转移。
 *
 * 方案：每渠道内存滑窗记录最近 WINDOW 次转发结果，窗口满且成功率低于
 * RATE 时触发熔断（与 failStreak 并行的第二条摘除路径，走同一 autoDisabled
 * 体系——半开试探成功即回切，恢复逻辑完全复用）。
 *
 * 触发后清零窗口重新积累：一次误判不会永久盯死渠道。
 */

/** 窗口长度（每渠道记录最近 N 次真实转发结果） */
export const WINDOW_SIZE = 20

/** 成功率阈值（窗口满且低于此值触发熔断；0.5 = 近 20 次成功率不足 50%） */
export const TRIP_RATE = 0.5

export interface WindowState {
  results: boolean[]
}

/**
 * 纯函数：写入一次结果并判断是否触发。
 * @returns tripped=触发熔断（窗口满且成功率低于阈值）；successRate=当前窗口成功率
 */
export function consumeAndCheck(state: WindowState, ok: boolean): { tripped: boolean; successRate: number } {
  const w = state.results
  w.push(ok)
  if (w.length > WINDOW_SIZE) w.shift()
  const okCount = w.filter(Boolean).length
  const successRate = w.length / WINDOW_SIZE < 1 ? okCount / w.length : okCount / WINDOW_SIZE
  // 窗口未满不触发：样本太少，误判率高
  if (w.length < WINDOW_SIZE) return { tripped: false, successRate }
  if (okCount / WINDOW_SIZE < TRIP_RATE) {
    // 触发后清零窗口：重新积累，不盯死
    w.length = 0
    return { tripped: true, successRate: okCount / WINDOW_SIZE }
  }
  return { tripped: false, successRate }
}

/** 全局单例（dev 热重载安全，与 startProbeScheduler 同款 globalThis 模式） */
function store(): Map<string, WindowState> {
  const g = globalThis as unknown as { __gwWindowBreaker?: Map<string, WindowState> }
  g.__gwWindowBreaker ??= new Map()
  return g.__gwWindowBreaker
}

/** 记录一次转发结果（gateway 转发成功/失败处调用），返回是否触发熔断 */
export function emitWindowResult(channelId: string, ok: boolean): { tripped: boolean; successRate: number } {
  const m = store()
  let st = m.get(channelId)
  if (!st) {
    st = { results: [] }
    m.set(channelId, st)
  }
  return consumeAndCheck(st, ok)
}

/** 渠道被手动删除/禁用时清窗，避免脏样本影响复用同名新渠道 */
export function clearWindow(channelId: string): void {
  store().delete(channelId)
}

/** 测试用：清空全部窗口 */
export function clearAllWindows(): void {
  store().clear()
}
