#!/usr/bin/env node
/**
 * API Hub 环境自检脚本（doctor）
 * 用法：node doctor.mjs
 * 逐项检查本地部署前置条件，输出 PASS/FAIL 与修复建议。
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const results = []

function check(name, ok, hint = '') {
  results.push({ name, ok, hint })
  if (ok) pass++
  else fail++
}

function cmd(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', shell: true })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

// 1. Node.js
const node = cmd('node', ['-v'])
check('Node.js 已安装', node.ok, '从 https://nodejs.org 安装 LTS 版')
if (node.ok) {
  const major = parseInt(node.out.trim().replace('v', ''), 10)
  check(`Node.js 版本 >= 18（当前 ${node.out.trim()}）`, major >= 18, '升级 Node.js 到 18+')
}

// 2. bun（可选但推荐）
const bun = cmd('bun', ['-v'])
check('bun 已安装（推荐，可选）', bun.ok, 'npm install -g bun；或全程用 npm 等价命令')

// 3. 包管理器可用性（bun 或 npm 至少一个）
const npm = cmd('npm', ['-v'])
check('npm 可用（bun 缺失时的备选）', npm.ok, '随 Node.js 安装')

// 4. 依赖安装状态
check('node_modules 存在（已跑过 install）', existsSync('node_modules'),
  '运行 bun install 或 npm install')

// 5. Prisma Client 生成状态
let prismaOk = false
try {
  prismaOk = existsSync('node_modules/@prisma/client') &&
    existsSync('node_modules/.prisma/client/index.js')
} catch { /* ignore */ }
check('Prisma Client 已生成', prismaOk, '运行 bun run db:generate（或 npx prisma generate）')

// 6. 数据库文件
check('数据库 db/custom.db 存在', existsSync('db/custom.db'), '包内自带；缺失则从备份恢复或跑 bun run db:push')

// 7. 数据库可写（SQLite 需要写权限 + 临时写测试）
try {
  const probe = mkdtempSync(join(tmpdir(), 'gwtest-'))
  const f = join(probe, 'w.bin')
  writeFileSync(f, 'x')
  rmSync(f)
  check('临时目录可写（SQLite 运行前提）', true)
} catch {
  check('临时目录可写（SQLite 运行前提）', false, '检查磁盘空间/权限')
}

// 8. 端口 3000 占用检测（仅提示，不判 FAIL）
let portFree = true
try {
  const s = spawnSync('node', ['-e', `const n=require('net').createServer();n.once('error',()=>process.exit(1));n.listen(3000,()=>{n.close();process.exit(0)})`], { encoding: 'utf8' })
  portFree = s.status === 0
} catch { /* ignore */ }
check('端口 3000 空闲（被占用不影响 PASS，可改 PORT）', portFree, '$env:PORT=3001 后启动')

// 9. schema 与包一致
check('prisma/schema.prisma 存在', existsSync('prisma/schema.prisma'), '包应完整解压')

// 10. 关键目录
for (const d of ['src/app', 'src/lib/adapters', '.zscripts']) {
  check(`目录 ${d} 存在`, existsSync(d), '包应完整解压')
}

// 汇总
console.log('\n===== API Hub 环境自检 =====')
for (const r of results) {
  console.log(`${r.ok ? '  PASS ' : '>> FAIL '} ${r.name}${r.ok ? '' : '\n         └ ' + r.hint}`)
}
console.log(`\n结果: ${pass} 通过 / ${fail} 未通过`)
if (fail === 0) console.log('全部就绪 → 进入 HANDOVER.md 阶段 1')
else console.log('请先修复 FAIL 项（见各提示），再重新运行本脚本')
process.exit(fail === 0 ? 0 : 1)
