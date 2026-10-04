#!/usr/bin/env node
/**
 * API Hub 环境自检脚本（doctor）
 * 用法：node doctor.mjs [--json]
 * 逐项检查本地部署前置条件，输出 PASS/FAIL/WARN 与修复建议。
 * 退出码：0 = 全部就绪；1 = 有 FAIL 项
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const AS_JSON = process.argv.includes('--json')
let pass = 0, fail = 0, warn = 0
const results = []

/** level: pass | fail | warn */
function check(name, level, hint = '') {
  results.push({ name, level, hint })
  if (level === 'pass') pass++
  else if (level === 'warn') warn++
  else fail++
}

function cmd(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', shell: true })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

// ---------- 运行环境 ----------
const osInfo = `${process.platform} ${process.arch}`
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

// 1. Node.js
const node = cmd('node', ['-v'])
check('Node.js 已安装', node.ok ? 'pass' : 'fail', '从 https://nodejs.org 安装 LTS 版（需 20+）')
if (node.ok) {
  const major = parseInt(node.out.trim().replace('v', ''), 10)
  // 项目用 AbortSignal.any（Node 20+）、Node 22 LTS 最佳
  check(`Node.js 版本 >= 20（当前 ${node.out.trim()}）`, major >= 20 ? 'pass' : 'fail', '升级到 Node 20+（推荐 22 LTS）')
}

// 2. bun（可选但推荐）
const bun = cmd('bun', ['-v'])
check('bun 已安装（推荐，可选）', bun.ok ? 'pass' : 'warn', 'npm install -g bun；或全程用 npm 等价命令')

// 3. npm 可用
const npm = cmd('npm', ['-v'])
check('npm 可用（bun 缺失时的备选）', npm.ok ? 'pass' : 'fail', '随 Node.js 安装')

// 4. 依赖安装状态
check('node_modules 存在（已跑过 install）', existsSync('node_modules') ? 'pass' : 'fail', '运行 bun install 或 npm install')

// 5. Prisma Client 生成状态
let prismaOk = false
try {
  prismaOk = existsSync('node_modules/@prisma/client') && existsSync('node_modules/.prisma/client/index.js')
} catch { /* ignore */ }
check('Prisma Client 已生成', prismaOk ? 'pass' : 'fail', '运行 bun run db:generate（或 npx prisma generate）')

// 6. 数据库文件
const dbExists = existsSync('db/custom.db')
check('数据库 db/custom.db 存在', dbExists ? 'pass' : 'warn',
  '首次启动会自动建表；也可手动 bun run db:push 预先建好')

// 6.1 数据表是否已建（容器卷首次挂载时是空文件）
if (dbExists) {
  try {
    const probe = spawnSync('node', ['-e', `
      const {PrismaClient}=require('@prisma/client');
      const p=new PrismaClient({datasourceUrl:'file:'+require('path').join(process.cwd(),'db','custom.db')});
      p.$queryRawUnsafe("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name IN ('Channel','ModelRoute','ApiToken','RequestLog')")
        .then(r=>{console.log(r[0].c);return p.$disconnect()})
        .catch(()=>{console.log(0);process.exit(0)});
    `], { encoding: 'utf8' })
    const n = parseInt((probe.stdout || '').trim(), 10)
    if (n >= 4) {
      check(`数据表已就绪（检测到 ${n} 张核心表）`, 'pass')
    } else {
      check('数据表未建好', 'warn', '正常情况下启动会自动建表；若持续报错请手动执行 bun run db:push')
    }
  } catch { /* 探测失败不判 FAIL */ }
}

// 7. 数据库可写（SQLite 需要写权限 + 临时写测试）
try {
  const probe = mkdtempSync(join(tmpdir(), 'gwtest-'))
  const f = join(probe, 'w.bin')
  writeFileSync(f, 'x')
  rmSync(f)
  check('临时目录可写（SQLite 运行前提）', 'pass')
} catch {
  check('临时目录可写（SQLite 运行前提）', 'fail', '检查磁盘空间/权限')
}

// 8. db 目录权限（含明文 Key，应仅当前用户可读）
try {
  if (dbExists && !isWin) {
    const mode = statSync('db').mode & 0o777
    if ((mode & 0o077) === 0) {
      check(`db 目录权限收紧（${mode.toString(8)}）`, 'pass')
    } else {
      check(`db 目录权限过宽（${mode.toString(8)}，其他用户可读）`, 'warn',
        'db/ 含明文 API Key，建议 chmod 700 db')
    }
  } else if (dbExists && isWin) {
    check('db 目录存在（Windows 用 icacls 控制 ACL）', 'warn', '建议限制为当前用户可访问')
  }
} catch { /* ignore */ }

// 9. 端口占用检测
const PORT = process.env.PORT || '3000'
let portFree = true
try {
  const s = spawnSync('node', ['-e', `const n=require('net').createServer();n.once('error',()=>process.exit(1));n.listen(${PORT},()=>{n.close();process.exit(0)})`], { encoding: 'utf8' })
  portFree = s.status === 0
} catch { /* ignore */ }
check(`端口 ${PORT} 空闲（被占用可改 PORT）`, portFree ? 'pass' : 'warn', `$env:PORT=3001 后启动（PowerShell: $env:PORT=3001）`)

// 10. schema 与包一致
check('prisma/schema.prisma 存在', existsSync('prisma/schema.prisma') ? 'pass' : 'fail', '包应完整解压')

// 11. 关键目录
for (const d of ['src/app', 'src/lib/adapters']) {
  check(`目录 ${d} 存在`, existsSync(d) ? 'pass' : 'fail', '包应完整解压')
}

// 12. 关键源文件（安装脚本/部署文件）
for (const f of ['src/lib/gateway.ts', 'src/lib/redact.ts', 'src/lib/rate-limit.ts', 'src/instrumentation.ts']) {
  if (!existsSync(f)) check(`源文件 ${f} 存在`, 'fail', '包不完整，请重新拉取源码')
}

// 13. 部署文件（缺失只提示：Docker 部署不需要 systemd）
const hasSh = existsSync('install-api-hub.sh')
const hasPs1 = existsSync('install-api-hub.ps1')
const hasCompose = existsSync('docker-compose.yml') && existsSync('Dockerfile')
check('部署文件完整（安装脚本 + Docker）',
  (hasSh && hasPs1 && hasCompose) ? 'pass' : 'warn',
  '缺失不影响运行，但会影响一键安装体验')

// 14. 安全配置提示
let warns = []
try {
  if (hasCompose && readFileSync('docker-compose.yml', 'utf8').includes('api-hub-data')) warns.push('Docker 数据卷命名正确')
} catch { /* ignore */ }

// 15. 是否以 root 运行（生产环境不推荐，Linux）
if (!isWin && !isMac && typeof process.getuid === 'function' && process.getuid() === 0) {
  check('当前以 root 运行', 'warn', '生产环境建议用非 root 用户运行服务，降低攻击影响面')
}

// ---------- 输出 ----------
if (AS_JSON) {
  console.log(JSON.stringify({ os: osInfo, pass, warn, fail, results }, null, 2))
  process.exit(fail === 0 ? 0 : 1)
}

console.log('\n===== API Hub 环境自检 =====')
console.log(`环境：${osInfo}${isMac ? '（macOS 可开发调试，部署建议 Linux）' : ''}`)
for (const r of results) {
  const tag = r.level === 'pass' ? '  PASS ' : r.level === 'warn' ? '  WARN ' : '>> FAIL '
  console.log(`${tag} ${r.name}${r.level === 'pass' ? '' : '\n         └ ' + r.hint}`)
}
console.log(`\n结果: ${pass} 通过 / ${warn} 提示 / ${fail} 未通过`)
if (fail === 0) {
  console.log('就绪 → 可启动：bun run dev（开发）或 bun run build && bun run start（生产）')
  if (warn > 0) console.log(`有 ${warn} 项提示值得看一眼（多数不影响运行）`)
} else {
  console.log('请先修复 FAIL 项（见各提示），再重新运行本脚本')
}
process.exit(fail === 0 ? 0 : 1)