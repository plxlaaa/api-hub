#!/usr/bin/env node
/**
 * API Hub CLI —— 网关命令行管理工具（零依赖，Node 18+）
 *
 * 配置（环境变量）：
 *   GW_URL    网关地址，默认 http://localhost:3000
 *   GW_TOKEN  管理台 JWT（登录后获得；用 `gw login <密码>` 自动获取）
 *   GW_KEY    统一调用密钥（`gw chat` 走真实链路时用；缺省走管理测试端点）
 *
 * 用法：node server/cli.mjs <命令> [参数]
 *   gw login <密码>              登录并打印 GW_TOKEN（也可 --save 写入 ~/.api-hub-cli.json）
 *   gw status                    总览：渠道/调用/密钥速览
 *   gw channel list [-v]         渠道列表（-v 显示模型与最近错误）
 *   gw channel add <名> <URL> <Key> [--format openai|anthropic] [--models m1,m2] [--remark 备注]
 *   gw channel probe [名称|ID]   探测（无参=全部）
 *   gw channel enable|disable|delete <名称|ID>
 *   gw route list                路由列表
 *   gw route add <显示名> <目标模型> <渠道名[,渠道名...]> [--strategy priority|weighted|speed|quality|stability]
 *   gw route enable|disable|delete <显示名|ID>
 *   gw token list                密钥列表（含配额用量）
 *   gw token create <名> [--quota 次数]
 *   gw token enable|disable|delete <名称|ID>
 *   gw stats                     调用统计
 *   gw logs [条数] [--token 密钥名]   最近调用日志（默认 20 条）
 *   gw chat <模型> <消息...>     测试对话（有 GW_KEY 走统一入口，否则走管理测试）
 *   gw export [文件]             导出配置（缺省打印到 stdout）
 *   gw import <文件> [--mode merge|replace]  导入配置
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CFG_FILE = path.join(os.homedir(), '.api-hub-cli.json')
const argv = process.argv.slice(2)

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch { return {} }
}
function saveCfg(patch) {
  fs.writeFileSync(CFG_FILE, JSON.stringify({ ...loadCfg(), ...patch }, null, 2))
}
const cfg = loadCfg()
const GW_URL = (process.env.GW_URL || cfg.url || 'http://localhost:3000').replace(/\/+$/, '')
let GW_TOKEN = process.env.GW_TOKEN || cfg.token || ''
const GW_KEY = process.env.GW_KEY || cfg.lastKey || ''

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

async function api(p, options = {}) {
  const headers = new Headers(options.headers || {})
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (GW_TOKEN) headers.set('Authorization', `Bearer ${GW_TOKEN}`)
  const res = await fetch(`${GW_URL}${p}`, { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : (data?.error?.message || data?.error || `请求失败 ${res.status}`)
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return data
}

function pad(s, n) {
  s = String(s ?? '')
  let width = 0
  for (const ch of s) width += ch.charCodeAt(0) > 0xff ? 2 : 1
  return width >= n ? s : s + ' '.repeat(n - width)
}

function parseFlags(args) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (key === 'v' || key === 'save') flags[key] = true
      else { flags[key] = args[i + 1]; i++ }
    } else flags._pos = [...(flags._pos || []), a]
  }
  return flags
}

const hasFlag = (args, name) => args.includes(name)

async function resolveChannel(idOrName) {
  const list = await api('/api/channels')
  const hit = list.find((c) => c.id === idOrName || c.name === idOrName)
  if (!hit) throw new Error(`渠道不存在：${idOrName}（用 gw channel list 查看）`)
  return hit
}

async function resolveRoute(idOrName) {
  const list = await api('/api/routes')
  const hit = list.find((r) => r.id === idOrName || r.displayName === idOrName)
  if (!hit) throw new Error(`路由不存在：${idOrName}（用 gw route list 查看）`)
  return hit
}

async function resolveToken(idOrName) {
  const list = await api('/api/tokens')
  const hit = list.find((t) => t.id === idOrName || t.name === idOrName)
  if (!hit) throw new Error(`密钥不存在：${idOrName}（用 gw token list 查看）`)
  return hit
}

// ---------- 命令实现 ----------

const cmds = {}

cmds.help = () => {
  console.log(C.bold('API Hub CLI —— 用法'))
  console.log(C.dim('配置：GW_URL（默认 ' + GW_URL + '）、GW_TOKEN（管理 JWT）、GW_KEY（统一调用密钥）\n'))
  const rows = [
    ['gw login <密码> [--save]', '登录获取 GW_TOKEN（--save 写入 ~/.api-hub-cli.json）'],
    ['gw status', '总览：渠道状态 / 今日调用 / 密钥配额'],
    ['gw channel list [-v]', '渠道列表'],
    ['gw channel add <名> <URL> <Key>', '添加渠道 [--format openai|anthropic] [--models m1,m2] [--remark]'],
    ['gw channel probe [名]', '探测渠道（无参=全部）'],
    ['gw channel enable|disable|delete <名>', '启停/删除渠道'],
    ['gw route list', '路由列表'],
    ['gw route add <显示名> <目标模型> <渠道,...>', '添加路由 [--strategy priority|weighted|speed|quality|stability]'],
    ['gw route enable|disable|delete <名>', '启停/删除路由'],
    ['gw token list', '密钥列表（含配额）'],
    ['gw token create <名> [--quota n]', '创建密钥'],
    ['gw token enable|disable|delete <名>', '启停/删除密钥'],
    ['gw stats', '调用统计'],
    ['gw logs [条数] [--token 名]', '最近调用日志'],
    ['gw chat <模型> <消息...>', '测试对话（有 GW_KEY 走统一入口）'],
    ['gw export [文件]', '导出配置'],
    ['gw import <文件> [--mode merge|replace]', '导入配置'],
  ]
  for (const [cmd, desc] of rows) console.log(`  ${C.cyan(pad(cmd, 42))}${desc}`)
}

cmds.login = async (args) => {
  const flags = parseFlags(args)
  const password = (flags._pos || [])[0]
  if (!password) throw new Error('用法：gw login <密码> [--save]')
  const res = await fetch(`${GW_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `登录失败 ${res.status}`)
  if (flags.save) {
    saveCfg({ ...cfg, url: GW_URL, token: data.token })
    console.log(C.green('✔ 登录成功，GW_TOKEN 已保存到 ' + CFG_FILE))
    console.log(C.dim('以后可直接使用 gw 命令；如需覆盖用环境变量 GW_TOKEN'))
  } else {
    console.log(C.green('✔ 登录成功，请设置环境变量：'))
    console.log(`  export GW_URL="${GW_URL}"`)
    console.log(`  export GW_TOKEN="${data.token}"`)
  }
}

cmds.status = async () => {
  const o = await api('/api/overview')
  console.log(C.bold('── 网关总览 ──'))
  console.log(`渠道：${C.green(o.stats.channelsOnline + ' 在线')} / ${C.red(o.stats.channelsDown + ' 异常')} / 共 ${o.channels.length} 个`)
  console.log(`调用：今日 ${o.stats.today.calls} 次（失败 ${C.red(String(o.stats.today.fails))}），累计 ${o.stats.totalCalls} 次`)
  console.log(`路由：${o.routes.filter((r) => r.enabled).length}/${o.routes.length} 启用；密钥：${o.tokens.filter((t) => t.enabled).length}/${o.tokens.length} 启用\n`)
  console.log(C.bold('渠道明细'))
  for (const c of o.channels) {
    const st = !c.enabled ? C.dim('停用') : c.autoDisabled ? C.red('熔断中') : c.status === 'online' ? C.green('在线 ' + (c.latencyMs ?? '?') + 'ms') : C.amber('离线')
    console.log(`  ${pad(c.name, 18)} ${st}  ${C.dim((c.apiFormat === 'anthropic' ? '[Claude] ' : '') + (c.lastError ? '最近错误: ' + c.lastError.slice(0, 50) : ''))}`)
  }
  if (o.tokens.length > 0) {
    console.log('\n' + C.bold('密钥配额'))
    for (const t of o.tokens) {
      const q = t.quotaLimit !== null ? `${t.quotaUsed}/${t.quotaLimit}` : `已用 ${t.quotaUsed}`
      console.log(`  ${pad(t.name, 18)} ${t.enabled ? '' : C.dim('[停用] ')}${q}`)
    }
  }
}

cmds.channel = async (args) => {
  const sub = args[0]
  if (!sub || sub === 'list') {
    const list = await api('/api/channels')
    const verbose = args.includes('-v')
    console.log(pad('名称', 18) + pad('格式', 9) + pad('状态', 14) + pad('模型数', 7) + (verbose ? '最近错误' : 'Base URL'))
    for (const c of list) {
      const st = !c.enabled ? C.dim('停用') : c.autoDisabled ? C.red('熔断') : c.status === 'online' ? C.green('在线 ' + (c.latencyMs ?? '?') + 'ms') : C.amber('离线')
      const extra = verbose ? (c.lastError || '—') : c.baseUrl
      console.log(pad(c.name, 18) + pad(c.apiFormat === 'anthropic' ? 'claude' : 'openai', 9) + pad(st, 14 + 8) + pad(c.models.length, 7) + C.dim(String(extra)))
    }
    return
  }
  const flags = parseFlags(args.slice(1))
  const pos = flags._pos || []
  if (sub === 'add') {
    const [name, baseUrl, apiKey] = pos
    if (!name || !baseUrl || !apiKey) throw new Error('用法：gw channel add <名> <URL> <Key> [--format openai|anthropic] [--models m1,m2] [--remark 备注]')
    const created = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({
        name, baseUrl, apiKey,
        apiFormat: flags.format === 'anthropic' ? 'anthropic' : 'openai',
        models: flags.models ? String(flags.models).split(',').map((s) => s.trim()).filter(Boolean) : [],
        remark: flags.remark || null,
      }),
    })
    console.log(C.green(`✔ 渠道已添加（ID: ${created.id}），建议 gw channel probe ${name} 验证`))
  } else if (sub === 'probe') {
    const watchSec = Math.max(10, Number(flags.watch) || 0) // --watch 秒数，最小 10s
    const probeAllOnce = async () => {
      const list = await api('/api/channels')
      const enabled = list.filter((x) => x.enabled)
      for (const c of enabled) {
        process.stdout.write(pad(c.name, 18))
        const r = await api(`/api/channels/${c.id}/probe`, { method: 'POST' })
        console.log(r.ok ? C.green(`在线 ${r.latencyMs}ms`) : C.red(`失败 ${r.statusCode ?? ''} ${C.dim(String(r.error).slice(0, 60))}`))
        if (r.fixedNote) console.log(C.green('  ↳ ' + r.fixedNote))
      }
      console.log(C.dim(`共探测 ${enabled.length} 个启用渠道 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`))
    }
    if (flags.watch) {
      console.log(C.dim(`持续监控模式：每 ${watchSec}s 探测一次，Ctrl+C 退出\n`))
      await probeAllOnce()
      const timer = setInterval(() => { probeAllOnce().catch((e) => console.error(C.red('✘ ' + e.message))) }, watchSec * 1000)
      process.on('SIGINT', () => { clearInterval(timer); console.log('\n已停止监控'); process.exit(0) })
      return new Promise(() => {}) // 常驻
    }
    if (pos.length === 0) {
      await probeAllOnce()
    } else {
      const c = await resolveChannel(pos[0])
      const r = await api(`/api/channels/${c.id}/probe`, { method: 'POST' })
      console.log(r.ok ? C.green(`✔ ${c.name} 在线 ${r.latencyMs}ms`) : C.red(`✘ ${c.name} 失败：${r.error ?? 'HTTP ' + r.statusCode}`))
      if (r.fixedNote) console.log(C.green('  ↳ ' + r.fixedNote))
    }
  } else if (['enable', 'disable', 'delete'].includes(sub)) {
    const c = await resolveChannel(pos[0])
    if (sub === 'delete') {
      await api(`/api/channels/${c.id}`, { method: 'DELETE' })
      console.log(C.green(`✔ 渠道「${c.name}」已删除`))
    } else {
      await api(`/api/channels/${c.id}`, { method: 'PUT', body: JSON.stringify({ enabled: sub === 'enable' }) })
      console.log(C.green(`✔ 渠道「${c.name}」已${sub === 'enable' ? '启用' : '停用'}`))
    }
  } else throw new Error(`未知子命令：channel ${sub}（gw help 查看用法）`)
}

cmds.route = async (args) => {
  const sub = args[0]
  if (!sub || sub === 'list') {
    const list = await api('/api/routes')
    console.log(pad('显示名', 16) + pad('目标模型', 18) + pad('策略', 10) + pad('渠道', 24) + '启用')
    for (const r of list) {
      const names = (r.channelConfigs || []).map((c) => c.id.slice(0, 6)).join(',')
      console.log(pad(r.displayName, 16) + pad(r.targetModel, 18) + pad(r.strategy, 10) + pad(names, 24) + (r.enabled ? C.green('开') : C.dim('关')))
    }
    return
  }
  const flags = parseFlags(args.slice(1))
  const pos = flags._pos || []
  if (sub === 'add') {
    const [displayName, targetModel, channelNames] = pos
    if (!displayName || !targetModel || !channelNames) throw new Error('用法：gw route add <显示名> <目标模型> <渠道名,...> [--strategy priority]')
    const list = await api('/api/channels')
    const ids = []
    for (const n of String(channelNames).split(',')) {
      const t = n.trim()
      const hit = list.find((c) => c.id === t || c.name === t)
      if (!hit) throw new Error(`渠道不存在：${t}`)
      ids.push(hit.id)
    }
    await api('/api/routes', {
      method: 'POST',
      body: JSON.stringify({
        displayName, targetModel,
        channelIds: ids,
        channelConfigs: ids.map((id) => ({ id })),
        strategy: ['priority', 'weighted', 'speed', 'quality', 'stability'].includes(flags.strategy) ? flags.strategy : 'priority',
      }),
    })
    console.log(C.green(`✔ 路由「${displayName}」已添加（${ids.length} 个渠道，策略 ${flags.strategy || 'priority'}）`))
  } else if (['enable', 'disable', 'delete'].includes(sub)) {
    const r = await resolveRoute(pos[0])
    if (sub === 'delete') {
      await api(`/api/routes/${r.id}`, { method: 'DELETE' })
      console.log(C.green(`✔ 路由「${r.displayName}」已删除`))
    } else {
      await api(`/api/routes/${r.id}`, { method: 'PUT', body: JSON.stringify({ enabled: sub === 'enable' }) })
      console.log(C.green(`✔ 路由「${r.displayName}」已${sub === 'enable' ? '启用' : '停用'}`))
    }
  } else throw new Error(`未知子命令：route ${sub}`)
}

cmds.token = async (args) => {
  const sub = args[0]
  if (!sub || sub === 'list') {
    const list = await api('/api/tokens')
    console.log(pad('名称', 18) + pad('密钥', 30) + pad('配额', 14) + '启用')
    for (const t of list) {
      const q = t.quotaLimit !== null ? `${t.quotaUsed}/${t.quotaLimit}` : `不限（已用 ${t.quotaUsed}）`
      console.log(pad(t.name, 18) + pad(t.key.slice(0, 12) + '…', 30) + pad(q, 14) + (t.enabled ? C.green('开') : C.dim('关')))
    }
    return
  }
  const flags = parseFlags(args.slice(1))
  const pos = flags._pos || []
  if (sub === 'create') {
    const name = pos[0]
    if (!name) throw new Error('用法：gw token create <名> [--quota 次数] [--save]')
    const created = await api('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, quotaLimit: flags.quota ? Number(flags.quota) : null }),
    })
    console.log(C.green('✔ 密钥已创建：' + created.key))
    console.log(C.dim('调用方式：Authorization: Bearer ' + created.key))
    if (hasFlag(args, '--save')) {
      saveCfg({ lastKey: created.key })
      console.log(C.dim(`已存入 ${CFG_FILE}（gw chat 将用它走统一入口）`))
    } else {
      console.log(C.dim('提示：加 --save 保存到本地后，gw chat 自动走统一入口'))
    }
  } else if (['enable', 'disable', 'delete'].includes(sub)) {
    const t = await resolveToken(pos[0])
    if (sub === 'delete') {
      await api(`/api/tokens/${t.id}`, { method: 'DELETE' })
      console.log(C.green(`✔ 密钥「${t.name}」已删除`))
    } else {
      await api(`/api/tokens/${t.id}`, { method: 'PUT', body: JSON.stringify({ enabled: sub === 'enable' }) })
      console.log(C.green(`✔ 密钥「${t.name}」已${sub === 'enable' ? '启用' : '停用'}`))
    }
  } else throw new Error(`未知子命令：token ${sub}`)
}

cmds.stats = async () => {
  const o = await api('/api/overview')
  const rate = o.stats.today.calls > 0 ? `${Math.round(((o.stats.today.calls - o.stats.today.fails) / o.stats.today.calls) * 100)}%` : '—'
  console.log(`今日调用：${o.stats.today.calls}（失败 ${o.stats.today.fails}，成功率 ${rate}）`)
  console.log(`累计调用：${o.stats.totalCalls}`)
  console.log(`渠道：${o.stats.channelsOnline} 在线 / ${o.stats.channelsDown} 异常 / 共 ${o.channels.length}`)
}

cmds.logs = async (args) => {
  const flags = parseFlags(args)
  const n = Number(flags._pos?.[0]) || 20
  const qs = new URLSearchParams({ limit: String(Math.min(n, 500)) })
  if (flags.token) qs.set('tokenName', String(flags.token))
  if (flags.model) qs.set('model', String(flags.model))
  if (flags.channel) qs.set('channelName', String(flags.channel))
  if (flags.ok === '1' || flags.ok === '0') qs.set('ok', flags.ok)
  const logs = await api(`/api/request-logs?${qs}`)
  const conds = [
    flags.token && `密钥:${flags.token}`,
    flags.model && `模型:${flags.model}`,
    flags.channel && `渠道:${flags.channel}`,
    flags.ok && `结果:${flags.ok === '1' ? '成功' : '失败'}`,
  ].filter(Boolean).join(' ')
  console.log(pad('时间', 17) + pad('模型', 14) + pad('渠道', 14) + pad('密钥', 12) + pad('结果', 8) + C.dim('延迟 / Tokens'))
  for (const l of logs) {
    const time = new Date(l.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    const res = l.ok ? C.green('成功') : C.red(`失败${l.statusCode ? ' ' + l.statusCode : ''}`)
    console.log(
      pad(time, 17) + pad(l.model, 14) + pad(l.channelName, 14) + pad(l.tokenName || '管理测试', 12) + pad(res, 8 + 8) +
      C.dim(`${l.latencyMs ?? '?'}ms${l.totalTokens ? ' / ' + l.totalTokens + 'tok' : ''}${l.error ? ' ⚠ ' + String(l.error).slice(0, 40) : ''}`)
    )
  }
  console.log(C.dim(`共 ${logs.length} 条${conds ? '（' + conds + '）' : ''}`))
}

cmds.chat = async (args) => {
  const [model, ...rest] = args
  const msg = rest.join(' ')
  if (!model || !msg) throw new Error('用法：gw chat <模型显示名> <消息...>   （设置 GW_KEY 环境变量可走统一入口）')
  const useGateway = Boolean(GW_KEY)
  const url = useGateway ? `${GW_URL}/v1/chat/completions` : `${GW_URL}/api/test-chat`
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${useGateway ? GW_KEY : GW_TOKEN}` }
  const start = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: msg }], stream: false }),
    signal: AbortSignal.timeout(120_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const m = typeof data?.error === 'string' ? data.error : data?.error?.message || JSON.stringify(data)
    throw new Error(`调用失败：${m}`)
  }
  const channel = decodeURIComponent(res.headers.get('X-Gateway-Channel') || '')
  const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data)
  const latency = Date.now() - start
  console.log(C.dim(`模型 ${model}${channel ? '  via ' + channel : ''}  ${latency}ms${useGateway ? '  [统一入口]' : '  [管理测试]'}`))
  console.log(content)
}

cmds.export = async (args) => {
  const file = args[0]
  const data = await api('/api/config/export')
  const text = JSON.stringify(data, null, 2)
  if (file) {
    fs.writeFileSync(file, text)
    console.log(C.green(`✔ 已导出到 ${file}（${data.channels.length} 渠道 / ${data.routes.length} 路由）`))
  } else {
    console.log(text)
  }
}

cmds.import = async (args) => {
  const flags = parseFlags(args)
  const file = (flags._pos || [])[0]
  if (!file) throw new Error('用法：gw import <文件> [--mode merge|replace]')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const res = await api('/api/config/import', {
    method: 'POST',
    body: JSON.stringify({ data, mode: flags.mode === 'replace' ? 'replace' : 'merge' }),
  })
  console.log(C.green(`✔ 导入完成（模式 ${flags.mode || 'merge'}）`, res))
}

async function main() {
  const [cmd, ...args] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return cmds.help()
  if (cmd === 'login') return cmds.login(args)
  if (!['login'].includes(cmd) && !GW_TOKEN) {
    console.error(C.red('✘ 未配置 GW_TOKEN（管理 JWT）'))
    console.error(C.dim('  运行 gw login <密码> --save，或 export GW_TOKEN=<管理台JWT>'))
    process.exit(1)
  }
  const fn = cmds[cmd]
  if (!fn) {
    console.error(C.red(`✘ 未知命令：${cmd}`))
    cmds.help()
    process.exit(1)
  }
  try {
    await fn(args)
  } catch (e) {
    console.error(C.red('✘ ' + (e instanceof Error ? e.message : String(e))))
    process.exit(1)
  }
}

main()
