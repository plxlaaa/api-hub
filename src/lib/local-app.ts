import path from 'node:path'
import fs from 'node:fs'

/**
 * 本地应用模式（Android APK 壳）判定 —— 双通道：
 *
 * 1) GW_AUTH_DISABLED=1 环境变量（Termux / 手动部署可用）
 * 2) cwd 下存在 .auth-disabled 标记文件（APK 壳写入）
 *    —— bun android experimental 二进制曾出现 spawn env 读取不可靠的情况
 *    （沙箱 x64 正常、真机 bionic 上 process.env 取不到注入值），
 *    文件标记不依赖进程环境，为第一可靠通道。
 *
 * 安全边界：该模式仅在网关绑定 127.0.0.1（无外网暴露）时由壳启用；
 * 桌面/服务器部署两者都不会出现，认证行为完全不变。
 */
export function isAuthDisabled(): boolean {
  if (process.env.GW_AUTH_DISABLED === '1') return true
  try {
    return fs.existsSync(path.join(process.cwd(), '.auth-disabled'))
  } catch {
    return false
  }
}

/**
 * 数据目录根（管理员凭据 / setup-token / SQLite 均在其下 db/ 子目录）。
 * GW_DATA_DIR 设置时整体外移——APK 壳把网关目录放在应用私有 assets 释放区，
 * 升级会整体重建该目录；数据必须放外面才能跨版本保留。
 */
export const DATA_ROOT = process.env.GW_DATA_DIR
  ? path.resolve(process.env.GW_DATA_DIR)
  : process.cwd()

export const DB_DIR = path.join(DATA_ROOT, 'db')
